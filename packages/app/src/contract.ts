import type { ReleaseNotes } from './release-notes.ts'
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
  /** Connected through this host first (ProxyJump). */
  jumpHostId?: string
  /** Logs in with this identity's username, password and key instead of its own. */
  identityId?: string
  group?: string
}

export interface IdentityView {
  id: string
  label: string
  username: string
  hasPassword: boolean
  keyId?: string
}

export interface IdentityInput {
  label: string
  username: string
  keyId: string | null
  /** undefined = leave as is, null = remove, string = set */
  password?: string | null
}

export interface ForwardView {
  id: string
  label: string
  hostId: string
  kind: 'local' | 'remote' | 'dynamic'
  bindHost: string
  bindPort: number
  destHost?: string
  destPort?: number
}

export type ForwardInput = Omit<ForwardView, 'id'>

/** A running (or failed) port forward on this device. */
export interface ForwardState {
  state: 'starting' | 'active' | 'error' | 'stopped'
  error?: string
  /** Connections currently going through it. */
  connections?: number
}

/** A file or folder in the SFTP browser, on this computer or on a server. */
export interface FileEntry {
  name: string
  /** The full path, in the form its side uses (Windows paths on Windows, / on servers). */
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  /** ms since 1970 */
  modified: number
}

export interface FolderListing {
  path: string
  /** null at the top (/, or a drive on Windows). */
  parent: string | null
  entries: FileEntry[]
}

export interface TransferState {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  /** What is being copied, for display. */
  name: string
  done: number
  total: number
  state: 'running' | 'done' | 'error'
  error?: string
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
  /**
   * The server sent older copies than this device had already seen (a
   * rollback): restored from an old backup, or tampered with. This device kept
   * its own copies and sent them back. Shown until dismissed.
   */
  rollback?: { at: number; items: number; serverBehind: boolean }
}

export interface VaultSnapshot {
  hosts: HostView[]
  keys: KeyView[]
  identities: IdentityView[]
  snippets: SnippetView[]
  knownHosts: KnownHostView[]
  forwards: ForwardView[]
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
    /** Can read ~/.ssh on this device to import hosts. */
    sshFiles?: boolean
    /** Can run port forwards (desktop). */
    forwards?: boolean
    /** Has the SFTP file browser (desktop). */
    sftp?: boolean
  }
}

export type UpdateState =
  | { status: 'unsupported'; reason: string }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: number }
  /**
   * `notes`: what changed since the installed version, newest first.
   * `downloadUrl`: the update cannot be downloaded in the app; open this link.
   */
  | { status: 'available'; version: string; notes?: ReleaseNotes[]; downloadUrl?: string }
  | { status: 'downloading'; version: string; percent: number }
  /** Downloaded. `install`: it is handed to the system installer instead of restarting (Android). */
  | { status: 'ready'; version: string; install?: boolean }
  | { status: 'error'; message: string }

export interface DeviceView {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number
  current: boolean
}

export type AppPhase = 'new' | 'locked' | 'unlocked'

/** Files from OpenSSH to import: text of ~/.ssh/config and known_hosts, and private keys. */
export interface SshImportFiles {
  /** Where they came from, to show ("~/.ssh on this computer", "pasted text"). */
  source: string
  config?: string
  knownHosts?: string
  /** Private keys by the IdentityFile path as written in the config. */
  keys?: Record<string, string>
  /** For hosts that name no IdentityFile: the default key ssh would use, if found. */
  defaultKey?: string
}

export interface SshImportPreview {
  source: string
  hosts: {
    alias: string
    address: string
    port: number
    username: string
    /** The key file it will use, if any. */
    key?: string
    /** Already in the vault (same address, port and user): not imported again. */
    exists: boolean
  }[]
  knownHosts: { add: number; already: number; conflicting: number; skipped: number }
  /** Things that are not imported, to say so rather than drop them silently. */
  notes: string[]
}

export interface SshImportResult {
  hosts: number
  knownHosts: number
  keys: number
  /** Key files that are protected by a passphrase: add them under Keychain. */
  keysNeedingPassphrase: string[]
}

