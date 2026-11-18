/**
 * The SFTP file browser's backend: an SFTP connection per Files tab (through
 * jump hosts, with the usual host key checks and prompts), this computer's
 * own files, and copying between the two with progress.
 *
 * Copies never overwrite: if something with the same name is already at the
 * destination, the copy stops and says so, rather than replacing it.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Client, FileEntry as SftpDirEntry, SFTPWrapper, Stats } from 'ssh2'
import type { ConnectTarget, FileEntry, FolderListing, TextFile, TransferState, VaultService } from '@termterm/app'
import { openConnection, planConnection, type Prompts } from './ssh-connect'

interface FileSession {
  clients: Client[]
  sftp?: SFTPWrapper
  prompts: Set<string>
  closed: boolean
}

const S_IFMT = 0o170000
const typeOfMode = (mode: number): FileEntry['type'] =>
  (mode & S_IFMT) === 0o040000 ? 'dir' : (mode & S_IFMT) === 0o120000 ? 'link' : (mode & S_IFMT) === 0o100000 ? 'file' : 'other'

const MAX_EDIT_BYTES = 1024 * 1024
const CHANGED_ON_SERVER = 'The file changed on the server since you opened it.'

/** UTF-8 text, or an error saying why the bytes cannot be edited as text. */
function decodeText(bytes: Buffer): string {
  if (bytes.subarray(0, 8192).includes(0)) throw new Error('This looks like a binary file, which cannot be edited here.')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('This file is not UTF-8 text, so it cannot be edited here without changing it.')
  }
}

const byName = (a: FileEntry, b: FileEntry) =>
  (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true })

/** ssh2's callback API as promises, for one SFTP channel. */
function remote(sftp: SFTPWrapper) {
  const call = <T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void) =>
    new Promise<T>((res, rej) => fn((err, value) => (err ? rej(err) : res(value as T))))
  return {
    realpath: (p: string) => call<string>((cb) => sftp.realpath(p, cb)),
    readdir: (p: string) => call<SftpDirEntry[]>((cb) => sftp.readdir(p, cb)),
    stat: (p: string) => call<Stats>((cb) => sftp.stat(p, cb)),
    lstat: (p: string) => call<Stats>((cb) => sftp.lstat(p, cb)),
    mkdir: (p: string) => call<void>((cb) => sftp.mkdir(p, cb)),
    rename: (a: string, b: string) => call<void>((cb) => sftp.rename(a, b, cb)),
    unlink: (p: string) => call<void>((cb) => sftp.unlink(p, cb)),
    rmdir: (p: string) => call<void>((cb) => sftp.rmdir(p, cb)),
    chmod: (p: string, mode: number) => call<void>((cb) => sftp.chmod(p, mode, cb)),
    writeFile: (p: string, data: Buffer) => call<void>((cb) => sftp.writeFile(p, data, cb)),
    exists: (p: string) =>
      new Promise<boolean>((res) => sftp.lstat(p, (err) => res(!err))),
  }
}

export class FileSessions {
  private sessions = new Map<string, FileSession>()

  constructor(
    private readonly vault: VaultService,
    private readonly prompts: Prompts,
    private readonly onTransfer: (t: TransferState) => void,
  ) {}

  // ---- connections ----

  async open(sessionId: string, target: ConnectTarget): Promise<{ home: string }> {
    this.close(sessionId)
    const hops = planConnection(this.vault, target)
    const session: FileSession = { clients: [], prompts: new Set(), closed: false }
    this.sessions.set(sessionId, session)
    try {
      const client = await openConnection(
        this.vault,
        hops,
        (host, body) => (session.closed ? Promise.resolve(null) : this.prompts.ask(sessionId, host, body, session.prompts)),
        (c) => session.clients.push(c),
      )
      session.sftp = await new Promise<SFTPWrapper>((res, rej) => client.sftp((err, sftp) => (err ? rej(err) : res(sftp))))
      client.on('close', () => this.close(sessionId))
      return { home: await remote(session.sftp).realpath('.') }
    } catch (e) {
      this.close(sessionId)
      throw e
    }
  }

