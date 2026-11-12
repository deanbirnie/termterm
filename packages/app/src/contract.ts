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

export interface Settings {
  /** Lock after this many minutes without input, and on sleep or screen lock. 0 = never. */
  autoLockMinutes: number
  /** Keep the vault key in the OS credential store so the app opens unlocked. */
  rememberDevice: boolean
  /** Look for a new release shortly after launch. Nothing is downloaded without asking. */
  autoCheckUpdates: boolean
  /** The local shell the Terminal button opens (a LocalShell id); unset for the system default. */
  defaultShell?: string
}

export interface AppInfo {
  version: string
  /** false when running from source */
  packaged: boolean
  platform: 'desktop' | 'mobile'
  /** What this build can do; the interface hides what is not available. */
  capabilities: {
    /** Can open SSH sessions. */
    ssh: boolean
    /** Can generate and import SSH keys. */
    keys: boolean
    /** Unlocks with a fingerprint, face or PIN check, rather than opening unlocked at launch. */
    biometricUnlock: boolean
    /** What the check is called on this device, for example "Windows Hello". */
    biometricName?: string
    /** Can open a terminal running a shell on this computer. */
    localTerminal?: boolean
  }
}

export type UpdateState =
  | { status: 'unsupported'; reason: string }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: number }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

export interface DeviceView {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number
  current: boolean
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
  /** A shell on this computer: a shell id from localShells(), or null for the default. */
  | { local: string | null }

export interface LocalShell {
  id: string
  name: string
}

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
  /** Whether the locked vault can be opened right now with a fingerprint or face. */
  biometricUnlockAvailable(): Promise<boolean>
  /** Shows the system prompt and unlocks. Rejects if it is cancelled or fails. */
  biometricUnlock(): Promise<void>
  /** Wipes the vault key from memory. Open SSH sessions keep running. */
  lock(): Promise<void>
  /** With sync on, this also signs out your other devices until they enter the new password. */
  changePassword(current: string, next: string): Promise<void>

  settings(): Promise<Settings>
  /** Changes only the fields given and returns the full, saved settings. */
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  /** Whether this device has a credential store safe enough for `rememberDevice`. */
  deviceUnlockAvailable(): Promise<boolean>

  snapshot(): Promise<VaultSnapshot>
  onSnapshot(cb: (snapshot: VaultSnapshot) => void): () => void

  saveHost(id: string | null, input: HostInput): Promise<string>
  generateKey(label: string, type: 'ed25519' | 'rsa'): Promise<string>
  importKey(input: KeyImportInput): Promise<string>
  renameKey(id: string, label: string): Promise<void>
  saveSnippet(id: string | null, input: { label: string; script: string }): Promise<string>
  deleteItem(id: string): Promise<void>

  syncRegister(input: AccountInput): Promise<void>
  /**
   * Connects the open vault to an account that already exists, for example
   * after sync was turned off. Items on this device are kept and merged in.
   */
  syncSignIn(input: AccountInput): Promise<void>
  syncReauth(password: string): Promise<void>
  syncNow(): Promise<void>
  syncDisconnect(): Promise<void>
  syncDevices(): Promise<DeviceView[]>
  /** Signs another device out of sync. Its local vault copy is not erased. */
  syncRevokeDevice(id: string): Promise<void>

  sshConnect(sessionId: string, target: ConnectTarget, cols: number, rows: number): Promise<void>
  sshWrite(sessionId: string, data: string): void
  sshResize(sessionId: string, cols: number, rows: number): void
  sshClose(sessionId: string): void
  sshPromptReply(promptId: string, reply: SshPromptReply): void
  /**
   * Tells the platform whether the terminal has keyboard focus, so a phone
   * can switch its on-screen keyboard to plain typing (no autocorrect).
   */
  terminalFocus(active: boolean): void
  onSshData(cb: (sessionId: string, data: Uint8Array) => void): () => void
  onSshStatus(cb: (sessionId: string, status: SessionStatus) => void): () => void
  onSshPrompt(cb: (prompt: SshPrompt) => void): () => void

  appInfo(): Promise<AppInfo>
  /** Shells on this computer, the one the Terminal button opens by default first. */
  localShells(): Promise<LocalShell[]>
  updateState(): Promise<UpdateState>
  onUpdateState(cb: (state: UpdateState) => void): () => void
  updateCheck(): Promise<UpdateState>
  updateDownload(): Promise<void>
  /** Closes all sessions, quits and installs the downloaded update. */
  updateInstall(): Promise<void>

  clipboardWrite(text: string): void
  clipboardRead(): Promise<string>
}