export interface HostInput {
  label: string
  address: string
  port: number
  username: string
  tags: string[]
  keyId: string | null
  /** undefined = leave as is, null = remove, string = set */
  password?: string | null
  /** undefined = leave as is, null = connect directly, string = the host to go through */
  jumpHostId?: string | null
  /** undefined = leave as is, null = its own login, string = the identity to log in with */
  identityId?: string | null
  /** undefined = leave as is; empty = no group */
  group?: string
}

/** What importing an export file did. */
export interface ImportResult {
  added: number
  /** Already in this vault, so not added again. */
  existing: number
  /** Incomplete or unknown entries that were left out. */
  skipped: number
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
  saveIdentity(id: string | null, input: IdentityInput): Promise<string>
  /** Renames a group of hosts, or (with an empty name) ungroups them. */
  renameGroup(from: string, to: string): Promise<void>
  saveForward(id: string | null, input: ForwardInput): Promise<string>
  /** Runs a saved port forward on this device until stopped, the app quits or the vault locks. */
  forwardStart(id: string): Promise<void>
  forwardStop(id: string): Promise<void>
  forwardStates(): Promise<Record<string, ForwardState>>
  onForwardState(cb: (id: string, state: ForwardState) => void): () => void

  /** Opens an SFTP connection for a Files tab. Prompts arrive like a terminal's, with this session id. */
  sftpOpen(sessionId: string, target: ConnectTarget): Promise<{ home: string }>
  sftpList(sessionId: string, path: string): Promise<FolderListing>
  sftpMkdir(sessionId: string, path: string): Promise<void>
  sftpRename(sessionId: string, from: string, to: string): Promise<void>
  /** Removes a file, or a folder with everything in it. */
  sftpDelete(sessionId: string, path: string): Promise<void>
  sftpClose(sessionId: string): void
  /** The same operations on this computer's files. */
  localList(path: string | null): Promise<FolderListing>
  localMkdir(path: string): Promise<void>
  localRename(from: string, to: string): Promise<void>
  localDelete(path: string): Promise<void>
  /** Copies files and folders (with their contents) into a folder on the other side. */
  transfer(sessionId: string, direction: 'upload' | 'download', paths: string[], toFolder: string): Promise<void>
  onTransfer(cb: (t: TransferState) => void): () => void
  /** The path of a file dropped onto the window from the system's file manager. */
  pathForFile(file: File): string

  /**
   * Reads OpenSSH's files for import: this computer's ~/.ssh when nothing is
   * given (desktop only), or pasted text. Remembers the result for sshImportApply.
   */
  sshImportScan(paste?: { config?: string; knownHosts?: string }): Promise<SshImportPreview>
  /** Imports the chosen hosts (by alias) from the last scan, and optionally its known host keys. */
  sshImportApply(aliases: string[], knownHosts: boolean): Promise<SshImportResult>
  /** Commands typed in sessions to one host or shell, oldest first, for suggestions. Kept in the vault. */
  commandHistory(key: string): Promise<string[]>
  recordCommands(key: string, commands: string[]): Promise<void>
  clearCommandHistory(): Promise<void>
  deleteItem(id: string): Promise<void>

  /**
   * Saves an encrypted copy of the vault (everything but command history) to
   * a file the user picks. Resolves false if they cancel the file picker.
   */
  vaultExport(password: string): Promise<boolean>
  /** Lets the user pick an export file. Its text, or null if they cancel. */
  pickExportFile(): Promise<{ name: string; text: string } | null>
  /** Adds the items in an export file to this vault. */
  vaultImport(text: string, password: string): Promise<ImportResult>

  syncRegister(input: AccountInput): Promise<void>
  /**
   * Connects the open vault to an account that already exists, for example
   * after sync was turned off. Items on this device are kept and merged in.
   */
  syncSignIn(input: AccountInput): Promise<void>
  syncReauth(password: string): Promise<void>
  syncNow(): Promise<void>
  /** Hides the rollback warning (`SyncStatus.rollback`). */
  syncDismissRollback(): Promise<void>
  syncDisconnect(): Promise<void>
  /**
   * Deletes the account and everything stored for it on the sync server, after
   * checking the master password. This device keeps its vault, unsynced.
   */
  syncDeleteAccount(password: string): Promise<void>
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
