/**
 * The contract between the sandboxed renderer and the main process.
 * Nothing here ever carries a stored password, private key or passphrase
 * back to the renderer: secrets go in, only redacted views come out.
 */

export interface HostView {
  id: string
  label: string
  address: string
  port: number
  username: string
  tags: string[]
  hasPassword: boolean
  keyId?: string
}

export interface KeyView {
  id: string
  label: string
  keyType: string
  publicKey: string
  fingerprint: string
  hasPassphrase: boolean
}

export interface SnippetView {
  id: string
  label: string
  script: string
}

export interface KnownHostView {
  id: string
  host: string
  port: number
  keyType: string
  fingerprint: string
}

export interface SyncStatus {
  configured: boolean
  serverUrl?: string
  username?: string
  lastSyncAt?: number
  state: 'idle' | 'syncing' | 'error'
  error?: string
  /** signed out by the server; needs the master password again */
  needsSignIn: boolean
  /** plain http to a non-local server */
  insecure: boolean
  pending: number
}

export interface VaultSnapshot {
  hosts: HostView[]
  keys: KeyView[]
  snippets: SnippetView[]
  knownHosts: KnownHostView[]
  sync: SyncStatus
}

export type AppPhase = 'new' | 'locked' | 'unlocked'

export interface HostInput {
  label: string
  address: string
  port: number
  username: string
  tags: string[]
  keyId: string | null
  /** undefined = leave as is, null = remove, string = set */
  password?: string | null
}

export interface KeyImportInput {
  label: string
  privateKey: string
  passphrase?: string
}

export interface AccountInput {
  serverUrl: string
  username: string
  password: string
}

export type ConnectTarget =
  | { hostId: string }
  | { address: string; port: number; username: string }

export type SessionStatus =
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'closed'; error?: string }

export type SshPrompt = { promptId: string; sessionId: string; host: string } & (
  | { kind: 'hostkey-new'; keyType: string; fingerprint: string }
  | { kind: 'hostkey-changed'; keyType: string; fingerprint: string; known: string[] }
  | { kind: 'password'; username: string; retry: boolean }
  | {
      kind: 'keyboard'
      name: string
      instructions: string
      prompts: Array<{ prompt: string; echo: boolean }>
    }
)

/** boolean for host-key prompts, string for password, string[] for keyboard; null = cancelled */
export type SshPromptReply = boolean | string | string[] | null

export interface TermtermApi {
  phase(): Promise<AppPhase>
  onPhase(cb: (phase: AppPhase) => void): () => void

  createVault(password: string): Promise<void>
  /** New device: fetch the account's vault from a sync server. */
  signIn(input: AccountInput): Promise<void>
  unlock(password: string): Promise<void>
  lock(): Promise<void>

  snapshot(): Promise<VaultSnapshot>
  onSnapshot(cb: (snapshot: VaultSnapshot) => void): () => void

  saveHost(id: string | null, input: HostInput): Promise<string>
  generateKey(label: string, type: 'ed25519' | 'rsa'): Promise<string>
  importKey(input: KeyImportInput): Promise<string>
  renameKey(id: string, label: string): Promise<void>
  saveSnippet(id: string | null, input: { label: string; script: string }): Promise<string>
  deleteItem(id: string): Promise<void>

  syncRegister(input: AccountInput): Promise<void>
  syncReauth(password: string): Promise<void>
  syncNow(): Promise<void>
  syncDisconnect(): Promise<void>

  sshConnect(sessionId: string, target: ConnectTarget, cols: number, rows: number): Promise<void>
  sshWrite(sessionId: string, data: string): void
  sshResize(sessionId: string, cols: number, rows: number): void
  sshClose(sessionId: string): void
  sshPromptReply(promptId: string, reply: SshPromptReply): void
  onSshData(cb: (sessionId: string, data: Uint8Array) => void): () => void
  onSshStatus(cb: (sessionId: string, status: SessionStatus) => void): () => void
  onSshPrompt(cb: (prompt: SshPrompt) => void): () => void

  clipboardWrite(text: string): void
  clipboardRead(): Promise<string>
}
