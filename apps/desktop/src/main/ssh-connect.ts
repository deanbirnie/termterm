/**
 * Opening an SSH connection to a saved host or an address, for terminals,
 * port forwards and file browsing alike: through any jump hosts the host
 * names (each hop's host key checked and credentials offered on its own),
 * trust on first use, and questions to the user through `Prompts`.
 */
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { Client, utils, type ClientChannel, type NextAuthHandler } from 'ssh2'
import type { ConnectTarget, SshPrompt, SshPromptReply } from '@termterm/app'
import { fingerprintOf, MAX_JUMPS, type VaultService } from '@termterm/app'
import { DEFAULT_KEEPALIVE_SECONDS } from '@termterm/core'
import { keyTypeOfBlob } from './keys'

export type PromptBody = SshPrompt extends infer P
  ? P extends SshPrompt
    ? Omit<P, 'promptId' | 'sessionId' | 'host'>
    : never
  : never

/** Questions waiting for the user, whoever asked them. */
export class Prompts {
  private pending = new Map<string, (reply: SshPromptReply) => void>()

  constructor(private readonly emit: (prompt: SshPrompt) => void) {}

  /** Asks on behalf of `sessionId`; `owned` collects the ids so they can be cancelled together. */
  ask(sessionId: string, host: string, body: PromptBody, owned: Set<string>): Promise<SshPromptReply> {
    const promptId = randomUUID()
    owned.add(promptId)
    return new Promise((resolve) => {
      this.pending.set(promptId, (reply) => {
        owned.delete(promptId)
        resolve(reply)
      })
      this.emit({ promptId, sessionId, host, ...body } as SshPrompt)
    })
  }

  /** Answers every open question in `owned` with "cancel". */
  cancel(owned: Set<string>): void {
    for (const promptId of [...owned]) this.reply(promptId, null)
  }

  reply(promptId: string, reply: SshPromptReply): void {
    const resolve = this.pending.get(promptId)
    this.pending.delete(promptId)
    resolve?.(reply)
  }
}

/** A connection that was working and stopped without the shell ending. */
export const LOST = 'Connection lost'

export function friendlyError(err: Error & { level?: string; code?: string }): string {
  if (/keepalive timeout/i.test(err.message) || err.code === 'ECONNRESET' || err.code === 'EPIPE') return LOST
  if (err.level === 'client-authentication') return 'Authentication failed'
  if (err.code === 'ENOTFOUND') return 'Host not found'
  if (err.code === 'ECONNREFUSED') return 'Connection refused'
  if (err.code === 'ETIMEDOUT' || err.level === 'client-timeout') return 'Connection timed out'
  return err.message
}

const MAX_PASSWORD_PROMPTS = 3

/** One server to log in to, with what the vault holds for it. */
export interface Hop {
  address: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** For prompts: "host" or "host:port", marked when it is a jump host. */
  label: string
  /** Seconds between keep-alives; 0 = none. */
  keepAlive: number
  /** Environment variables for the shell (the target only). */
  env?: Record<string, string>
}

/**
 * The servers to connect to in order: the outermost jump host first, the
 * target last. Throws at once for anything the vault cannot supply (a
 * missing host, an unreadable key, a loop), before any connection is made.
 */
export function planConnection(vault: VaultService, target: ConnectTarget): Hop[] {
  if ('local' in target) throw new Error('Not an SSH target')
  if (!('hostId' in target)) {
    const { address, port } = target
    return [{ address, port, username: target.username || userInfo().username, label: label(address, port), keepAlive: DEFAULT_KEEPALIVE_SECONDS }]
  }
  const hops: Hop[] = []
  const seen = new Set<string>()
  let id: string | undefined = target.hostId
  while (id) {
    if (seen.has(id)) throw new Error('A host cannot be reached through itself')
    if (hops.length > MAX_JUMPS) throw new Error(`At most ${MAX_JUMPS} jump hosts in a row`)
    seen.add(id)
    const host = vault.host(id)
    if (host?.type !== 'host') throw new Error(hops.length ? 'Jump host not found' : 'Host not found')
    const { address, port, username, password, keyId } = host.data
    const hop: Hop = {
      address,
      port,
      username: username || userInfo().username,
      password,
      label: hops.length ? `${label(address, port)} (jump host)` : label(address, port),
      keepAlive: host.data.keepAlive ?? DEFAULT_KEEPALIVE_SECONDS,
      ...(hops.length === 0 && host.data.env ? { env: host.data.env } : {}),
    }
    if (keyId) {
      const key = vault.key(keyId)
      if (key?.type === 'key') {
        const parsed = utils.parseKey(key.data.privateKey, key.data.passphrase)
        if (parsed instanceof Error) throw new Error(`Cannot use key "${key.data.label}": ${parsed.message}`)
        hop.privateKey = key.data.privateKey
        hop.passphrase = key.data.passphrase
      }
    }
    hops.unshift(hop)
    id = host.data.jumpHostId
  }
  return hops
}

