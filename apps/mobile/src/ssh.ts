/**
 * SSH on Android: the JavaScript half of the native `Ssh` plugin
 * (android/app/src/main/java/dev/termterm/app/SshPlugin.java).
 *
 * The native side owns the connection. This side owns every decision that
 * involves the vault: which credentials to offer, and whether a server's host
 * key is one the user has trusted. It mirrors apps/desktop/src/main/ssh.ts.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  fingerprintOf,
  keyTypeOfBlob,
  MAX_JUMPS,
  type ConnectTarget,
  type FolderListing,
  type TextFile,
  type ForwardState,
  type KeyTools,
  type SessionStatus,
  type SshPrompt,
  type SshPromptReply,
  type TransferState,
  type VaultScope,
  type VaultService,
} from '@termterm/app'
import { DEFAULT_KEEPALIVE_SECONDS, fromBase64, toBase64, type ProxyConfig } from '@termterm/core'

interface NativeKey {
  privateKey: string
  /** base64 public key blob */
  publicKey: string
  keyType: string
}

/** `hop`: 0 is the target, 1 the jump host it is reached through, and so on. */
type NativePrompt = { promptId: string; sessionId: string; hop?: number } & (
  | { kind: 'hostkey'; publicKey: string }
  | { kind: 'password'; username: string; retry: boolean }
  | { kind: 'keyboard'; name: string; instructions: string; prompts: Array<{ prompt: string; echo: boolean }> }
)

/** Where and how to connect, as SshPlugin's configFrom reads it. */
interface ConnectOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** Seconds between keep-alives; 0 = none. */
  keepAlive: number
  /** Environment variables for the shell. */
  env?: Record<string, string>
  /** The key's OpenSSH certificate, tried before the key alone. */
  certificate?: string
  /** The proxy to reach the first server through (set on whichever is reached directly). */
  proxy?: ProxyConfig
  /** Keys the server may use through agent forwarding. */
  agentKeys?: Array<{ name: string; privateKey: string; passphrase?: string; certificate?: string }>
  /** Jump hosts, nearest first. */
  jumps?: Array<{
    host: string
    port: number
    username: string
    password?: string
    privateKey?: string
    passphrase?: string
    certificate?: string
    proxy?: ProxyConfig
    keepAlive: number
  }>
}