  private sftp(sessionId: string) {
    const sftp = this.sessions.get(sessionId)?.sftp
    if (!sftp) throw new Error('Not connected')
    return remote(sftp)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.closed = true
    this.prompts.cancel(session.prompts)
    for (const client of session.clients) client.end()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  // ---- the server's files ----

  async list(sessionId: string, path: string): Promise<FolderListing> {
    const r = this.sftp(sessionId)
    const at = await r.realpath(path)
    const entries = await Promise.all(
      (await r.readdir(at)).map(async (e): Promise<FileEntry> => {
        const full = posix.join(at, e.filename)
        let type = typeOfMode(e.attrs.mode)
        // A link to a folder opens like a folder.
        if (type === 'link') type = await r.stat(full).then((s) => (s.isDirectory() ? 'dir' : 'file'), () => 'link' as const)
        return { name: e.filename, path: full, type, size: e.attrs.size, modified: e.attrs.mtime * 1000, mode: e.attrs.mode & 0o7777 }
      }),
    )
    return { path: at, parent: at === '/' ? null : posix.dirname(at), entries: entries.sort(byName) }
  }

  mkdir = (sessionId: string, path: string) => this.sftp(sessionId).mkdir(path)
  rename = (sessionId: string, from: string, to: string) => this.sftp(sessionId).rename(from, to)

  async delete(sessionId: string, path: string): Promise<void> {
    const r = this.sftp(sessionId)
    const walk = async (p: string): Promise<void> => {
      if ((await r.lstat(p)).isDirectory()) {
        for (const e of await r.readdir(p)) await walk(posix.join(p, e.filename))
        await r.rmdir(p)
      } else {
        await r.unlink(p)
      }
    }
    if (path === '/' || !path) throw new Error('Refusing to delete /')
    await walk(path)
  }

  chmod = (sessionId: string, path: string, mode: number) => {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Not a valid permission')
    return this.sftp(sessionId).chmod(path, mode)
  }

  /** A server file as text, to edit. Only UTF-8 text up to 1 MB. */
  async readText(sessionId: string, path: string): Promise<TextFile> {
    const r = this.sftp(sessionId)
    const sftp = this.sessions.get(sessionId)!.sftp!
    const s = await r.stat(path)
    if (!s.isFile()) throw new Error('Only files can be edited')
    if (s.size > MAX_EDIT_BYTES) throw new Error('This file is too large to edit here (over 1 MB). Download it instead.')
    const chunks: Buffer[] = []
    await pipeline(sftp.createReadStream(path) as NodeJS.ReadableStream, async function* (source) {
      for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer))
    })
    return { text: decodeText(Buffer.concat(chunks)), modified: s.mtime * 1000, size: s.size }
  }

  /** Saves edited text over the file; with `expected`, only if it has not changed since it was read. */
  async writeText(
    sessionId: string,
    path: string,
    text: string,
    expected?: { modified: number; size: number },
  ): Promise<{ modified: number; size: number }> {
    const r = this.sftp(sessionId)
    const data = Buffer.from(text, 'utf8')
    if (data.length > MAX_EDIT_BYTES) throw new Error('The text is too large to save here (over 1 MB)')
    if (expected) {
      const now = await r.stat(path)
      if (now.mtime * 1000 !== expected.modified || now.size !== expected.size) throw new Error(CHANGED_ON_SERVER)
    }
    // Written into the existing file, so its owner and permissions stay as they were.
    await r.writeFile(path, data)
    const s = await r.stat(path)
    return { modified: s.mtime * 1000, size: s.size }
  }

  // ---- this computer's files ----

  async localList(path: string | null): Promise<FolderListing> {
    const at = resolve(path || homedir())
    const dirents = await readdir(at, { withFileTypes: true })
    const entries = await Promise.all(
      dirents.map(async (d): Promise<FileEntry | null> => {
        const full = join(at, d.name)
        try {
          const s = await stat(full) // follows links, like opening them would
          return {
            name: d.name,
            path: full,
            type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
            size: s.size,
            modified: s.mtimeMs,
          }
        } catch {
          return d.isSymbolicLink() ? { name: d.name, path: full, type: 'link', size: 0, modified: 0 } : null
        }
      }),
    )
    const parent = dirname(at)
    return { path: at, parent: parent === at ? null : parent, entries: entries.filter((e): e is FileEntry => !!e).sort(byName) }
  }

  localMkdir = (path: string) => mkdir(path)
  localRename = (from: string, to: string) => rename(from, to)
  async localDelete(path: string): Promise<void> {
    const at = resolve(path)
    if (dirname(at) === at) throw new Error('Refusing to delete a whole drive')
    await rm(at, { recursive: true })
  }

  // ---- copying ----

  /** Copies files and folders into `toFolder` on the other side, reporting progress. */
  async transfer(sessionId: string, direction: 'upload' | 'download', paths: string[], toFolder: string): Promise<void> {
    const r = this.sftp(sessionId)
    const sftp = this.sessions.get(sessionId)!.sftp!
    const up = direction === 'upload'
    const nameOf = (p: string) => (up ? basename(p) : posix.basename(p))
    const destOf = (p: string) => (up ? posix.join(toFolder, nameOf(p)) : join(toFolder, nameOf(p)))
    const state: TransferState = {
      id: randomUUID(),
      sessionId,
      direction,
      name: paths.length === 1 ? nameOf(paths[0]!) : `${paths.length} items`,
      done: 0,
      total: 0,
      state: 'running',
    }
    let last = 0
    const report = (force = false) => {
      const now = Date.now()
      if (force || now - last > 100) {
        last = now
        this.onTransfer({ ...state })
      }
    }

    // What to copy, with sizes, so progress has a total; nothing is copied over what exists.
    type Item = { from: string; to: string; dir: boolean; size: number }
    const items: Item[] = []
    const plan = async (from: string, to: string) => {
      if (up) {
        const s = await stat(from)
        items.push({ from, to, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size })
        if (s.isDirectory()) for (const name of await readdir(from)) await plan(join(from, name), posix.join(to, name))
      } else {
        const s = await r.stat(from)
        items.push({ from, to, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size })
        if (s.isDirectory()) {
          for (const e of await r.readdir(from)) await plan(posix.join(from, e.filename), join(to, e.filename))
        }
      }
    }
    try {
      for (const p of paths) {
        const to = destOf(p)
        const exists = up ? await r.exists(to) : await stat(to).then(() => true, () => false)
        if (exists) throw new Error(`"${nameOf(p)}" is already there. Rename or delete it first.`)
        await plan(p, to)
      }
      state.total = items.reduce((n, i) => n + i.size, 0)
      report(true)
      for (const item of items) {
        if (item.dir) {
          await (up ? r.mkdir(item.to) : mkdir(item.to))
          continue
        }
        const source = up ? createReadStream(item.from) : sftp.createReadStream(item.from)
        const sink = up ? sftp.createWriteStream(item.to) : createWriteStream(item.to, { flags: 'wx' })
        source.on('data', (chunk: Buffer | string) => {
          state.done += chunk.length
          report()
        })
        await pipeline(source as NodeJS.ReadableStream, sink as NodeJS.WritableStream)
      }
      state.state = 'done'
      state.done = state.total
      report(true)
    } catch (e) {
      state.state = 'error'
      state.error = (e as Error).message
      report(true)
      throw e
    }
  }
}
