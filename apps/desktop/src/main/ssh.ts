import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { Client, utils, type ClientChannel, type NextAuthHandler } from 'ssh2'
import type { ConnectTarget, SessionStatus, SshPrompt, SshPromptReply } from '@termterm/app'
import { fingerprintOf, type VaultService } from '@termterm/app'
import { keyTypeOfBlob } from './keys'

type PromptBody = SshPrompt extends infer P
  ? P extends SshPrompt
    ? Omit<P, 'promptId' | 'sessionId' | 'host'>
    : never
  : never

interface Session {
  client: Client
  /** The size the terminal last asked for, kept so one sent while connecting is not lost. */
  size: { cols: number; rows: number }
  stream?: ClientChannel
  prompts: Set<string>
  closed: boolean
}

export interface SshEvents {
  data(sessionId: string, data: Uint8Array): void
  status(sessionId: string, status: SessionStatus): void
  prompt(prompt: SshPrompt): void
}

const MAX_PASSWORD_PROMPTS = 3

function friendlyError(err: Error & { level?: string; code?: string }): string {
  if (err.level === 'client-authentication') return 'Authentication failed'
  if (err.code === 'ENOTFOUND') return 'Host not found'
  if (err.code === 'ECONNREFUSED') return 'Connection refused'
  if (err.code === 'ETIMEDOUT' || err.level === 'client-timeout') return 'Connection timed out'
  return err.message
}

export class SshManager {
  private sessions = new Map<string, Session>()
  private pending = new Map<string, (reply: SshPromptReply) => void>()

  constructor(
    private readonly vault: VaultService,
    private readonly events: SshEvents,
  ) {}