interface SshPluginApi {
  forwardStart(
    options: ConnectOptions & {
      forwardId: string
      kind: 'local' | 'remote' | 'dynamic'
      bindHost: string
      bindPort: number
      destHost?: string
      destPort?: number
    },
  ): Promise<void>
  forwardStop(options: { forwardId: string }): Promise<void>
  sftpOpen(options: ConnectOptions & { sessionId: string }): Promise<{ home: string }>
  sftpList(options: { sessionId: string; path: string }): Promise<FolderListing>
  sftpMkdir(options: { sessionId: string; path: string }): Promise<void>
  sftpRename(options: { sessionId: string; from: string; to: string }): Promise<void>
  sftpDelete(options: { sessionId: string; path: string }): Promise<void>
  sftpClose(options: { sessionId: string }): Promise<void>
  sftpChmod(options: { sessionId: string; path: string; mode: number }): Promise<void>
  sftpReadText(options: { sessionId: string; path: string }): Promise<TextFile>
  sftpWriteText(options: {
    sessionId: string
    path: string
    text: string
    expected?: { modified: number; size: number }
  }): Promise<{ modified: number; size: number }>
  sftpDownload(options: { sessionId: string; path: string; name: string; size: number }): Promise<{ saved: boolean }>
  sftpUpload(options: { sessionId: string; folder: string }): Promise<{ count: number }>
  addListener(
    event: 'forwardState',
    cb: (e: { forwardId: string; state: 'starting' | 'active' | 'stopped' | 'error'; error?: string; connections?: number }) => void,
  ): Promise<PluginListenerHandle>
  addListener(event: 'transfer', cb: (t: TransferState) => void): Promise<PluginListenerHandle>
  connect(options: ConnectOptions & { sessionId: string; cols: number; rows: number }): Promise<void>
  write(options: { sessionId: string; data: string }): Promise<void>
  resize(options: { sessionId: string; cols: number; rows: number }): Promise<void>
  close(options: { sessionId: string }): Promise<void>
  promptReply(options: { promptId: string; accepted?: boolean; value?: string; values?: string[] }): Promise<void>
  generateKey(options: { type: 'ed25519' | 'rsa' }): Promise<NativeKey>
  inspectKey(options: { privateKey: string; passphrase?: string }): Promise<NativeKey>
  addListener(event: 'data', cb: (e: { sessionId: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(
    event: 'status',
    cb: (e: { sessionId: string; state: 'connecting' | 'connected' | 'closed'; error?: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(event: 'prompt', cb: (e: NativePrompt) => void): Promise<PluginListenerHandle>
}

const Ssh = registerPlugin<SshPluginApi>('Ssh')

/** Switches the on-screen keyboard to plain typing while the terminal has focus. */
const TerminalInput = registerPlugin<{ setActive(options: { active: boolean }): Promise<void> }>(
  'TerminalInput',
)
export const setTerminalFocus = (active: boolean) =>
  void TerminalInput.setActive({ active }).catch(() => undefined)

/** Capacitor rejects with an Error whose message is what the native side passed to reject(). */
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const nativeKeyTools: KeyTools = {
  async generate(label, type) {
    const key = await Ssh.generateKey({ type })
    return {
      label,
      privateKey: key.privateKey,
      publicKey: `${key.keyType} ${key.publicKey} ${label}`,
      keyType: key.keyType,
    }
  },
  async import(label, privateKey, passphrase) {
    let key: NativeKey
    try {
      key = await Ssh.inspectKey({ privateKey, passphrase: passphrase || undefined })
    } catch (e) {
      throw new Error(messageOf(e))
    }
    return {
      label,
      privateKey: key.privateKey,
      publicKey: `${key.keyType} ${key.publicKey} ${label}`,
      keyType: key.keyType,
      ...(passphrase ? { passphrase } : {}),
    }
  },
}

export interface SshEvents {
  data(sessionId: string, data: Uint8Array): void
  status(sessionId: string, status: SessionStatus): void
  prompt(prompt: SshPrompt): void
  forwardState(forwardId: string, state: ForwardState): void
  transfer(t: TransferState): void
}

export function createSsh(vault: VaultService, events: SshEvents) {
  /** What to do with the interface's answer to a prompt it is showing. */
  const pending = new Map<string, (reply: SshPromptReply) => void>()
  /** Where each session connects, hop by hop (0 is the target), for host key decisions and prompt titles. */
  // Each connection's hops and the vault it was opened from (its known hosts).
  const targets = new Map<string, { hops: Array<{ address: string; port: number; label: string }>; scope: VaultScope; failure?: string }>()
  const forwardStates = new Map<string, ForwardState>()

  /** Plugin calls reject with the native message; pass it on as a plain Error. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      throw new Error(messageOf(e))
    }
  }

  /**
   * How to reach a target: the server, its credentials and settings, and the
   * jump hosts before it (nearest first), as the native side takes them; and
   * each hop's address and label, for host key decisions and prompt titles.
   */
  /** `forwardAgent`: for a terminal, offer the vault's keys if the host asks for agent forwarding. */
  function plan(target: ConnectTarget, forwardAgent = false) {
    if ('local' in target) throw new Error('A local terminal is not available on a phone')
    type Hop = {
      address: string
      port: number
      username: string
      password?: string
      privateKey?: string
      passphrase?: string
      certificate?: string
      proxy?: ProxyConfig
      keepAlive: number
    }
    let agentKeys: ConnectOptions['agentKeys']
    // The vault it was opened from, whichever one is shown later.
    const scope = vault.scope('vaultId' in target ? target.vaultId : undefined)
    let env: Record<string, string> | undefined
    // The target first, then each jump host it is reached through.
    const hops: Hop[] = []
    if ('hostId' in target) {
      const seen = new Set<string>()
      let id: string | undefined = target.hostId
      while (id) {
        if (seen.has(id)) throw new Error('A host cannot be reached through itself')
        if (hops.length > MAX_JUMPS) throw new Error(`At most ${MAX_JUMPS} jump hosts in a row`)
        seen.add(id)
        const host = scope.host(id)
        if (host?.type !== 'host') throw new Error(hops.length ? 'Jump host not found' : 'Host not found')
        const hop: Hop = {
          address: host.data.address,
          port: host.data.port,
          username: host.data.username,
          password: host.data.password,
          keepAlive: host.data.keepAlive ?? DEFAULT_KEEPALIVE_SECONDS,
        }
        // Environment variables are for the target's shell only.
        if (hops.length === 0) env = host.data.env
        if (hops.length === 0 && forwardAgent && host.data.agentForward) {
          agentKeys = scope
            .keys()
            .map((k) => ({
              name: k.label,
              privateKey: k.privateKey,
              ...(k.passphrase ? { passphrase: k.passphrase } : {}),
              ...(k.certificate ? { certificate: k.certificate } : {}),
            }))
        }
        if (host.data.proxy) hop.proxy = host.data.proxy
        if (host.data.keyId) {
          const key = scope.key(host.data.keyId)
          if (key?.type === 'key') {
            hop.privateKey = key.data.privateKey
            hop.passphrase = key.data.passphrase
            if (key.data.certificate) hop.certificate = key.data.certificate
          }
        }
        if (!hop.username) {
          throw new Error(`${host.data.label} has no username. Add one to the host${hops.length ? '' : ', or connect as user@host'}.`)
        }
        hops.push(hop)
        id = host.data.jumpHostId
      }
    } else {
      if (!target.username) {
        throw new Error('This host has no username. Add one to the host, or connect as user@host.')
      }
      hops.push({ address: target.address, port: target.port, username: target.username, keepAlive: DEFAULT_KEEPALIVE_SECONDS })
    }
    const label = (h: Hop, i: number) => {
      const where = h.port === 22 ? h.address : `${h.address}:${h.port}`
      return i > 0 ? `${where} (jump host)` : where
    }
    // Only the server reached directly (the outermost) goes through its proxy.
    hops.forEach((h, i) => i < hops.length - 1 && delete h.proxy)
    const [first, ...jumps] = hops
    return {
      scope,
      labels: hops.map((h, i) => ({ address: h.address, port: h.port, label: label(h, i) })),
      options: {
        host: first!.address,
        port: first!.port,
        username: first!.username,
        password: first!.password,
        privateKey: first!.privateKey,
        passphrase: first!.passphrase,
        keepAlive: first!.keepAlive,
        ...(env ? { env } : {}),
        ...(first!.certificate ? { certificate: first!.certificate } : {}),
        ...(first!.proxy ? { proxy: first!.proxy } : {}),
        ...(agentKeys?.length ? { agentKeys } : {}),
        jumps: jumps.map((h) => ({
          host: h.address,
          port: h.port,
          username: h.username,
          keepAlive: h.keepAlive,
          ...(h.password ? { password: h.password } : {}),
          ...(h.privateKey ? { privateKey: h.privateKey, passphrase: h.passphrase } : {}),
          ...(h.certificate ? { certificate: h.certificate } : {}),
          ...(h.proxy ? { proxy: h.proxy } : {}),
        })),
      },
    }
  }

  void Ssh.addListener('forwardState', (e) => {
    const target = targets.get(e.forwardId)
    const state: ForwardState =
      e.state === 'error'
        ? { state: 'error', error: target?.failure ?? e.error ?? 'Failed' }
        : { state: e.state, ...(e.connections !== undefined ? { connections: e.connections } : {}) }
    if (e.state === 'stopped' || e.state === 'error') targets.delete(e.forwardId)
    forwardStates.set(e.forwardId, state)
    events.forwardState(e.forwardId, state)
  })

  void Ssh.addListener('transfer', (t) => events.transfer(t))

  void Ssh.addListener('data', (e) => events.data(e.sessionId, fromBase64(e.data)))

  void Ssh.addListener('status', (e) => {
    if (e.state === 'closed') {
      const target = targets.get(e.sessionId)
      targets.delete(e.sessionId)
      // Our own reason (for example a refused host key) is more specific than the library's.
      events.status(e.sessionId, { state: 'closed', error: target?.failure ?? e.error })
    } else {
      events.status(e.sessionId, { state: e.state })
    }
  })

  void Ssh.addListener('prompt', (p) => {
    const session = targets.get(p.sessionId)
    const hop = session?.hops[p.hop ?? 0]
    if (!session || !hop) {
      void Ssh.promptReply({ promptId: p.promptId })
      return
    }
    const target = hop
    const base = { promptId: p.promptId, sessionId: p.sessionId, host: hop.label }

    if (p.kind === 'hostkey') {
      // Trust on first use; a key different from the one on record is refused
      // unless the user explicitly replaces it. Nothing is sent to the server
      // until this is answered.
      const blob = fromBase64(p.publicKey)
      const publicKey = toBase64(blob)
      const known = session.scope.knownHostsFor(target.address, target.port)
      if (known.some((k) => k.data.publicKey === publicKey)) {
        void Ssh.promptReply({ promptId: p.promptId, accepted: true })
        return
      }
      const entry = {
        host: target.address,
        port: target.port,
        keyType: keyTypeOfBlob(blob),
        publicKey,
        fingerprint: fingerprintOf(blob),
      }
      const changed = known.length > 0
      pending.set(p.promptId, (reply) => {
        if (reply === true) {
          session.scope.trustHostKey(entry, changed)
        } else {
          session.failure = changed
            ? 'Host key mismatch: connection refused'
            : 'Host key was not trusted'
        }
        void Ssh.promptReply({ promptId: p.promptId, accepted: reply === true })
      })
      events.prompt(
        changed
          ? {
              ...base,
              kind: 'hostkey-changed',
              keyType: entry.keyType,
              fingerprint: entry.fingerprint,
              known: known.map((k) => `${k.data.keyType} ${k.data.fingerprint}`),
            }
          : { ...base, kind: 'hostkey-new', keyType: entry.keyType, fingerprint: entry.fingerprint },
      )
      return
    }

    if (p.kind === 'password') {
      pending.set(p.promptId, (reply) => {
        void Ssh.promptReply(
          typeof reply === 'string' ? { promptId: p.promptId, value: reply } : { promptId: p.promptId },
        )
      })
      events.prompt({ ...base, kind: 'password', username: p.username, retry: p.retry })
      return
    }

    pending.set(p.promptId, (reply) => {
      void Ssh.promptReply(
        Array.isArray(reply) ? { promptId: p.promptId, values: reply } : { promptId: p.promptId },
      )
    })
    events.prompt({
      ...base,
      kind: 'keyboard',
      name: p.name,
      instructions: p.instructions,
      prompts: p.prompts,
    })
  })

  return {
    async connect(sessionId: string, target: ConnectTarget, cols: number, rows: number): Promise<void> {
      const { options, labels, scope } = plan(target, true)
      targets.set(sessionId, { hops: labels, scope })
      try {
        await Ssh.connect({
          sessionId,
          ...options,
          cols: Math.max(1, Math.floor(cols) || 80),
          rows: Math.max(1, Math.floor(rows) || 24),
        })
      } catch (e) {
        targets.delete(sessionId)
        throw new Error(messageOf(e))
      }
    },

    // ---- port forwards ----

    async forwardStart(forwardId: string): Promise<void> {
      // Started from the vault on screen (or, at unlock, the one shown last).
      const shown = vault.scope()
      const forward = shown.forward(forwardId)
      if (!forward) throw new Error('Port forward not found')
      const { options, labels, scope } = plan({ hostId: forward.data.hostId, vaultId: shown.vaultId })
      targets.set(forwardId, { hops: labels, scope })
      forwardStates.set(forwardId, { state: 'starting' })
      events.forwardState(forwardId, { state: 'starting' })
      const { kind, bindHost, bindPort, destHost, destPort } = forward.data
      try {
        await Ssh.forwardStart({
          forwardId,
          ...options,
          kind,
          bindHost,
          bindPort,
          ...(destHost ? { destHost } : {}),
          ...(destPort ? { destPort } : {}),
        })
      } catch (e) {
        targets.delete(forwardId)
        const failed: ForwardState = { state: 'error', error: messageOf(e) }
        forwardStates.set(forwardId, failed)
        events.forwardState(forwardId, failed)
        throw new Error(messageOf(e))
      }
    },

    async forwardStop(forwardId: string): Promise<void> {
      await Ssh.forwardStop({ forwardId })
    },

    forwardStates: (): Record<string, ForwardState> => Object.fromEntries(forwardStates),

    /** Forwards running now, to stop when the vault locks. */
    runningForwards: () => [...forwardStates].filter(([, s]) => s.state === 'starting' || s.state === 'active').map(([id]) => id),

    // ---- files (SFTP) ----

    async sftpOpen(sessionId: string, target: ConnectTarget): Promise<{ home: string }> {
      const { options, labels, scope } = plan(target)
      targets.set(sessionId, { hops: labels, scope })
      try {
        return await Ssh.sftpOpen({ sessionId, ...options })
      } catch (e) {
        const reason = targets.get(sessionId)?.failure
        targets.delete(sessionId)
        throw new Error(reason ?? messageOf(e))
      }
    },
    sftpList: (sessionId: string, path: string) => call(() => Ssh.sftpList({ sessionId, path })),
    sftpMkdir: (sessionId: string, path: string) => call(() => Ssh.sftpMkdir({ sessionId, path })),
    sftpRename: (sessionId: string, from: string, to: string) => call(() => Ssh.sftpRename({ sessionId, from, to })),
    sftpDelete: (sessionId: string, path: string) => call(() => Ssh.sftpDelete({ sessionId, path })),
    sftpChmod: (sessionId: string, path: string, mode: number) => call(() => Ssh.sftpChmod({ sessionId, path, mode })),
    sftpReadText: (sessionId: string, path: string) => call(() => Ssh.sftpReadText({ sessionId, path })),
    sftpWriteText: (sessionId: string, path: string, text: string, expected?: { modified: number; size: number }) =>
      call(() => Ssh.sftpWriteText({ sessionId, path, text, ...(expected ? { expected } : {}) })),
    sftpClose(sessionId: string) {
      targets.delete(sessionId)
      void Ssh.sftpClose({ sessionId })
    },
    /** Saves a server file where the user picks. False if they cancel. */
    sftpDownload: async (sessionId: string, path: string, name: string, size: number) =>
      (await call(() => Ssh.sftpDownload({ sessionId, path, name, size }))).saved,
    /** Copies files the user picks into a server folder. How many were copied. */
    sftpUpload: async (sessionId: string, folder: string) => (await call(() => Ssh.sftpUpload({ sessionId, folder }))).count,

    write: (sessionId: string, data: string) => void Ssh.write({ sessionId, data }),

    resize(sessionId: string, cols: number, rows: number) {
      if (cols > 0 && rows > 0) {
        void Ssh.resize({ sessionId, cols: Math.floor(cols), rows: Math.floor(rows) })
      }
    },

    close(sessionId: string) {
      targets.delete(sessionId)
      void Ssh.close({ sessionId })
    },

    promptReply(promptId: string, reply: SshPromptReply) {
      const handler = pending.get(promptId)
      pending.delete(promptId)
      handler?.(reply)
    },
  }
}