const label = (address: string, port: number) => (port === 22 ? address : `${address}:${port}`)

export type Ask = (host: string, body: PromptBody) => Promise<SshPromptReply>

/**
 * Connects through every hop in turn and resolves with the client for the
 * last one, logged in. `track` receives each client as it is created, so a
 * caller that gives up can destroy them all; closing a jump host's client
 * also ends everything reached through it.
 */
export async function openConnection(
  vault: VaultService,
  hops: Hop[],
  ask: Ask,
  track: (client: Client) => void,
): Promise<Client> {
  let via: Client | undefined
  for (const hop of hops) via = await connectHop(vault, hop, ask, track, via)
  return via!
}

function connectHop(vault: VaultService, hop: Hop, ask: Ask, track: (c: Client) => void, via?: Client): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    track(client)
    const { address, port, username } = hop
    let failure: string | undefined
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      client.end()
      reject(new Error(failure ?? message))
    }

    // Trust on first use; a different key than the one on record is refused
    // unless the user explicitly replaces it.
    const verifyHostKey = async (blob: Buffer): Promise<boolean> => {
      const publicKey = blob.toString('base64')
      const known = vault.knownHostsFor(address, port)
      if (known.some((k) => k.data.publicKey === publicKey)) return true
      const entry = { host: address, port, keyType: keyTypeOfBlob(blob), publicKey, fingerprint: fingerprintOf(blob) }
      const changed = known.length > 0
      const reply = await ask(
        hop.label,
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
      vault.trustHostKey(entry, changed)
      return true
    }

    // Auth order: saved key, saved password, keyboard-interactive, then ask.
    const tried = { none: false, key: false, stored: false, keyboard: false, prompts: 0 }
    const cancelled = () => {
      failure = 'Authentication cancelled'
      fail(failure)
    }
    const authHandler = (methodsLeft: string[] | null, _partial: boolean | null, next: NextAuthHandler) => {
      const allows = (m: string) => !methodsLeft || methodsLeft.includes(m)
      if (!tried.none) {
        tried.none = true
        return next({ type: 'none', username })
      }
      if (hop.privateKey && !tried.key && allows('publickey')) {
        tried.key = true
        return next({ type: 'publickey', username, key: hop.privateKey, passphrase: hop.passphrase })
      }
      if (hop.password && !tried.stored && allows('password')) {
        tried.stored = true
        return next({ type: 'password', username, password: hop.password })
      }
      if (!tried.keyboard && methodsLeft?.includes('keyboard-interactive')) {
        tried.keyboard = true
        return next({
          type: 'keyboard-interactive',
          username,
          prompt: (name, instructions, _lang, prompts, done) => {
            if (prompts.length === 0) return done([])
            void ask(hop.label, {
              kind: 'keyboard',
              name,
              instructions,
              prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
            }).then((reply) => (Array.isArray(reply) ? done(reply) : cancelled()))
          },
        })
      }
      if (allows('password') && tried.prompts < MAX_PASSWORD_PROMPTS) {
        const retry = tried.prompts > 0 || tried.stored
        tried.prompts++
        void ask(hop.label, { kind: 'password', username, retry }).then((reply) =>
          typeof reply === 'string' ? next({ type: 'password', username, password: reply }) : cancelled(),
        )
        return
      }
      // ssh2 accepts false at runtime to mean "no methods left"; its types omit it.
      next(false as unknown as Parameters<NextAuthHandler>[0])
    }

    client
      .once('ready', () => {
        settled = true
        resolve(client)
      })
      .on('error', (err) => fail(friendlyError(err)))
      .on('close', () => fail('Connection closed'))

    const start = (sock?: ClientChannel) =>
      client.connect({
        host: address,
        port,
        username,
        ...(sock ? { sock } : {}),
        readyTimeout: 120_000, // generous: includes time the user spends on prompts
        keepaliveInterval: hop.keepAlive * 1000, // 0 turns them off
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          verifyHostKey(key).then(verify, () => verify(false))
        },
        authHandler,
      })

    if (!via) return start()
    // Through the jump host: a TCP stream it opens to this hop stands in for a socket.
    via.forwardOut('127.0.0.1', 0, address, port, (err, stream) => {
      if (err) return fail(`The jump host could not reach ${hop.label}: ${err.message}`)
      start(stream)
    })
  })
}