  connect(sessionId: string, target: ConnectTarget, cols: number, rows: number): void {
    this.close(sessionId)

    let address: string
    let port: number
    let username: string
    let storedPassword: string | undefined
    let privateKey: string | undefined
    let passphrase: string | undefined

    if ('hostId' in target) {
      const host = this.vault.host(target.hostId)
      if (host?.type !== 'host') throw new Error('Host not found')
      ;({ address, port, username } = host.data)
      storedPassword = host.data.password
      if (host.data.keyId) {
        const key = this.vault.key(host.data.keyId)
        if (key?.type === 'key') {
          privateKey = key.data.privateKey
          passphrase = key.data.passphrase
          const parsed = utils.parseKey(privateKey, passphrase)
          if (parsed instanceof Error) {
            throw new Error(`Cannot use key "${key.data.label}": ${parsed.message}`)
          }
        }
      }
    } else {
      ;({ address, port, username } = target)
    }
    username ||= userInfo().username
    const hostLabel = port === 22 ? address : `${address}:${port}`

    const client = new Client()
    const session: Session = { client, size: { cols, rows }, prompts: new Set(), closed: false }
    this.sessions.set(sessionId, session)

    const ask = (body: PromptBody): Promise<SshPromptReply> => {
      if (session.closed) return Promise.resolve(null)
      const promptId = randomUUID()
      session.prompts.add(promptId)
      return new Promise((resolve) => {
        this.pending.set(promptId, (reply) => {
          session.prompts.delete(promptId)
          resolve(reply)
        })
        this.events.prompt({ promptId, sessionId, host: hostLabel, ...body } as SshPrompt)
      })
    }

    let failure: string | undefined
    const finish = (error?: string) => {
      if (session.closed) return
      session.closed = true
      for (const promptId of session.prompts) this.pending.get(promptId)?.(null)
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      client.end()
      this.events.status(sessionId, { state: 'closed', error: failure ?? error })
    }

    // Trust on first use; a different key than the one on record is refused
    // unless the user explicitly replaces it.
    const verifyHostKey = async (blob: Buffer): Promise<boolean> => {
      const publicKey = blob.toString('base64')
      const known = this.vault.knownHostsFor(address, port)
      if (known.some((k) => k.data.publicKey === publicKey)) return true
      const entry = {
        host: address,
        port,
        keyType: keyTypeOfBlob(blob),
        publicKey,
        fingerprint: fingerprintOf(blob),
      }
      const changed = known.length > 0
      const reply = await ask(
        changed
          ? {
              kind: 'hostkey-changed',
              keyType: entry.keyType,
              fingerprint: entry.fingerprint,
              known: known.map((k) => `${k.data.keyType} ${k.data.fingerprint}`),
            }
          : { kind: 'hostkey-new', keyType: entry.keyType, fingerprint: entry.fingerprint },
      )
      if (reply !== true) {
        failure = changed ? 'Host key mismatch: connection refused' : 'Host key was not trusted'
        return false
      }
      this.vault.trustHostKey(entry, changed)
      return true
    }

    // Auth order: saved key, saved password, keyboard-interactive, then ask.
    const tried = { none: false, key: false, stored: false, keyboard: false, prompts: 0 }
    type Next = NextAuthHandler
    const authHandler = (methodsLeft: string[] | null, _partial: boolean | null, next: Next) => {
      const allows = (m: string) => !methodsLeft || methodsLeft.includes(m)
      if (!tried.none) {
        tried.none = true
        return next({ type: 'none', username })
      }
      if (privateKey && !tried.key && allows('publickey')) {
        tried.key = true
        return next({ type: 'publickey', username, key: privateKey, passphrase })
      }
      if (storedPassword && !tried.stored && allows('password')) {
        tried.stored = true
        return next({ type: 'password', username, password: storedPassword })
      }
      if (!tried.keyboard && methodsLeft?.includes('keyboard-interactive')) {
        tried.keyboard = true
        return next({
          type: 'keyboard-interactive',
          username,
          prompt: (name, instructions, _lang, prompts, done) => {
            if (prompts.length === 0) return done([])
            void ask({
              kind: 'keyboard',
              name,
              instructions,
              prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
            }).then((reply) => {
              if (Array.isArray(reply)) done(reply)
              else finish('Authentication cancelled')
            })
          },
        })
      }
      if (allows('password') && tried.prompts < MAX_PASSWORD_PROMPTS) {
        const retry = tried.prompts > 0 || tried.stored
        tried.prompts++
        void ask({ kind: 'password', username, retry }).then((reply) => {
          if (typeof reply === 'string') next({ type: 'password', username, password: reply })
          else finish('Authentication cancelled')
        })
        return
      }
      // ssh2 accepts false at runtime to mean "no methods left"; its types omit it.
      next(false as unknown as Parameters<NextAuthHandler>[0])
    }

    client
      .on('ready', () => {
        const opened = session.size
        client.shell({ term: 'xterm-256color', ...opened }, (err, stream) => {
          if (err) return finish(err.message)
          session.stream = stream
          // A resize that arrived while the shell was being opened.
          if (session.size !== opened) stream.setWindow(session.size.rows, session.size.cols, 0, 0)
          this.events.status(sessionId, { state: 'connected' })
          const forward = (chunk: Buffer) => this.events.data(sessionId, chunk)
          stream.on('data', forward)
          stream.stderr.on('data', forward)
          stream.on('close', () => finish())
        })
      })
      .on('error', (err) => finish(friendlyError(err)))
      .on('close', () => finish())

    this.events.status(sessionId, { state: 'connecting' })
    client.connect({
      host: address,
      port,
      username,
      readyTimeout: 120_000, // generous: includes time the user spends on prompts
      keepaliveInterval: 20_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        verifyHostKey(key).then(verify, () => verify(false))
      },
      authHandler,
    })
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.size = { cols, rows }
    session.stream?.setWindow(rows, cols, 0, 0)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.closed = true
    for (const promptId of session.prompts) this.pending.get(promptId)?.(null)
    session.client.destroy()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  promptReply(promptId: string, reply: SshPromptReply): void {
    const resolve = this.pending.get(promptId)
    this.pending.delete(promptId)
    resolve?.(reply)
  }
}
