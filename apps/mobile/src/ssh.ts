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
  type ConnectTarget,
  type KeyTools,
  type SessionStatus,
  type SshPrompt,
  type SshPromptReply,
  type VaultService,
} from '@termterm/app'
import { fromBase64, toBase64 } from '@termterm/core'

interface NativeKey {
  privateKey: string
  /** base64 public key blob */
  publicKey: string
  keyType: string
}

type NativePrompt = { promptId: string; sessionId: string } & (
  | { kind: 'hostkey'; publicKey: string }
  | { kind: 'password'; username: string; retry: boolean }
  | { kind: 'keyboard'; name: string; instructions: string; prompts: Array<{ prompt: string; echo: boolean }> }
)

interface SshPluginApi {
  connect(options: {
    sessionId: string
    host: string
    port: number
    username: string
    password?: string
    privateKey?: string
    passphrase?: string
    cols: number
    rows: number
  }): Promise<void>
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
}

export function createSsh(vault: VaultService, events: SshEvents) {
  /** What to do with the interface's answer to a prompt it is showing. */
  const pending = new Map<string, (reply: SshPromptReply) => void>()
  /** Where each session is connecting to, for host key decisions and prompt titles. */
  const targets = new Map<string, { address: string; port: number; label: string; failure?: string }>()

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
    const target = targets.get(p.sessionId)
    if (!target) {
      void Ssh.promptReply({ promptId: p.promptId })
      return
    }
    const base = { promptId: p.promptId, sessionId: p.sessionId, host: target.label }

    if (p.kind === 'hostkey') {
      // Trust on first use; a key different from the one on record is refused
      // unless the user explicitly replaces it. Nothing is sent to the server
      // until this is answered.
      const blob = fromBase64(p.publicKey)
      const publicKey = toBase64(blob)
      const known = vault.knownHostsFor(target.address, target.port)
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
          vault.trustHostKey(entry, changed)
        } else {
          target.failure = changed
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
      let address: string
      let port: number
      let username: string
      let password: string | undefined
      let privateKey: string | undefined
      let passphrase: string | undefined

      if ('local' in target) throw new Error('A local terminal is not available on a phone')
      if ('hostId' in target) {
        const host = vault.host(target.hostId)
        if (host?.type !== 'host') throw new Error('Host not found')
        ;({ address, port, username } = host.data)
        password = host.data.password
        if (host.data.keyId) {
          const key = vault.key(host.data.keyId)
          if (key?.type === 'key') {
            privateKey = key.data.privateKey
            passphrase = key.data.passphrase
          }
        }
      } else {
        ;({ address, port, username } = target)
      }
      if (!username) {
        throw new Error('This host has no username. Add one to the host, or connect as user@host.')
      }

      targets.set(sessionId, { address, port, label: port === 22 ? address : `${address}:${port}` })
      try {
        await Ssh.connect({
          sessionId,
          host: address,
          port,
          username,
          password,
          privateKey,
          passphrase,
          cols: Math.max(1, Math.floor(cols) || 80),
          rows: Math.max(1, Math.floor(rows) || 24),
        })
      } catch (e) {
        targets.delete(sessionId)
        throw new Error(messageOf(e))
      }
    },

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
