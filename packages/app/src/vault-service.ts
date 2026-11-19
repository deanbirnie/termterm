import {
  SyncApi,
  SyncError,
  Vault,
  WrongPasswordError,
  deriveKeys,
  isInsecureUrl,
  normalizeServerUrl,
  syncVault,
  type ForwardData,
  HOST_COLORS,
  type HostData,
  type IdentityData,
  type Item,
  decryptExport,
  encryptExport,
  fromBase64,
  randomId,
  toBase64,
  type KeyData,
  type KnownHostData,
  type ProxyConfig,
  type SnippetData,
  type VaultFile,
  TOMBSTONE,
  fingerprint,
  fromUtf8,
  generateAccountKeyPair,
  generateVaultKey,
  isPublicBox,
  memberTag,
  open,
  openWith,
  publicKeyOf,
  seal,
  sealTo,
  utf8,
  type AccountKeyPair,
  type MemberKeyData,
  type RemoteMember,
  type RemoteVault,
  type SealedLogin,
} from '@termterm/core'
import type {
  AccountInput,
  AppPhase,
  DeviceView,
  ForwardInput,
  HostInput,
  IdentityInput,
  ImportResult,
  KeyImportInput,
  MemberView,
  ProxyInput,
  RemoteVaultView,
  ServerView,
  SshImportFiles,
  SshImportPreview,
  SshImportResult,
  SyncStatus,
  VaultSnapshot,
} from './contract.ts'
import { fingerprintOfPublicLine } from './fingerprint.ts'
import { certificateMatchesKey, parseCertificate } from './certificate.ts'
import { parseKnownHosts, parseSshConfig, type ConfigHost, type KnownHostEntry } from './ssh-import.ts'
import type { Platform } from './platform.ts'

const SYNC_DEBOUNCE_MS = 1500
const SYNC_INTERVAL_MS = 60_000

/** What an export file carries. */
const EXPORTED_TYPES = ['host', 'key', 'identity', 'snippet', 'knownHost', 'forward'] as const

const byLabel = <T extends { label: string }>(a: T, b: T) => a.label.localeCompare(b.label)

/** null = the default (stored as unset); otherwise whole seconds, 0 (off) to an hour. */
function checkKeepAlive(value: number | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error('Keep-alive must be 0 (off) to 3600 seconds')
  return n
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

function checkEnv(env: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(env ?? {})) {
    const name = String(rawName).trim()
    if (!name) continue
    if (!ENV_NAME.test(name)) throw new Error(`"${name}" is not a valid environment variable name`)
    const value = String(rawValue ?? '')
    if (value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error(`The value of ${name} is too long or has a line break`)
    out[name] = value
  }
  if (Object.keys(out).length > 32) throw new Error('At most 32 environment variables')
  return Object.keys(out).length ? out : undefined
}

function checkColor(color: string | null): string | undefined {
  if (!color) return undefined
  if (!(HOST_COLORS as readonly string[]).includes(color)) throw new Error('Unknown colour')
  return color
}

/** A proxy as entered; the password is kept from `existing` unless replaced or removed. */
function checkProxy(input: ProxyInput, existing?: ProxyConfig): ProxyConfig {
  if (input.kind !== 'socks5' && input.kind !== 'http') throw new Error('Unknown kind of proxy')
  const host = required(input.host, 'Proxy address', 255)
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be 1-65535')
  const username = (input.username ?? '').trim()
  if (username.length > 255) throw new Error('Proxy username is too long')
  const password = input.password === undefined ? existing?.password : input.password || undefined
  if (password && password.length > 255) throw new Error('Proxy password is too long')
  if (password && !username) throw new Error('A proxy password needs a username')
  return { kind: input.kind, host, port, ...(username ? { username } : {}), ...(password ? { password } : {}) }
}

/** A proxy from an export file: kept if valid, dropped (not fatal) if not. */
function importProxy(proxy: unknown): ProxyConfig | undefined {
  if (!proxy || typeof proxy !== 'object') return undefined
  try {
    return checkProxy(proxy as ProxyInput)
  } catch {
    return undefined
  }
}

/** Environment variables from an export file: kept if valid, dropped (not fatal) if not. */
function importEnv(env: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== 'object') return undefined
  try {
    return checkEnv(env as Record<string, string>)
  } catch {
    return undefined
  }
}

function required(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  if (value.length > max) throw new Error(`${name} is too long`)
  return value.trim()
}

function checkUsername(username: string): string {
  const u = required(username, 'Username', 64).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(u)) {
    throw new Error('Username must be 3-64 characters: letters, digits and . _ @ + -')
  }
  return u
}

/** The Personal vault's id among the vaults on a device. */
export const PERSONAL_ID = 'personal'
const PERSONAL_NAME = 'Personal'
/** The list of further vaults (names and keys), sealed with the Personal vault's key. */
const INDEX_FILE = 'vaults'
const INDEX_CONTEXT = 'vault-index'
const MAX_VAULTS = 50
const vaultFile = (id: string) => `vault-${id}`

/** The device's list of further vaults, as stored (sealed). */
interface VaultIndex {
  personalName: string
  /** `serverId`: the server connection it syncs through (`PERSONAL_ID` for the Personal vault's account). */
  vaults: Array<VaultEntry>
  /** The vault shown last; the Personal vault when unset. */
  active?: string
  /** Accounts on further sync servers. */
  servers?: ServerEntry[]
}

interface VaultEntry {
  id: string
  name: string
  key: string
  serverId?: string
  /** On its server: an admin (changes it) or a member (connects only). */
  role?: 'admin' | 'member'
  /** Which vault key it has (see `RemoteVault.epoch`). */
  epoch?: number
  /** How many accounts share it. */
  members?: number
  /** Removed from it, or deleted on the server: it stopped syncing. */
  lost?: boolean
}

/**
 * An account on a further sync server, with its own username and password.
 * Its password is not kept: `accountKey` (the account's own vault key, which
 * the password unwraps) seals the keys and names of its vaults on the server.
 */
interface ServerEntry {
  id: string
  url: string
  username: string
  accountKey: string
  token: string
}

/** What one server connection is: its API, and the key that seals vault keys and names for it. */
interface Account {
  id: string
  url: string
  username: string
  api: SyncApi
  sealer: Vault
}

const vaultKeyContext = (id: string) => `vault-key:${id}`
const vaultMetaContext = (id: string) => `vault-meta:${id}`
const OLD_SERVER = 'This sync server must be updated before it can hold more than one vault.'
const OLD_SERVER_SHARED = 'This sync server must be updated before vaults on it can be shared.'
const READ_ONLY = 'You are a member of this shared vault: only its admins can change it.'
const PRIVATE_KEY_CONTEXT = 'account-private-key'
const loginContext = (id: string) => `termterm:login:${id}`
const loginKeyContext = (id: string) => `termterm:login-key:${id}`
const memberKeyContext = (vaultId: string) => `member-key:${vaultId}`

/** What a connection reads and writes in the vault it was made from. */
export interface VaultScope {
  vaultId: string
  host(id: string): Item<HostData> | undefined
  key(id: string): Item<KeyData> | undefined
  /** Every key in the vault (for agent forwarding). */
  keys(): KeyData[]
  forward(id: string): Item<ForwardData> | undefined
  knownHostsFor(host: string, port: number): Item<KnownHostData>[]
  trustHostKey(entry: KnownHostData, replace: boolean): void
}

/**
 * Owns the vault file and the unlocked vault: unlocking, editing, saving and
 * syncing. It is the same on every platform; what differs (storage, the OS
 * credential store, SSH key handling) is supplied as a `Platform`.
 */
export class VaultService {
  /** The Personal vault: opened with the master password, and the one that syncs. */
  private vault: Vault | null = null
  /** Further vaults on this device, by id; their keys are in the (encrypted) list of vaults. */
  private others = new Map<string, Vault>()
  private index: VaultIndex = { personalName: PERSONAL_NAME, vaults: [] }
  /** The vault every page shows, and new items go into. */
  private activeId = PERSONAL_ID
  private rollback: SyncStatus['rollback'] = undefined
  private syncState: Pick<SyncStatus, 'state' | 'error' | 'needsSignIn'> = {
    state: 'idle',
    needsSignIn: false,
  }
  private syncRunning: Promise<void> | null = null
  private syncAgain = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setTimeout> | null = null
  private notifyQueued = false
  private changedVaults = new Set<string>()
  /** Further servers' sync errors and sign-outs, by server id (the Personal account's are in `syncState`). */
  private serverState = new Map<string, { error?: string; needsSignIn: boolean }>()
  /** Each server account's key pair, once fetched (or made) this session. */
  private keyPairs = new Map<string, AccountKeyPair>()
  /** Shared vaults' members, from the last time they were fetched (for sealing personal logins). */
  private memberCache = new Map<string, RemoteMember[]>()

  /** Whether a vault file exists on this device; known once `ready` resolves. */
  private exists = false
  private readonly ready: Promise<void>
  /** Writes are queued so a slow one can never be overtaken by an older copy. */
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly platform: Platform,
    private readonly onSnapshot: (snapshot: VaultSnapshot) => void,
    private readonly onPhase: (phase: AppPhase) => void,
  ) {
    this.ready = platform.storage.read().then((data) => {
      this.exists = data !== null
    })
  }

  private get deviceKey() {
    return this.platform.deviceKey
  }

  async phase(): Promise<AppPhase> {
    if (this.vault) return 'unlocked'
    await this.ready
    return this.vault ? 'unlocked' : this.exists ? 'locked' : 'new'
  }

  /** True once the vault is unlocked. */
  get unlocked(): boolean {
    return this.vault !== null
  }

  private async assertNoVault(): Promise<void> {
    await this.ready
    if (this.exists) throw new Error('A vault already exists on this device')
  }

  private async readFile(): Promise<VaultFile> {
    // A save still on its way to storage (say, a change made just before
    // locking) must land first, or the vault would reopen from the older file
    // and that older copy would later overwrite the change.
    await this.writes
    const data = await this.platform.storage.read()
    if (data === null) throw new Error('There is no vault on this device')
    return JSON.parse(data) as VaultFile
  }

  // ---- lifecycle -------------------------------------------------------------

  async create(password: string): Promise<void> {
    await this.assertNoVault()
    this.checkNewPassword(password)
    await this.adopt(await Vault.create(password))
  }

  async signIn(input: AccountInput): Promise<void> {
    await this.assertNoVault()
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const username = checkUsername(input.username)
    const api = new SyncApi(serverUrl)
    const kdf = await api.prelogin(username)
    const { authKey } = await deriveKeys(input.password, kdf)
    const { token, wrappedVaultKey } = await api.login(username, authKey)
    const vault = await Vault.fromAccount(kdf, wrappedVaultKey, input.password)
    vault.setSync(serverUrl, username, token)
    await this.adopt(vault)
    void this.labelDevice()
    await this.syncNow()
  }

  async unlock(password: string): Promise<void> {
    if (this.vault) return
    const file = await this.readFile()
    let vault: Vault
    try {
      vault = await Vault.unlock(file, password)
    } catch (e) {
      if (e instanceof WrongPasswordError && file.pendingRekey) {
        throw new Error(
          'Incorrect master password. A password change was interrupted on this device: ' +
            'enter the password you had before it. The change finishes once the app reaches the sync server.',
        )
      }
      throw e
    }
    if (!this.vault) await this.adopt(vault)
  }

  /**
   * Opens the vault at launch with the key kept in the OS credential store,
   * if the user turned that on. Falls back to the password screen on any doubt.
   */
  async tryDeviceUnlock(): Promise<void> {
    await this.ready
    if (this.deviceKey.userPresence) return // never without the user asking; see unlockWithDevice
    if (this.vault || !this.exists || !this.platform.rememberDevice()) return
    const key = await this.deviceKey.load()
    if (!key || this.vault) return
    try {
      const vault = Vault.unlockWithKey(await this.readFile(), key)
      if (!this.vault) await this.adopt(vault)
    } catch {
      await this.deviceKey.clear()
    } finally {
      key.fill(0)
    }
  }

  /** Whether the locked vault can be opened now with a fingerprint or face. */
  async canUnlockWithDevice(): Promise<boolean> {
    await this.ready
    if (this.vault || !this.exists || !this.deviceKey.userPresence) return false
    if (!this.platform.rememberDevice()) return false
    return (await this.deviceKey.has?.()) ?? false
  }

  /**
   * Unlocks with the key the device releases after a fingerprint or face
   * check. A cancelled or failed check rejects and leaves the vault locked.
   */
  async unlockWithDevice(): Promise<void> {
    if (this.vault) return
    const key = await this.deviceKey.load()
    if (!key) throw new Error('Fingerprint unlock is not set up. Use your master password.')
    try {
      const vault = Vault.unlockWithKey(await this.readFile(), key)
      if (!this.vault) await this.adopt(vault)
    } catch {
      // The stored key is for a different vault key (the vault was re-keyed).
      await this.deviceKey.clear()
      throw new Error('Fingerprint unlock needs setting up again. Use your master password.')
    } finally {
      key.fill(0)
    }
  }

  /** Brings the stored device key in line with the setting. */
  async applyRememberDevice(): Promise<void> {
    if (!this.platform.rememberDevice()) {
      await this.deviceKey.clear()
      return
    }
    const vault = this.vault
    if (!vault) return
    // Storing a presence-protected key prompts the user, so only do it when missing.
    if (this.deviceKey.userPresence && (await this.deviceKey.has?.())) return
    const key = vault.exportKey()
    try {
      await this.deviceKey.save(key)
      // Locked while the key was being stored: the lock wins.
      if (this.vault !== vault) await this.deviceKey.clear()
    } finally {
      key.fill(0)
    }
  }

  /**
   * Locks the vault. A lock the user (or auto-lock) asked for also forgets
   * the stored device key, so restarting the app cannot undo it; quitting
   * (`forget: false`) keeps it for the next launch.
   */
  lock({ forget = true } = {}): void {
    // A presence-protected key stays: the fingerprint check is what guards it.
    if (forget && !this.deviceKey.userPresence) void this.deviceKey.clear()
    if (!this.vault) return
    this.save()
    if (this.syncTimer) clearTimeout(this.syncTimer)
    if (this.interval) clearInterval(this.interval)
    this.syncTimer = this.interval = null
    for (const id of this.others.keys()) this.saveOther(id)
    this.vault.lock()
    this.vault = null
    for (const other of this.others.values()) other.lock()
    this.others.clear()
    this.index = { personalName: PERSONAL_NAME, vaults: [] }
    this.activeId = PERSONAL_ID
    this.syncState = { state: 'idle', needsSignIn: false }
    this.serverState.clear()
    for (const pair of this.keyPairs.values()) pair.privateKey.fill(0)
    this.keyPairs.clear()
    this.memberCache.clear()
    this.onPhase('locked')
  }

  async changePassword(current: string, next: string): Promise<void> {
    const v = this.p
    this.checkNewPassword(next)
    if (next === current) throw new Error('The new password is the same as the current one')
    const rekey = await v.prepareRekey(current, next)
    if (v.sync) {
      // Server first. The change is noted on disk before it is sent: if the
      // app dies after the server accepts it, the next sync finishes it here.
      v.beginRekey(rekey.kdf, rekey.wrappedVaultKey)
      this.save()
      await this.flush()
      try {
        await new SyncApi(v.sync.serverUrl, v.syncToken()).changePassword(
          rekey.currentAuthKey,
          rekey.newAuthKey,
          rekey.kdf,
          rekey.wrappedVaultKey,
        )
      } catch (e) {
        // A refusal means nothing changed. With no answer at all the server
        // may have taken it: keep the note, and let the next sync find out.
        if (e instanceof SyncError) {
          v.cancelRekey()
          this.save()
        }
        throw e
      }
    }
    v.commitRekey(rekey.kdf, rekey.wrappedVaultKey)
    this.save()
  }

  /**
   * Finishes a password change interrupted after it was sent: if the server
   * now holds the new password, this device takes it too; if it still holds
   * the old one, the change never happened. Without an answer, it waits.
   */
  private async finishPasswordChange(v: Vault): Promise<void> {
    const pending = v.pendingRekey
    if (!pending || !v.sync) return
    let salt: string
    try {
      salt = (await new SyncApi(v.sync.serverUrl).prelogin(v.sync.username)).salt
    } catch {
      return // try again on the next sync
    }
    if (salt === pending.kdf.salt) v.commitRekey(pending.kdf, pending.wrappedVaultKey)
    else if (salt === v.kdf.salt) v.cancelRekey()
    else return // changed again elsewhere: signing in again sorts it out
    this.save()
  }

  private async adopt(vault: Vault): Promise<void> {
    this.vault = vault
    this.activeId = PERSONAL_ID
    vault.onChange(() => this.changed(PERSONAL_ID))
    this.save()
    // The other vaults open before the app shows as unlocked, so it opens on
    // the vault shown last (and starts that vault's forwards). A vault that
    // cannot be read must not keep the Personal one shut.
    try {
      await this.openOthers(vault)
    } catch (e) {
      console.error('Could not open the other vaults:', e)
    }
    if (this.vault !== vault) return // locked meanwhile
    // If the credential store has gone away, unlocking still works with the password.
    void this.applyRememberDevice().catch(() => undefined)
    this.interval = setInterval(() => this.scheduleSync(0), SYNC_INTERVAL_MS)
    this.onPhase('unlocked')
    this.scheduleSync(0)
  }

  private checkNewPassword(password: string): void {
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('Master password must be at least 8 characters')
    }
  }

  /** The vault on screen. */
  private get v(): Vault {
    if (!this.vault) throw new Error('Vault is locked')
    return this.others.get(this.activeId) ?? this.vault
  }

  /** The Personal vault: the master password, the sync account. */
  private get p(): Vault {
    if (!this.vault) throw new Error('Vault is locked')
    return this.vault
  }

  /**
   * Queues the current (encrypted) vault to be written. The copy is taken now,
   * so it is correct even if the vault is locked before the write happens.
   */
  private save(): void {
    if (!this.vault) return
    const data = JSON.stringify(this.vault.toFile())
    this.exists = true
    this.writes = this.writes
      .then(() => this.platform.storage.write(data))
      .catch((err: unknown) => console.error('Could not save the vault:', err))
  }

  /** Resolves when every queued write has reached storage. Await before quitting. */
  flush(): Promise<void> {
    return this.writes
  }

  private changed(vaultId: string): void {
    this.changedVaults.add(vaultId)
    // Coalesce bursts (e.g. a sync applying many items) into one save + notify.
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      const ids = [...this.changedVaults]
      this.changedVaults.clear()
      if (!this.vault) return
      for (const id of ids) {
        if (id === PERSONAL_ID) this.save()
        else this.saveOther(id)
      }
      this.onSnapshot(this.snapshot())
      if (this.syncing().some((v) => v.dirtyItems().length)) this.scheduleSync(SYNC_DEBOUNCE_MS)
    })
  }

  // ---- several vaults ------------------------------------------------------------

  /** Opens the vaults in the device's list (after the Personal vault opened). */
  private async openOthers(personal: Vault): Promise<void> {
    const storage = this.platform.storage
    if (!storage.readNamed) return
    await this.writes
    const raw = await storage.readNamed(INDEX_FILE)
    if (!raw || this.vault !== personal) return
    const index = JSON.parse(personal.openText((JSON.parse(raw) as { box: string }).box, INDEX_CONTEXT)) as VaultIndex
    for (const entry of index.vaults) {
      const data = await storage.readNamed(vaultFile(entry.id))
      if (this.vault !== personal) return
      const key = fromBase64(entry.key)
      // A vault whose file is missing (lost, or not copied with the rest) opens empty rather than not at all.
      const vault = data ? Vault.unlockWithKey(JSON.parse(data) as VaultFile, key) : Vault.createWithKey(key)
      key.fill(0)
      this.attach(entry.id, vault)
      if (!data) this.saveOther(entry.id)
    }
    this.index = index
    if (index.active && this.others.has(index.active)) this.activeId = index.active
    this.onSnapshot(this.snapshot())
  }

  private attach(id: string, vault: Vault): void {
    this.others.set(id, vault)
    vault.onChange(() => this.changed(id))
  }

  private saveOther(id: string): void {
    const vault = this.others.get(id)
    const write = this.platform.storage.writeNamed
    if (!vault || !write) return
    const data = JSON.stringify(vault.toFile())
    this.writes = this.writes
      .then(() => write.call(this.platform.storage, vaultFile(id), data))
      .catch((err: unknown) => console.error('Could not save a vault:', err))
  }

  /** The list of vaults, sealed with the Personal vault's key (which a password change does not alter). */
  private saveIndex(): void {
    const write = this.platform.storage.writeNamed
    if (!this.vault || !write) return
    const data = JSON.stringify({ format: 1, box: this.vault.sealText(JSON.stringify(this.index), INDEX_CONTEXT) })
    this.writes = this.writes
      .then(() => write.call(this.platform.storage, INDEX_FILE, data))
      .catch((err: unknown) => console.error('Could not save the list of vaults:', err))
  }

  addVault(name: string): string {
    void this.p // throws when locked
    const storage = this.platform.storage
    if (!storage.readNamed || !storage.writeNamed) throw new Error('This device keeps one vault only')
    const label = this.checkVaultName(name)
    if (this.index.vaults.length >= MAX_VAULTS) throw new Error(`At most ${MAX_VAULTS + 1} vaults on a device`)
    const id = randomId()
    const vault = Vault.createWithKey()
    const key = vault.exportKey()
    this.index = { ...this.index, vaults: [...this.index.vaults, { id, name: label, key: toBase64(key) }] }
    key.fill(0)
    this.attach(id, vault)
    this.saveOther(id)
    this.saveIndex()
    this.onSnapshot(this.snapshot())
    return id
  }

  renameVault(id: string, name: string): void {
    void this.p // throws when locked
    const label = this.checkVaultName(name, id)
    if (id === PERSONAL_ID) this.index = { ...this.index, personalName: label }
    else {
      if (!this.others.has(id)) throw new Error('Vault not found')
      this.index = { ...this.index, vaults: this.index.vaults.map((v) => (v.id === id ? { ...v, name: label } : v)) }
      // Its other devices see the new name when they next add vaults from the server; best effort.
      const entry = this.index.vaults.find((v) => v.id === id)
      const account = entry?.serverId ? this.accountOrNull(entry.serverId) : null
      if (account) {
        void account.api
          .updateVault(id, { meta: account.sealer.sealText(JSON.stringify({ name: label }), vaultMetaContext(id)) })
          .catch(() => undefined)
      }
    }
    this.saveIndex()
    this.onSnapshot(this.snapshot())
  }

  /** Deletes a vault and everything in it from this device. The Personal vault stays. */
  async deleteVault(id: string, options: { fromServer?: boolean } = {}): Promise<void> {
    void this.p // throws when locked
    if (id === PERSONAL_ID) throw new Error('The Personal vault cannot be deleted')
    const vault = this.others.get(id)
    if (!vault) throw new Error('Vault not found')
    // The server first: if that fails, nothing is deleted here either.
    if (options.fromServer) await this.leaveRemote(id)
    vault.lock()
    this.others.delete(id)
    this.index = { ...this.index, vaults: this.index.vaults.filter((v) => v.id !== id) }
    if (this.activeId === id) this.activeId = PERSONAL_ID
    if (this.index.active === id) this.index = { ...this.index, active: undefined }
    this.saveIndex()
    const remove = this.platform.storage.removeNamed
    if (remove) {
      this.writes = this.writes
        .then(() => remove.call(this.platform.storage, vaultFile(id)))
        .catch((err: unknown) => console.error('Could not delete a vault file:', err))
    }
    this.onSnapshot(this.snapshot())
  }

  /** Shows another vault; it stays the one shown the next time the app opens. */
  switchVault(id: string): void {
    void this.p // throws when locked
    if (id !== PERSONAL_ID && !this.others.has(id)) throw new Error('Vault not found')
    this.activeId = id
    this.index = { ...this.index, active: id === PERSONAL_ID ? undefined : id }
    this.saveIndex()
    this.onSnapshot(this.snapshot())
  }

  /** The id of the vault on screen. */
  get activeVault(): string {
    return this.activeId
  }

  private checkVaultName(name: string, id?: string): string {
    const label = required(name, 'Vault name', 64)
    const names = [
      ...(id === PERSONAL_ID ? [] : [this.index.personalName]),
      ...this.index.vaults.filter((v) => v.id !== id).map((v) => v.name),
    ]
    if (names.some((n) => n.toLowerCase() === label.toLowerCase())) throw new Error(`There is already a vault called "${label}"`)
    return label
  }

  /**
   * The items of one vault, for a connection made from it: its hosts, keys,
   * known hosts and forwards, whichever vault is on screen later. Without an
   * id, the vault on screen now.
   */
  scope(vaultId?: string): VaultScope {
    void this.p // throws when locked
    const id = vaultId ?? this.activeId
    const vault = () => {
      if (!this.vault) throw new Error('Vault is locked')
      const found = id === PERSONAL_ID ? this.vault : this.others.get(id)
      if (!found) throw new Error('That vault is no longer on this device')
      return found
    }
    const sameHost = (k: Item<KnownHostData>, host: string, port: number) => k.data.host === host && k.data.port === port
    return {
      vaultId: id,
      host: (hostId) => this.hostIn(id, vault(), hostId),
      key: (keyId) => {
        const item = vault().get<KeyData | MemberKeyData>(keyId)
        if (item?.type === 'memberKey') return this.openMemberKey(id, item as Item<MemberKeyData>)
        return item as Item<KeyData> | undefined
      },
      keys: () => vault().list<KeyData>('key').map((k) => k.data),
      forward: (forwardId) => {
        const item = vault().get<ForwardData>(forwardId)
        return item?.type === 'forward' ? item : undefined
      },
      knownHostsFor: (host, port) =>
        vault()
          .list<KnownHostData>('knownHost')
          .filter((k) => sameHost(k, host, port)),
      trustHostKey: (entry, replace) => {
        const v = vault()
        // A member of a shared vault keeps the host keys they trust as their
        // own items (which the server lets them write); the admins' stay.
        const tag = this.readOnly(id) ? this.memberPrefix(id) : null
        if (replace) {
          for (const old of v.list<KnownHostData>('knownHost')) {
            if (sameHost(old, entry.host, entry.port) && (!tag || old.id.startsWith(tag))) v.delete(old.id)
          }
        }
        // Item ids are at most 64 characters: the tag (35) and 24 random hex digits.
        v.put('knownHost', entry, tag ? `${tag}${randomId().replace(/-/g, '').slice(0, 24)}` : undefined)
      },
    }
  }

  /** A host as connected to, from a given vault: its identity's (or the member's personal) login in place of its own. */
  private hostIn(vaultId: string, vault: Vault, id: string): Item<HostData> | undefined {
    const host = vault.get<HostData>(id)
    if (host?.type !== 'host') return host
    if (host.data.personalLogin) return this.withPersonalLogin(vaultId, vault, host)
    if (!host.data.identityId) return host
    const identity = vault.get<IdentityData>(host.data.identityId)
    if (identity?.type !== 'identity') return host
    const { password: _p, keyId: _k, ...own } = host.data
    const { username, password, keyId } = identity.data
    return {
      ...host,
      data: { ...own, username: username || own.username, ...(password ? { password } : {}), ...(keyId ? { keyId } : {}) },
    }
  }

  /** The personal login assigned to this device's account, with its password and the member's own key. */
  private withPersonalLogin(vaultId: string, vault: Vault, host: Item<HostData>): Item<HostData> {
    const me = this.memberName(vaultId)
    const { password: _p, keyId: _k, identityId: _i, ...own } = host.data
    if (!me) throw new Error('This host uses personal logins, which need a shared vault')
    const login = vault.list<IdentityData>('identity').find((i) => i.data.assignee === me)
    if (!login) throw new Error(`No personal login is assigned to ${me} in this vault. Ask one of its admins.`)
    const password = this.openLogin(vaultId, login)?.password
    const keyId = `${this.memberPrefix(vaultId)}key`
    return {
      ...host,
      data: {
        ...own,
        username: login.data.username,
        ...(password ? { password } : {}),
        ...(vault.get(keyId)?.type === 'memberKey' ? { keyId } : {}),
      },
    }
  }

  // ---- views ---------------------------------------------------------------

  snapshot(): VaultSnapshot {
    const v = this.v
    const sync = this.p.sync
    return {
      vaults: [
        { id: PERSONAL_ID, name: this.index.personalName, personal: true, ...this.syncView(PERSONAL_ID, this.p) },
        ...this.index.vaults.map((x) => {
          const vault = this.others.get(x.id)
          return {
            id: x.id,
            name: x.name,
            personal: false,
            ...(vault ? this.syncView(x.serverId, vault) : {}),
            ...(x.serverId && x.role ? { role: x.role } : {}),
            ...(x.serverId && x.members ? { members: x.members } : {}),
            ...(x.lost ? { lost: true } : {}),
          }
        }),
      ],
      servers: this.serverViews(),
      readOnly: this.readOnly(this.activeId),
      ...this.sharedAsView(),
      activeVaultId: this.activeId,
      multiVault: !!this.platform.storage.writeNamed,
      hosts: v
        .list<HostData>('host')
        .map(({ id, data }) => ({
          id,
          label: data.label,
          address: data.address,
          port: data.port,
          username: data.username,
          tags: data.tags,
          hasPassword: !!data.password,
          keyId: data.keyId,
          jumpHostId: data.jumpHostId,
          identityId: data.identityId,
          group: data.group,
          keepAlive: data.keepAlive,
          startupSnippetId: data.startupSnippetId,
          env: data.env,
          color: data.color,
          ...(data.proxy
            ? {
                proxy: {
                  kind: data.proxy.kind,
                  host: data.proxy.host,
                  port: data.proxy.port,
                  ...(data.proxy.username ? { username: data.proxy.username } : {}),
                  hasPassword: !!data.proxy.password,
                },
              }
            : {}),
          ...(data.agentForward ? { agentForward: true } : {}),
          ...(data.personalLogin ? { personalLogin: true } : {}),
        }))
        .sort(byLabel),
      identities: v
        .list<IdentityData>('identity')
        .map(({ id, data }) => ({
          id,
          label: data.label,
          username: data.username,
          hasPassword: !!data.password || !!data.sealed,
          keyId: data.keyId,
          ...(data.assignee ? { assignee: data.assignee } : {}),
        }))
        .sort(byLabel),
      forwards: v
        .list<ForwardData>('forward')
        .map(({ id, data }) => ({ id, ...data }))
        .sort(byLabel),
      keys: v
        .list<KeyData>('key')
        .map(({ id, data }) => ({
          id,
          label: data.label,
          keyType: data.keyType,
          publicKey: data.publicKey,
          fingerprint: fingerprintOfPublicLine(data.publicKey),
          hasPassphrase: !!data.passphrase,
          ...(data.certificate ? { certificate: data.certificate } : {}),
        }))
        .sort(byLabel),
      snippets: v
        .list<SnippetData>('snippet')
        .map(({ id, data }) => ({ id, ...data }))
        .sort(byLabel),
      knownHosts: v
        .list<KnownHostData>('knownHost')
        .map(({ id, data }) => ({
          id,
          host: data.host,
          port: data.port,
          keyType: data.keyType,
          fingerprint: data.fingerprint,
        }))
        .sort((a, b) => a.host.localeCompare(b.host)),
      sync: {
        configured: !!sync,
        serverUrl: sync?.serverUrl,
        username: sync?.username,
        lastSyncAt: sync?.lastSyncAt,
        insecure: sync ? isInsecureUrl(sync.serverUrl) : false,
        pending: sync ? this.p.dirtyItems().length : 0,
        ...this.syncState,
        ...(this.rollback ? { rollback: this.rollback } : {}),
      },
    }
  }

  // ---- used by the SSH layer (main process only) -------------------------------

  /**
   * A host as it is connected to: with its identity's username, password and
   * key in place of its own when it uses one.
   */
  host(id: string): Item<HostData> | undefined {
    return this.scope().host(id)
  }

  key(id: string): Item<KeyData> | undefined {
    return this.scope().key(id)
  }

  knownHostsFor(host: string, port: number): Item<KnownHostData>[] {
    return this.scope().knownHostsFor(host, port)
  }

  trustHostKey(entry: KnownHostData, replace: boolean): void {
    this.scope().trustHostKey(entry, replace)
  }

  // ---- mutations -------------------------------------------------------------

  saveHost(id: string | null, input: HostInput): string {
    this.writable()
    const existing = id ? this.v.get<HostData>(id) : undefined
    if (id && existing?.type !== 'host') throw new Error('Host not found')
    const address = required(input.address, 'Address', 255)
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535')
    if (input.keyId && this.v.get(input.keyId)?.type !== 'key') throw new Error('Key not found')
    const password =
      input.password === undefined ? existing?.data.password : input.password || undefined
    const jumpHostId = input.jumpHostId === undefined ? existing?.data.jumpHostId : input.jumpHostId || undefined
    if (jumpHostId) this.checkJump(id, jumpHostId)
    const identityId = input.identityId === undefined ? existing?.data.identityId : input.identityId || undefined
    if (identityId && this.v.get(identityId)?.type !== 'identity') throw new Error('Identity not found')
    const group = (input.group === undefined ? (existing?.data.group ?? '') : String(input.group)).trim().slice(0, 64)
    const keepAlive = input.keepAlive === undefined ? existing?.data.keepAlive : checkKeepAlive(input.keepAlive)
    const startupSnippetId =
      input.startupSnippetId === undefined ? existing?.data.startupSnippetId : input.startupSnippetId || undefined
    if (startupSnippetId && this.v.get(startupSnippetId)?.type !== 'snippet') throw new Error('Snippet not found')
    const env = input.env === undefined ? existing?.data.env : checkEnv(input.env)
    const color = input.color === undefined ? existing?.data.color : checkColor(input.color)
    const proxy = input.proxy === undefined ? existing?.data.proxy : input.proxy === null ? undefined : checkProxy(input.proxy, existing?.data.proxy)
    const agentForward = input.agentForward === undefined ? existing?.data.agentForward : input.agentForward === true
    const personalLogin = input.personalLogin === undefined ? existing?.data.personalLogin : input.personalLogin === true
    if (personalLogin && this.activeId === PERSONAL_ID) throw new Error('Personal logins are for shared vaults')
    const data: HostData = {
      label: (input.label ?? '').trim().slice(0, 128) || address,
      address,
      port,
      username: (input.username ?? '').trim().slice(0, 128),
      tags: [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 32),
      ...(password ? { password } : {}),
      ...(input.keyId ? { keyId: input.keyId } : {}),
      ...(jumpHostId ? { jumpHostId } : {}),
      ...(identityId ? { identityId } : {}),
      ...(group ? { group } : {}),
      ...(keepAlive !== undefined ? { keepAlive } : {}),
      ...(startupSnippetId ? { startupSnippetId } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
      ...(color ? { color } : {}),
      ...(proxy ? { proxy } : {}),
      ...(agentForward ? { agentForward: true } : {}),
      ...(personalLogin ? { personalLogin: true } : {}),
    }
    return this.v.put('host', data, id ?? undefined).id
  }

  /** A jump host must be another saved host, and must not lead back to this one. */
  private checkJump(id: string | null, jumpHostId: string): void {
    const seen = new Set<string>(id ? [id] : [])
    let next: string | undefined = jumpHostId
    for (let depth = 0; next; depth++) {
      if (seen.has(next)) throw new Error('A host cannot be reached through itself')
      if (depth >= MAX_JUMPS) throw new Error(`At most ${MAX_JUMPS} jump hosts in a row`)
      const hop: Item<HostData> | undefined = this.v.get<HostData>(next)
      if (hop?.type !== 'host') throw new Error('Jump host not found')
      seen.add(next)
      next = hop.data.jumpHostId
    }
  }

  saveForward(id: string | null, input: ForwardInput): string {
    this.writable()
    if (id && this.v.get(id)?.type !== 'forward') throw new Error('Port forward not found')
    if (this.v.get(input.hostId)?.type !== 'host') throw new Error('Choose a host to forward through')
    const kind = input.kind
    if (kind !== 'local' && kind !== 'remote' && kind !== 'dynamic') throw new Error('Unknown kind of forward')
    const port = (value: unknown, name: string) => {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`${name} must be 1-65535`)
      }
      return n
    }
    const data: ForwardData = {
      label: '',
      hostId: input.hostId,
      kind,
      bindHost: (input.bindHost ?? '').trim().slice(0, 255) || (kind === 'remote' ? 'localhost' : '127.0.0.1'),
      bindPort: port(input.bindPort, 'Listening port'),
    }
    if (kind !== 'dynamic') {
      data.destHost = required(input.destHost, 'Destination host', 255)
      data.destPort = port(input.destPort, 'Destination port')
    }
    if (input.autoStart === true) data.autoStart = true
    data.label =
      (input.label ?? '').trim().slice(0, 128) ||
      (kind === 'dynamic' ? `SOCKS on ${data.bindPort}` : `${data.bindPort} → ${data.destHost}:${data.destPort}`)
    return this.v.put('forward', data, id ?? undefined).id
  }

  forward(id: string): Item<ForwardData> | undefined {
    const item = this.v.get<ForwardData>(id)
    return item?.type === 'forward' ? item : undefined
  }

  async generateKey(label: string, type: 'ed25519' | 'rsa'): Promise<string> {
    this.writable()
    if (type !== 'ed25519' && type !== 'rsa') throw new Error('Unsupported key type')
    const key = await this.platform.keys.generate(required(label, 'Label', 128), type)
    return this.v.put('key', key).id
  }

  async importKey(input: KeyImportInput): Promise<string> {
    this.writable()
    const label = required(input.label, 'Label', 128)
    const privateKey = required(input.privateKey, 'Private key', 32 * 1024)
    const key = await this.platform.keys.import(label, privateKey, input.passphrase)
    return this.v.put('key', key).id
  }

  setKeyCertificate(id: string, certificate: string | null): void {
    this.writable()
    const key = this.v.get<KeyData>(id)
    if (key?.type !== 'key') throw new Error('Key not found')
    const { certificate: _old, ...rest } = key.data
    const text = (certificate ?? '').trim()
    if (!text) {
      this.v.put('key', rest, id)
      return
    }
    if (text.length > 16 * 1024) throw new Error('This certificate is too long')
    parseCertificate(text) // throws, with the reason, if it is not a user certificate
    if (!certificateMatchesKey(text, key.data.publicKey)) throw new Error('This certificate is for a different key.')
    this.v.put('key', { ...rest, certificate: text }, id)
  }

  renameKey(id: string, label: string): void {
    this.writable()
    const key = this.v.get<KeyData>(id)
    if (key?.type !== 'key') throw new Error('Key not found')
    this.v.put('key', { ...key.data, label: required(label, 'Label', 128) }, id)
  }

  saveSnippet(id: string | null, input: { label: string; script: string }): string {
    this.writable()
    if (id && this.v.get(id)?.type !== 'snippet') throw new Error('Snippet not found')
    const data: SnippetData = {
      label: required(input.label, 'Label', 128),
      script: required(input.script, 'Script', 64 * 1024),
    }
    return this.v.put('snippet', data, id ?? undefined).id
  }

  saveIdentity(id: string | null, input: IdentityInput): string {
    this.writable()
    const existing = id ? this.v.get<IdentityData>(id) : undefined
    if (id && existing?.type !== 'identity') throw new Error('Identity not found')
    const username = required(input.username, 'Username', 128)
    const label = (input.label ?? '').trim().slice(0, 128) || username
    const assignee = input.assignee === undefined ? existing?.data.assignee : input.assignee || undefined
    if (assignee) return this.savePersonalLogin(id ?? randomId(), existing, { label, username, assignee, password: input.password })
    if (input.keyId && this.v.get(input.keyId)?.type !== 'key') throw new Error('Key not found')
    // A personal login made shared again keeps no password: it was only ever sealed for some.
    const previous = existing?.data.assignee ? undefined : existing?.data.password
    const password = input.password === undefined ? previous : input.password || undefined
    const data: IdentityData = {
      label,
      username,
      ...(password ? { password } : {}),
      ...(input.keyId ? { keyId: input.keyId } : {}),
    }
    return this.v.put('identity', data, id ?? undefined).id
  }


  renameGroup(from: string, to: string): void {
    this.writable()
    const name = String(to ?? '').trim().slice(0, 64)
    for (const host of this.v.list<HostData>('host')) {
      if (host.data.group !== from) continue
      const { group: _old, ...rest } = host.data
      this.v.put('host', name ? { ...rest, group: name } : rest, host.id)
    }
  }

  deleteItem(id: string): void {
    this.writable()
    const item = this.v.get(id)
    if (!item) return
    if (item.type === 'key') {
      // Hosts and identities must not keep pointing at a key that no longer exists.
      for (const host of this.v.list<HostData>('host')) {
        if (host.data.keyId === id) {
          const { keyId: _removed, ...rest } = host.data
          this.v.put('host', rest, host.id)
        }
      }
      for (const identity of this.v.list<IdentityData>('identity')) {
        if (identity.data.keyId === id) {
          const { keyId: _removed, ...rest } = identity.data
          this.v.put('identity', rest, identity.id)
        }
      }
    }
    if (item.type === 'snippet') {
      for (const host of this.v.list<HostData>('host')) {
        if (host.data.startupSnippetId !== id) continue
        const { startupSnippetId: _removed, ...rest } = host.data
        this.v.put('host', rest, host.id)
      }
    }
    if (item.type === 'identity') {
      // Hosts that used it keep working: they get its login as their own.
      const { username, password, keyId } = (item as Item<IdentityData>).data
      for (const host of this.v.list<HostData>('host')) {
        if (host.data.identityId !== id) continue
        const { identityId: _i, password: _p, keyId: _k, ...rest } = host.data
        this.v.put('host', { ...rest, username, ...(password ? { password } : {}), ...(keyId ? { keyId } : {}) }, host.id)
      }
    }
    if (item.type === 'host') {
      // Hosts that went through it connect directly; its forwards go with it.
      for (const host of this.v.list<HostData>('host')) {
        if (host.data.jumpHostId === id) {
          const { jumpHostId: _removed, ...rest } = host.data
          this.v.put('host', rest, host.id)
        }
      }
      for (const forward of this.v.list<ForwardData>('forward')) {
        if (forward.data.hostId === id) this.v.delete(forward.id)
      }
    }
    this.v.delete(id)
  }

  // ---- export and import ---------------------------------------------------------

  /**
   * The vault's hosts, keys, identities, snippets, known hosts and port
   * forwards as an encrypted file, readable with `password`. Command history
   * stays out: it is per device and can hold things typed by mistake.
   */
  async exportVault(password: string): Promise<{ text: string; count: number }> {
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('The export password must be at least 8 characters')
    }
    const items = this.v.list().filter((i) => EXPORTED_TYPES.includes(i.type as (typeof EXPORTED_TYPES)[number]))
    return { text: await encryptExport(items, password), count: items.length }
  }

  /**
   * Adds the items of an export file to this vault. Each gets a new id, and
   * references between them (a host's key, identity and jump host, a
   * forward's host) follow. Something already here (the same key, a host with
   * the same label, address, port and user, ...) is not added twice: references to it point
   * at the copy already in the vault, which is left as it is.
   */
  async importVault(text: string, password: string): Promise<ImportResult> {
    this.writable()
    const items = await decryptExport(text, password)
    const v = this.v
    const result: ImportResult = { added: 0, existing: 0, skipped: 0 }
    const ids = new Map<string, string>()
    const of = <T>(type: string) => items.filter((i) => i.type === type) as Array<{ id: string; data: T }>
    const str = (x: unknown, max = 64 * 1024) => (typeof x === 'string' && x.length <= max ? x : undefined)
    const port = (x: unknown) => (Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 65535 ? (x as number) : undefined)
    const ref = (x: unknown) => (typeof x === 'string' ? ids.get(x) : undefined)
    const add = <T>(from: string, type: string, data: T, same: (existing: Item<T>) => boolean) => {
      const existing = v.list<T>(type).find(same)
      if (existing) {
        ids.set(from, existing.id)
        result.existing++
      } else {
        ids.set(from, v.put(type, data).id)
        result.added++
      }
    }

    for (const { id, data } of of<KeyData>('key')) {
      const privateKey = str(data.privateKey)
      const publicKey = str(data.publicKey, 16 * 1024)
      if (!privateKey || !publicKey) { result.skipped++; continue }
      const key: KeyData = {
        label: str(data.label, 128) || 'Imported key',
        privateKey,
        publicKey,
        keyType: str(data.keyType, 64) || publicKey.split(' ')[0] || '',
        ...(str(data.passphrase, 1024) ? { passphrase: data.passphrase } : {}),
        ...(str(data.certificate, 16 * 1024) && certificateMatchesKey(data.certificate!, publicKey) ? { certificate: data.certificate!.trim() } : {}),
      }
      add(id, 'key', key, (k) => k.data.publicKey.trim() === publicKey.trim())
    }
    for (const { id, data } of of<IdentityData>('identity')) {
      const username = str(data.username, 128)
      if (!username) { result.skipped++; continue }
      const keyId = ref(data.keyId)
      const identity: IdentityData = {
        label: str(data.label, 128) || username,
        username,
        ...(str(data.password, 1024) ? { password: data.password } : {}),
        ...(keyId ? { keyId } : {}),
      }
      add(id, 'identity', identity, (i) =>
        i.data.label === identity.label && i.data.username === username && i.data.keyId === identity.keyId)
    }
    // Snippets before hosts, which can name one to run when they connect.
    for (const { id, data } of of<SnippetData>('snippet')) {
      const script = str(data.script)
      if (!script) { result.skipped++; continue }
      const snippet: SnippetData = { label: str(data.label, 128) || 'Snippet', script }
      add(id, 'snippet', snippet, (x) => x.data.label === snippet.label && x.data.script === script)
    }
    // Hosts in two passes: a jump host may come after the host that uses it.
    const hosts = of<HostData>('host')
    const added: Array<[string, string]> = []
    for (const { id, data } of hosts) {
      const address = str(data.address, 255)
      const p = port(data.port)
      if (!address || !p) { result.skipped++; continue }
      const keyId = ref(data.keyId)
      const identityId = ref(data.identityId)
      const host: HostData = {
        label: str(data.label, 128) || address,
        address,
        port: p,
        username: str(data.username, 128) ?? '',
        tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string').slice(0, 32) : [],
        ...(str(data.password, 1024) ? { password: data.password } : {}),
        ...(keyId ? { keyId } : {}),
        ...(identityId ? { identityId } : {}),
        ...(str(data.group, 64) ? { group: data.group } : {}),
        ...(Number.isInteger(data.keepAlive) && data.keepAlive! >= 0 && data.keepAlive! <= 3600 ? { keepAlive: data.keepAlive } : {}),
        ...(ref(data.startupSnippetId) ? { startupSnippetId: ref(data.startupSnippetId) } : {}),
        ...(importEnv(data.env) ? { env: importEnv(data.env) } : {}),
        ...(typeof data.color === 'string' && (HOST_COLORS as readonly string[]).includes(data.color) ? { color: data.color } : {}),
        ...(importProxy(data.proxy) ? { proxy: importProxy(data.proxy) } : {}),
        ...(data.agentForward === true ? { agentForward: true } : {}),
      }
      const before = result.added
      // Several hosts can share an address (different users, identities or
      // purposes), so the label has to match as well.
      add(id, 'host', host, (h) =>
        h.data.address === address && h.data.port === p && h.data.username === host.username && h.data.label === host.label)
      if (result.added > before && typeof data.jumpHostId === 'string') added.push([ids.get(id)!, data.jumpHostId])
    }
    for (const [newId, jumpFrom] of added) {
      const jumpHostId = ids.get(jumpFrom)
      const host = v.get<HostData>(newId)
      if (jumpHostId && host && jumpHostId !== newId) v.put('host', { ...host.data, jumpHostId }, newId)
    }
    for (const { id, data } of of<ForwardData>('forward')) {
      const hostId = ref(data.hostId)
      const bindPort = port(data.bindPort)
      const kind = data.kind
      if (!hostId || !bindPort || (kind !== 'local' && kind !== 'remote' && kind !== 'dynamic')) { result.skipped++; continue }
      const forward: ForwardData = {
        label: str(data.label, 128) || '',
        hostId,
        kind,
        bindHost: str(data.bindHost, 255) || (kind === 'remote' ? 'localhost' : '127.0.0.1'),
        bindPort,
        ...(kind !== 'dynamic' && str(data.destHost, 255) && port(data.destPort)
          ? { destHost: data.destHost, destPort: data.destPort }
          : {}),
        ...(data.autoStart === true ? { autoStart: true } : {}),
      }
      if (kind !== 'dynamic' && !forward.destHost) { result.skipped++; continue }
      add(id, 'forward', forward, (f) => f.data.hostId === hostId && f.data.kind === kind && f.data.bindPort === bindPort)
    }
    for (const { id, data } of of<KnownHostData>('knownHost')) {
      const host = str(data.host, 255)
      const p = port(data.port)
      const publicKey = str(data.publicKey, 16 * 1024)
      const keyType = str(data.keyType, 64)
      if (!host || !p || !publicKey || !keyType) { result.skipped++; continue }
      const known: KnownHostData = { host, port: p, keyType, publicKey, fingerprint: str(data.fingerprint, 128) ?? '' }
      add(id, 'knownHost', known, (k) =>
        k.data.host === host && k.data.port === p && k.data.keyType === keyType && k.data.publicKey === publicKey)
    }
    result.skipped += items.filter((i) => !EXPORTED_TYPES.includes(i.type as (typeof EXPORTED_TYPES)[number])).length
    return result
  }

  // ---- importing from OpenSSH's files ------------------------------------------

  private sshImport: { files: SshImportFiles; hosts: ConfigHost[]; known: KnownHostEntry[] } | null = null

  /** Parses OpenSSH's files and says what an import would do; remembered for applySshImport. */
  scanSshImport(files: SshImportFiles): SshImportPreview {
    const v = this.v
    const hosts = files.config ? parseSshConfig(files.config) : []
    const parsed = files.knownHosts ? parseKnownHosts(files.knownHosts) : { entries: [], skipped: 0 }
    this.sshImport = { files, hosts, known: parsed.entries }
    const existing = v.list<HostData>('host').map((h) => h.data)
    const sameHost = (h: ConfigHost) =>
      existing.some(
        (e) =>
          e.address.toLowerCase() === h.address.toLowerCase() && e.port === h.port && e.username === h.username,
      )
    const counts = { add: 0, already: 0, conflicting: 0, skipped: parsed.skipped }
    for (const entry of parsed.entries) counts[this.knownHostStatus(entry)]++
    const notes: string[] = []
    const unresolved = hosts.filter((h) => h.proxyJump && !this.jumpTargetFor(h.proxyJump, hosts)).map((h) => h.alias)
    if (unresolved.length) {
      notes.push(
        `ProxyJump here is not the name of a single host in this config or your vault, so these connect directly: ${unresolved.join(', ')}.`,
      )
    }
    if (counts.conflicting) {
      notes.push(`${counts.conflicting} known host key(s) differ from the key termterm already trusts for that host and are left out.`)
    }
    if (parsed.skipped) notes.push(`${parsed.skipped} known_hosts entries are hashed or not plain keys and cannot be imported.`)
    return {
      source: files.source,
      hosts: hosts.map((h) => ({
        alias: h.alias,
        address: h.address,
        port: h.port,
        username: h.username,
        key: this.keyFileFor(h),
        exists: sameHost(h),
      })),
      knownHosts: counts,
      notes,
    }
  }

  async applySshImport(aliases: string[], includeKnownHosts: boolean): Promise<SshImportResult> {
    this.writable()
    const pending = this.sshImport
    if (!pending) throw new Error('Scan for hosts first')
    const v = this.v
    const result: SshImportResult = { hosts: 0, knownHosts: 0, keys: 0, keysNeedingPassphrase: [] }
    const keyIds = new Map<string, string | null>()
    const keyIdFor = async (path: string | undefined): Promise<string | null> => {
      if (!path) return null
      if (keyIds.has(path)) return keyIds.get(path)!
      const text = pending.files.keys?.[path]
      let id: string | null = null
      if (text) {
        try {
          const key = await this.platform.keys.import(path.split('/').pop() || path, text)
          // The same key may already be in the vault: use that one.
          const same = v.list<KeyData>('key').find((k) => k.data.publicKey.split(' ')[1] === key.publicKey.split(' ')[1])
          id = same ? same.id : v.put('key', key).id
          if (!same) result.keys++
        } catch {
          result.keysNeedingPassphrase.push(path)
        }
      }
      keyIds.set(path, id)
      return id
    }
    const preview = this.scanSshImport(pending.files) // what is in the vault may have changed
    for (const h of pending.hosts) {
      const row = preview.hosts.find((p) => p.alias === h.alias)
      if (!aliases.includes(h.alias) || !row || row.exists) continue
      this.saveHost(null, {
        label: h.alias,
        address: h.address,
        port: h.port,
        username: h.username,
        tags: [],
        keyId: await keyIdFor(this.keyFileFor(h)),
      })
      result.hosts++
    }
    // Jump hosts: by alias in this config, or a host already in the vault with that label.
    const imported = new Map<string, string>()
    for (const host of v.list<HostData>('host')) imported.set(host.data.label, host.id)
    for (const h of pending.hosts) {
      const id = imported.get(h.alias)
      const jump = h.proxyJump ? this.jumpTargetFor(h.proxyJump, pending.hosts) : undefined
      const jumpId = jump ? imported.get(jump) : undefined
      const item = id ? v.get<HostData>(id) : undefined
      if (!item || !jumpId || jumpId === id || item.data.jumpHostId || !aliases.includes(h.alias)) continue
      try {
        this.checkJump(id!, jumpId)
        v.put<HostData>('host', { ...item.data, jumpHostId: jumpId }, id)
      } catch {
        // a loop in the config: leave it connecting directly
      }
    }
    if (includeKnownHosts) {
      for (const entry of pending.known) {
        if (this.knownHostStatus(entry) !== 'add') continue
        v.put<KnownHostData>('knownHost', entry)
        result.knownHosts++
      }
    }
    this.sshImport = null
    return result
  }

  /** The host a ProxyJump value names, if it is one plain name known here. */
  private jumpTargetFor(proxyJump: string, hosts: ConfigHost[]): string | undefined {
    const name = proxyJump.trim()
    if (!name || /[,@:\s]/.test(name) || name.toLowerCase() === 'none') return undefined
    if (hosts.some((h) => h.alias === name)) return name
    return this.v.list<HostData>('host').some((h) => h.data.label === name) ? name : undefined
  }

  private keyFileFor(h: ConfigHost): string | undefined {
    const files = this.sshImport?.files
    if (h.identityFile) return files?.keys?.[h.identityFile] !== undefined ? h.identityFile : undefined
    return files?.defaultKey
  }

  private knownHostStatus(entry: KnownHostEntry): 'add' | 'already' | 'conflicting' {
    const known = this.knownHostsFor(entry.host, entry.port)
    if (known.some((k) => k.data.publicKey === entry.publicKey)) return 'already'
    // A different key of the same type is a conflict; another type is just another key.
    return known.some((k) => k.data.keyType === entry.keyType) ? 'conflicting' : 'add'
  }

  // ---- command history (for suggestions while typing) --------------------------

  /** Commands typed in sessions to one host or shell, oldest first, without repeats. */
  commandHistory(key: string): string[] {
    const merged: string[] = []
    // Two devices can each start a history for the same host before they sync: read both.
    for (const item of this.historyItems(key)) merged.push(...item.data.commands)
    return dedupeKeepLast(merged).slice(-HISTORY_LIMIT)
  }

  recordCommands(key: string, commands: string[]): void {
    const historyKey = required(key, 'History', 256)
    const add = commands
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && c.length <= 1000)
    // A member of a shared vault cannot write to it; their commands are not kept there.
    if (add.length === 0 || this.readOnly(this.activeId)) return
    const items = this.historyItems(historyKey)
    const merged = dedupeKeepLast([...items.flatMap((i) => i.data.commands), ...add]).slice(-HISTORY_LIMIT)
    const [keep, ...extra] = items
    this.v.put<HistoryData>('history', { key: historyKey, commands: merged }, keep?.id)
    for (const item of extra) this.v.delete(item.id)
  }

  clearCommandHistory(): void {
    this.writable()
    for (const item of this.v.list<HistoryData>('history')) this.v.delete(item.id)
  }

  private historyItems(key: string) {
    return this.v
      .list<HistoryData>('history')
      .filter((i) => i.data?.key === key && Array.isArray(i.data.commands))
  }

  // ---- sync ------------------------------------------------------------------

  async syncRegister(input: AccountInput): Promise<void> {
    const v = this.p
    if (v.sync) throw new Error('Sync is already set up')
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const username = checkUsername(input.username)
    const authKey = await v.authKeyFor(input.password)
    const token = await new SyncApi(serverUrl).register(username, v.kdf, authKey, v.wrappedVaultKey)
    v.setSync(serverUrl, username, token, { newAccount: true })
    void this.labelDevice()
    await this.syncNow()
  }

  /**
   * Signs the open vault in to an existing account: the way back after sync
   * was turned off, and the way to bring a vault that was started on its own
   * into an account. Local items are kept; see `Vault.joinAccount`.
   */
  async syncSignIn(input: AccountInput): Promise<void> {
    const v = this.p
    if (v.sync) throw new Error('Sync is already set up')
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const username = checkUsername(input.username)
    const api = new SyncApi(serverUrl)
    const kdf = await api.prelogin(username)
    const { authKey } = await deriveKeys(input.password, kdf)
    // The server checks the password first, so a wrong one changes nothing here.
    const { token, wrappedVaultKey } = await api.login(username, authKey)
    const { merged } = await v.joinAccount(kdf, wrappedVaultKey, input.password)
    // A merge changes the vault key, so a stored copy of the old one is useless.
    if (merged) await this.deviceKey.clear()
    v.setSync(serverUrl, username, token)
    this.save()
    // The vault key may have changed, so refresh the copy in the OS credential store.
    void this.applyRememberDevice().catch(() => undefined)
    void this.labelDevice()
    await this.syncNow()
  }

  /**
   * The server signed this device out. Sign in again with the master password,
   * which may have been changed on another device: in that case this device
   * adopts the account's new key material and unlocks with the new password
   * from now on.
   */
  async syncReauth(password: string): Promise<void> {
    const v = this.p
    if (!v.sync) throw new Error('Sync is not set up')
    const api = new SyncApi(v.sync.serverUrl)
    const kdf = await api.prelogin(v.sync.username)
    if (kdf.salt === v.kdf.salt) {
      const { token } = await api.login(v.sync.username, await v.authKeyFor(password))
      v.setSyncToken(token)
    } else {
      const { authKey } = await deriveKeys(password, kdf)
      const { token, wrappedVaultKey } = await api.login(v.sync.username, authKey)
      await v.adoptAccountKeys(kdf, wrappedVaultKey, password)
      v.setSyncToken(token)
    }
    this.syncState = { state: 'idle', needsSignIn: false }
    void this.labelDevice()
    await this.syncNow()
  }

  /** Tells the server this device's name, encrypted so only your devices can read it. */
  private async labelDevice(): Promise<void> {
    const v = this.vault
    if (!v?.sync) return
    await new SyncApi(v.sync.serverUrl, v.syncToken())
      .labelSession(v.sealText(this.platform.deviceName().slice(0, 64) || 'Unnamed device', 'device'))
      .catch(() => undefined) // cosmetic; the device list shows "Unnamed device"
  }

  /** How much the account stores on the sync server. Null from servers that do not say (before 0.11). */
  async syncUsage(): Promise<{ items: number; bytes: number; maxItems: number } | null> {
    const v = this.p
    if (!v.sync) return null
    try {
      return await new SyncApi(v.sync.serverUrl, v.syncToken()).usage()
    } catch (e) {
      if (e instanceof SyncError && e.status === 404) return null
      throw e
    }
  }

  async syncDevices(): Promise<DeviceView[]> {
    const v = this.p
    if (!v.sync) return []
    const sessions = await new SyncApi(v.sync.serverUrl, v.syncToken()).sessions()
    return sessions.map((s) => {
      let name = 'Unnamed device'
      try {
        if (s.label) name = v.openText(s.label, 'device')
      } catch {
        // label from before a re-key or tampered with: keep the placeholder
      }
      return { id: s.id, name, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, current: s.current }
    })
  }

  async syncRevokeDevice(id: string): Promise<void> {
    const v = this.p
    if (!v.sync) throw new Error('Sync is not set up')
    await new SyncApi(v.sync.serverUrl, v.syncToken()).revokeSession(String(id))
  }

  /**
   * Deletes the sync account on the server: every device's copy there and
   * every sign-in. This device keeps its vault, with sync turned off. Other
   * devices keep theirs too and are told they are signed out.
   */
  async syncDeleteAccount(password: string): Promise<void> {
    const v = this.p
    if (!v.sync) throw new Error('Sync is not set up')
    const authKey = await v.authKeyFor(password)
    await new SyncApi(v.sync.serverUrl, v.syncToken()).deleteAccount(authKey)
    v.clearSync()
    this.unlinkVaults(PERSONAL_ID)
    this.syncState = { state: 'idle', needsSignIn: false }
    this.save()
    this.onSnapshot(this.snapshot())
  }

  async syncDisconnect(): Promise<void> {
    const v = this.p
    if (!v.sync) return
    const api = new SyncApi(v.sync.serverUrl, v.syncToken())
    v.clearSync()
    this.unlinkVaults(PERSONAL_ID)
    this.syncState = { state: 'idle', needsSignIn: false }
    this.onSnapshot(this.snapshot())
    await api.logout().catch(() => undefined) // best effort; local state is already clean
  }

  private scheduleSync(delay: number): void {
    if (!this.vault || !this.syncing().length) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.syncNow().catch(() => undefined) // surfaced through the snapshot
    }, delay)
  }

  /** Runs a sync; concurrent callers share the in-flight run and trigger one follow-up. */
  syncDismissRollback(): void {
    this.rollback = undefined
    if (this.vault) this.onSnapshot(this.snapshot())
  }

  syncNow(): Promise<void> {
    if (this.syncRunning) {
      this.syncAgain = true
      return this.syncRunning
    }
    this.syncRunning = this.runSync().finally(() => {
      this.syncRunning = null
      if (this.syncAgain) {
        this.syncAgain = false
        this.scheduleSync(0)
      }
    })
    return this.syncRunning
  }

  private async runSync(): Promise<void> {
    const personal = this.vault
    if (!personal) return
    if (personal.sync && !this.syncState.needsSignIn) {
      try {
        await this.syncPersonal(personal)
      } catch (e) {
        // Further vaults still sync; the error is shown, and syncNow's caller gets it.
        await this.syncOthers(personal)
        throw e
      }
    }
    await this.syncOthers(personal)
  }

  private async syncPersonal(vault: Vault): Promise<void> {
    if (!vault.sync) return
    this.syncState = { state: 'syncing', needsSignIn: false }
    this.onSnapshot(this.snapshot())
    try {
      await this.finishPasswordChange(vault)
      this.noteRollback(await syncVault(vault))
      this.syncState = { state: 'idle', needsSignIn: false }
      const account = this.accountOrNull(PERSONAL_ID)
      if (account) await this.ensureKeyPair(account).catch(() => undefined) // older servers have none
    } catch (e) {
      const needsSignIn = e instanceof SyncError && e.status === 401
      this.syncState = {
        state: 'error',
        needsSignIn,
        error: needsSignIn ? 'This device was signed out. Sign in again to resume syncing.' : (e as Error).message,
      }
      throw e
    } finally {
      if (this.vault === vault) {
        this.save()
        this.onSnapshot(this.snapshot())
      }
    }
  }

  /** Every further vault that syncs, each through its own server account. One failing does not stop the rest. */
  private async syncOthers(personal: Vault): Promise<void> {
    const byServer = new Map<string, VaultEntry[]>()
    for (const entry of this.index.vaults) {
      if (!entry.serverId || !this.others.get(entry.id)?.sync) continue
      byServer.set(entry.serverId, [...(byServer.get(entry.serverId) ?? []), entry])
    }
    for (const [serverId, entries] of byServer) {
      if (serverId === PERSONAL_ID ? this.syncState.needsSignIn : this.serverState.get(serverId)?.needsSignIn) continue
      const account = this.accountOrNull(serverId)
      const token = this.tokenFor(serverId)
      if (!account || !token) continue
      try {
        // What the server says of each vault: still a member, which role, which key.
        const remote = await account.api.vaults()
        if (this.vault !== personal) return
        for (const entry of entries) {
          const r = remote.find((x) => x.id === entry.id)
          if (!r) {
            this.loseVault(entry.id)
            continue
          }
          if ((r.epoch ?? 0) !== (entry.epoch ?? 0)) await this.adoptNewKey(account, entry.id, r)
          this.updateEntry(entry.id, remoteState(r))
          const vault = this.others.get(entry.id)
          if (!vault?.sync) continue
          this.noteRollback(await syncVault(vault, undefined, token))
          if (this.vault !== personal) return
          this.saveOther(entry.id)
          // Admins seal personal logins for every admin: keep the list of them current.
          if (r.role === 'admin' && (r.members ?? 1) > 1) {
            this.memberCache.set(entry.id, await account.api.members(entry.id))
          }
        }
        if (serverId !== PERSONAL_ID) this.serverState.delete(serverId)
        // Others can add this account to a vault once it has a key pair.
        await this.ensureKeyPair(account).catch(() => undefined)
      } catch (e) {
        const needsSignIn = e instanceof SyncError && e.status === 401
        const error = needsSignIn ? 'This device was signed out. Sign in again to resume syncing.' : (e as Error).message
        if (serverId === PERSONAL_ID) this.syncState = { state: 'error', needsSignIn, error }
        else this.serverState.set(serverId, { needsSignIn, error })
      }
      if (this.vault !== personal) return
    }
    this.saveIndex()
    this.onSnapshot(this.snapshot())
  }


  private noteRollback(summary: { rolledBack: number; serverBehind: boolean }): void {
    if (!summary.rolledBack && !summary.serverBehind) return
    this.rollback = {
      at: Date.now(),
      items: summary.rolledBack + (this.rollback?.items ?? 0),
      serverBehind: summary.serverBehind || !!this.rollback?.serverBehind,
    }
  }

  // ---- shared vaults --------------------------------------------------------------

  private entryOf(vaultId: string): VaultEntry | undefined {
    return this.index.vaults.find((v) => v.id === vaultId)
  }

  private updateEntry(vaultId: string, change: Partial<VaultEntry>): void {
    this.index = { ...this.index, vaults: this.index.vaults.map((v) => (v.id === vaultId ? { ...v, ...change } : v)) }
  }

  /** A member, not an admin, of a shared vault: they connect, but cannot change it. */
  private readOnly(vaultId: string): boolean {
    const entry = this.entryOf(vaultId)
    return !!entry?.serverId && entry.role === 'member'
  }

  private writable(): void {
    void this.p // throws when locked
    if (this.readOnly(this.activeId)) throw new Error(READ_ONLY)
  }

  /** Your username on the server a vault syncs through; null for a vault that does not. */
  private memberName(vaultId: string): string | null {
    const serverId = this.entryOf(vaultId)?.serverId
    if (!serverId || vaultId === PERSONAL_ID) return null
    if (serverId === PERSONAL_ID) return this.vault?.sync?.username ?? null
    return this.index.servers?.find((x) => x.id === serverId)?.username ?? null
  }

  /** The id prefix of your own items in a shared vault (see `memberTag`). */
  private memberPrefix(vaultId: string): string {
    const me = this.memberName(vaultId)
    if (!me) throw new Error('This vault does not sync')
    return `${memberTag(me)}-`
  }

  private fingerprintOf(serverId: string): { fingerprint?: string } {
    const pair = this.keyPairs.get(serverId)
    return pair ? { fingerprint: fingerprint(pair.publicKey) } : {}
  }

  /** The account's key pair: fetched (and opened) from the server, or made and stored there the first time. */
  private async ensureKeyPair(account: Account): Promise<AccountKeyPair> {
    const cached = this.keyPairs.get(account.id)
    if (cached) return cached
    let remote: { publicKey: string | null; sealedPrivateKey: string | null }
    try {
      remote = await account.api.accountKeys()
    } catch (e) {
      if (e instanceof SyncError && e.status === 404) throw new Error(OLD_SERVER_SHARED)
      throw e
    }
    let pair: AccountKeyPair
    if (remote.publicKey && remote.sealedPrivateKey) {
      const privateKey = fromBase64(account.sealer.openText(remote.sealedPrivateKey, PRIVATE_KEY_CONTEXT))
      if (toBase64(publicKeyOf(privateKey)) !== remote.publicKey) throw new Error('This account’s key pair does not match')
      pair = { privateKey, publicKey: fromBase64(remote.publicKey) }
    } else {
      pair = generateAccountKeyPair()
      await account.api.setAccountKeys(toBase64(pair.publicKey), account.sealer.sealText(toBase64(pair.privateKey), PRIVATE_KEY_CONTEXT))
    }
    if (!this.vault) throw new Error('Vault is locked')
    this.keyPairs.set(account.id, pair)
    return pair
  }

  /** Opens text sealed for this account: with its own key, or (from another member) to its public key. */
  private async openRemoteText(account: Account, box: string, context: string): Promise<string> {
    if (!isPublicBox(box)) return account.sealer.openText(box, context)
    const pair = await this.ensureKeyPair(account)
    return fromUtf8(openWith(pair.privateKey, box, `termterm:${context}`))
  }

  /** Text sealed to another account's public key, to open with `openRemoteText`. */
  private sealFor(publicKey: string, text: string, context: string): string {
    return sealTo(fromBase64(publicKey), utf8(text), `termterm:${context}`)
  }

  /** The vault's server account, after checking the caller may manage its members. */
  private sharedVault(vaultId: string, { admin = false } = {}): { entry: VaultEntry; account: Account; vault: Vault } {
    void this.p // throws when locked
    const entry = this.entryOf(vaultId)
    const vault = this.others.get(vaultId)
    if (!entry || !vault) throw new Error('Vault not found')
    if (!entry.serverId || !vault.sync) throw new Error('Sync the vault first: it is shared through its sync server')
    if (admin && entry.role === 'member') throw new Error('Only the vault’s admins can do that')
    return { entry, account: this.account(entry.serverId), vault }
  }

  async vaultMembers(vaultId: string): Promise<MemberView[]> {
    const { entry, account, vault } = this.sharedVault(vaultId)
    let members: RemoteMember[]
    try {
      members = await account.api.members(vaultId)
    } catch (e) {
      if (e instanceof SyncError && e.status === 404 && !(await account.api.features()).includes('shared')) throw new Error(OLD_SERVER_SHARED)
      throw e
    }
    await this.ensureKeyPair(account)
    this.memberCache.set(vaultId, members)
    this.updateEntry(vaultId, { members: members.length, role: members.find((m) => m.username === account.username)?.role ?? entry.role })
    this.saveIndex()
    const keys = vault.list<MemberKeyData>('memberKey')
    return members.map((m) => {
      const key = keys.find((k) => k.data.username === m.username && k.id === `${memberTag(m.username)}-key`)
      return {
        username: m.username,
        role: m.role,
        fingerprint: m.publicKey ? fingerprint(fromBase64(m.publicKey)) : null,
        you: m.username === account.username,
        ...(key
          ? { key: { keyType: key.data.keyType, publicKey: key.data.publicKey, ...(key.data.certificate ? { certificate: key.data.certificate } : {}) } }
          : {}),
      }
    })
  }

  async lookupMember(vaultId: string, username: string): Promise<{ username: string; fingerprint: string }> {
    const { account } = this.sharedVault(vaultId, { admin: true })
    const name = checkUsername(username)
    const publicKey = await account.api.userKey(name)
    return { username: name, fingerprint: fingerprint(fromBase64(publicKey)) }
  }

  async addMember(vaultId: string, input: { username: string; role: 'admin' | 'member'; fingerprint: string }): Promise<void> {
    const { entry, account, vault } = this.sharedVault(vaultId, { admin: true })
    const username = checkUsername(input.username)
    const role = input.role === 'admin' ? 'admin' : 'member'
    const publicKey = await account.api.userKey(username)
    // The key compared on screen must be the one sealed to.
    if (fingerprint(fromBase64(publicKey)) !== input.fingerprint) {
      throw new Error(`${username}’s key changed after you compared it. Compare the fingerprint again.`)
    }
    const key = vault.exportKey()
    const wrappedKey = this.sealFor(publicKey, toBase64(key), vaultKeyContext(vaultId))
    key.fill(0)
    const meta = this.sealFor(publicKey, JSON.stringify({ name: entry.name }), vaultMetaContext(vaultId))
    await account.api.addMember(vaultId, entry.epoch ?? 0, { username, role, wrappedKey, meta })
    this.memberCache.set(vaultId, await account.api.members(vaultId))
    this.updateEntry(vaultId, { members: this.memberCache.get(vaultId)!.length })
    this.saveIndex()
    if (role === 'admin') await this.grantLogins(vaultId, username, publicKey)
    this.onSnapshot(this.snapshot())
    await this.syncNow().catch(() => undefined)
  }

  async setMemberRole(vaultId: string, username: string, role: 'admin' | 'member'): Promise<void> {
    const { account } = this.sharedVault(vaultId, { admin: true })
    const next = role === 'admin' ? 'admin' : 'member'
    await account.api.setMemberRole(vaultId, username, next)
    const members = await account.api.members(vaultId)
    this.memberCache.set(vaultId, members)
    if (username === account.username) this.updateEntry(vaultId, { role: next })
    this.saveIndex()
    const publicKey = members.find((m) => m.username === username)?.publicKey
    if (next === 'admin' && publicKey) await this.grantLogins(vaultId, username, publicKey)
    this.onSnapshot(this.snapshot())
    await this.syncNow().catch(() => undefined)
  }

  /**
   * Seals every personal login this device can open for a new admin too.
   * (Logins whose sealed key this admin was never given are left as they are.)
   */
  private async grantLogins(vaultId: string, username: string, publicKey: string): Promise<void> {
    const vault = this.others.get(vaultId)
    if (!vault) return
    for (const login of vault.list<IdentityData>('identity')) {
      const sealed = login.data.sealed
      if (!sealed || sealed.keys[username]) continue
      const loginKey = this.openLoginKey(vaultId, login.id, sealed)
      if (!loginKey) continue
      const keys = { ...sealed.keys, [username]: sealTo(fromBase64(publicKey), loginKey, loginKeyContext(login.id)) }
      loginKey.fill(0)
      vault.put('identity', { ...login.data, sealed: { ...sealed, keys } }, login.id)
    }
  }

  /**
   * Removes a member, then replaces the vault key: every item is read with the
   * old key and sealed again with a new one, the member's own items are
   * deleted and their copies of personal logins dropped, and the new key is
   * sealed for each remaining member, all in one request.
   */
  async removeMember(vaultId: string, username: string): Promise<void> {
    const { account, vault } = this.sharedVault(vaultId, { admin: true })
    if (username === account.username) throw new Error('To leave a vault, stop syncing it and delete it from the server')
    await this.syncNow().catch(() => undefined)
    if (vault.dirtyItems().length) throw new Error('This vault has changes not yet synced. Sync it first, then try again.')
    await account.api.removeMember(vaultId, username)
    await this.replaceVaultKey(vaultId, username)
  }

  private async replaceVaultKey(vaultId: string, removed: string): Promise<void> {
    const { entry, account, vault } = this.sharedVault(vaultId, { admin: true })
    const oldKey = vault.exportKey()
    const newKey = generateVaultKey()
    try {
      const items: Array<{ id: string; blob: string }> = []
      for (let since = 0; ; ) {
        const page = await account.api.vaultPull(vaultId, since)
        for (const item of page.items) items.push({ id: item.id, blob: this.resealItem(oldKey, newKey, item.id, item.blob, removed) })
        since = page.cursor
        if (!page.more) break
      }
      const members = await account.api.members(vaultId)
      const keys = members.map((m) => {
        if (m.username === account.username) return { username: m.username, wrappedKey: account.sealer.sealText(toBase64(newKey), vaultKeyContext(vaultId)) }
        if (!m.publicKey) throw new Error(`${m.username} has no key pair`)
        return { username: m.username, wrappedKey: this.sealFor(m.publicKey, toBase64(newKey), vaultKeyContext(vaultId)) }
      })
      const { epoch } = await account.api.rekeyVault(vaultId, entry.epoch ?? 0, keys, items)
      this.memberCache.set(vaultId, members)
      this.replaceLocalVault(account, vaultId, newKey, { epoch, members: members.length })
    } finally {
      oldKey.fill(0)
      newKey.fill(0)
    }
    await this.syncNow().catch(() => undefined)
  }

  /** One item, sealed again with the new key; a removed member's own items become deletions, and they lose their personal-login copies. */
  private resealItem(oldKey: Uint8Array, newKey: Uint8Array, id: string, blob: string, removed: string): string {
    const payload = Vault.openBlob(oldKey, id, blob)
    if (payload.type !== TOMBSTONE && id.startsWith(`${memberTag(removed)}-`)) {
      return Vault.sealBlob(newKey, id, { type: TOMBSTONE, updatedAt: Date.now(), data: null })
    }
    const data = payload.data as IdentityData | null
    if (payload.type === 'identity' && data?.sealed?.keys[removed]) {
      const { [removed]: _gone, ...keys } = data.sealed.keys
      return Vault.sealBlob(newKey, id, { ...payload, updatedAt: Date.now(), data: { ...data, sealed: { ...data.sealed, keys } } })
    }
    return Vault.sealBlob(newKey, id, payload)
  }

  /** Another admin replaced the vault key: open the new one, and read the vault again with it. */
  private async adoptNewKey(account: Account, vaultId: string, remote: RemoteVault): Promise<void> {
    const key = fromBase64(await this.openRemoteText(account, remote.wrappedKey, vaultKeyContext(vaultId)))
    // Changes not yet sent were sealed with the old key, which the vault no longer takes.
    this.replaceLocalVault(account, vaultId, key, { epoch: remote.epoch ?? 0 })
    key.fill(0)
  }

  private replaceLocalVault(account: Account, vaultId: string, key: Uint8Array, change: Partial<VaultEntry>): void {
    this.others.get(vaultId)?.lock()
    const vault = Vault.createWithKey(key)
    vault.setSync(account.url, account.username, '', { remoteVaultId: vaultId })
    this.attach(vaultId, vault)
    this.updateEntry(vaultId, { ...change, key: toBase64(key) })
    this.saveOther(vaultId)
    this.saveIndex()
  }

  /** You were removed (or the vault was deleted on the server): it stays here, no longer synced. */
  private loseVault(vaultId: string): void {
    this.others.get(vaultId)?.clearSync()
    this.index = { ...this.index, vaults: this.index.vaults.map((v) => (v.id === vaultId ? { ...unlinked(v), lost: true } : v)) }
    this.memberCache.delete(vaultId)
    this.saveOther(vaultId)
  }

  // ---- personal logins ----

  private savePersonalLogin(
    id: string,
    existing: Item<IdentityData> | undefined,
    input: { label: string; username: string; assignee: string; password: string | null | undefined },
  ): string {
    const vaultId = this.activeId
    const members = this.memberCache.get(vaultId)
    if (!this.memberName(vaultId) || !members) throw new Error('Personal logins are for shared vaults: open its members first')
    const assignee = members.find((m) => m.username === input.assignee)
    if (!assignee?.publicKey) throw new Error(`${input.assignee} is not a member of this vault`)
    const previous = existing?.data.sealed ? this.openLogin(vaultId, existing) : null
    if (existing?.data.sealed && !previous && input.password === undefined) {
      throw new Error('This device cannot open the login’s password: set it again')
    }
    const password = input.password === undefined ? (previous?.password ?? existing?.data.password) : input.password || undefined
    const loginKey = generateVaultKey()
    const readers = members.filter((m) => m.publicKey && (m.username === assignee.username || m.role === 'admin'))
    const sealed: SealedLogin = {
      box: seal(loginKey, utf8(JSON.stringify(password ? { password } : {})), loginContext(id)),
      keys: Object.fromEntries(readers.map((m) => [m.username, sealTo(fromBase64(m.publicKey!), loginKey, loginKeyContext(id))])),
    }
    loginKey.fill(0)
    const data: IdentityData = { label: input.label, username: input.username, assignee: assignee.username, sealed }
    return this.v.put('identity', data, id).id
  }

  private openLoginKey(vaultId: string, loginId: string, sealed: SealedLogin): Uint8Array | null {
    const me = this.memberName(vaultId)
    const serverId = this.entryOf(vaultId)?.serverId
    const pair = serverId ? this.keyPairs.get(serverId) : undefined
    const box = me ? sealed.keys[me] : undefined
    if (!pair || !box) return null
    try {
      return openWith(pair.privateKey, box, loginKeyContext(loginId))
    } catch {
      return null
    }
  }

  /** A personal login's secrets, if this account is one of its readers (and its key pair is loaded). */
  private openLogin(vaultId: string, login: Item<IdentityData>): { password?: string } | null {
    const sealed = login.data.sealed
    if (!sealed) return login.data.password ? { password: login.data.password } : {}
    const loginKey = this.openLoginKey(vaultId, login.id, sealed)
    if (!loginKey) return null
    try {
      return JSON.parse(fromUtf8(open(loginKey, sealed.box, loginContext(login.id)))) as { password?: string }
    } catch {
      return null
    } finally {
      loginKey.fill(0)
    }
  }

  // ---- your own key in a shared vault ----

  private memberKeyAccount(): { vaultId: string; me: string; account: Account; id: string } {
    const vaultId = this.activeId
    const me = this.memberName(vaultId)
    const serverId = this.entryOf(vaultId)?.serverId
    if (!me || !serverId) throw new Error('Your own key is for shared vaults')
    return { vaultId, me, account: this.account(serverId), id: `${memberTag(me)}-key` }
  }

  private putMemberKey(key: KeyData): void {
    const { vaultId, me, account, id } = this.memberKeyAccount()
    const data: MemberKeyData = {
      username: me,
      label: key.label,
      keyType: key.keyType,
      publicKey: key.publicKey,
      ...(key.certificate ? { certificate: key.certificate } : {}),
      sealedPrivate: account.sealer.sealText(
        JSON.stringify({ privateKey: key.privateKey, ...(key.passphrase ? { passphrase: key.passphrase } : {}) }),
        memberKeyContext(vaultId),
      ),
    }
    this.others.get(vaultId)!.put('memberKey', data, id)
  }

  async generateMemberKey(type: 'ed25519' | 'rsa'): Promise<void> {
    const { me } = this.memberKeyAccount()
    if (type !== 'ed25519' && type !== 'rsa') throw new Error('Unsupported key type')
    this.putMemberKey(await this.platform.keys.generate(`${me} (own key)`, type))
  }

  async importMemberKey(input: KeyImportInput): Promise<void> {
    const { me } = this.memberKeyAccount()
    const privateKey = required(input.privateKey, 'Private key', 32 * 1024)
    this.putMemberKey(await this.platform.keys.import(`${me} (own key)`, privateKey, input.passphrase))
  }

  async setMemberKeyCertificate(certificate: string | null): Promise<void> {
    const { vaultId, id } = this.memberKeyAccount()
    const vault = this.others.get(vaultId)!
    const item = vault.get<MemberKeyData>(id)
    if (item?.type !== 'memberKey') throw new Error('Set your own key first')
    const { certificate: _old, ...rest } = item.data
    const text = (certificate ?? '').trim()
    if (text) {
      if (text.length > 16 * 1024) throw new Error('This certificate is too long')
      parseCertificate(text)
      if (!certificateMatchesKey(text, item.data.publicKey)) throw new Error('This certificate is for a different key.')
    }
    vault.put('memberKey', text ? { ...rest, certificate: text } : rest, id)
  }

  async removeMemberKey(): Promise<void> {
    const { vaultId, id } = this.memberKeyAccount()
    const vault = this.others.get(vaultId)!
    if (vault.get(id)) vault.delete(id)
  }

  /** Your own key, opened for connecting; someone else's is never usable here. */
  private openMemberKey(vaultId: string, item: Item<MemberKeyData>): Item<KeyData> | undefined {
    const me = this.memberName(vaultId)
    const serverId = this.entryOf(vaultId)?.serverId
    if (!me || !serverId || item.data.username !== me || item.id !== `${memberTag(me)}-key`) return undefined
    const account = this.accountOrNull(serverId)
    if (!account) return undefined
    const secret = JSON.parse(account.sealer.openText(item.data.sealedPrivate, memberKeyContext(vaultId))) as {
      privateKey: string
      passphrase?: string
    }
    const { sealedPrivate: _s, username: _u, ...rest } = item.data
    return { ...item, type: 'key', data: { ...rest, ...secret } }
  }

  private sharedAsView(): Pick<VaultSnapshot, 'sharedAs'> {
    const vaultId = this.activeId
    const me = this.memberName(vaultId)
    const vault = this.others.get(vaultId)
    if (!me || !vault) return {}
    const key = vault.get<MemberKeyData>(`${memberTag(me)}-key`)
    return {
      sharedAs: {
        username: me,
        admin: !this.readOnly(vaultId),
        ...(key?.type === 'memberKey'
          ? {
              key: {
                keyType: key.data.keyType,
                publicKey: key.data.publicKey,
                fingerprint: fingerprintOfPublicLine(key.data.publicKey),
                ...(key.data.certificate ? { certificate: key.data.certificate } : {}),
              },
            }
          : {}),
      },
    }
  }

  // ---- further sync servers ----------------------------------------------------

  /** Every vault on this device that syncs. */
  private syncing(): Vault[] {
    const out = this.vault?.sync ? [this.vault] : []
    for (const v of this.others.values()) if (v.sync) out.push(v)
    return out
  }

  private tokenFor(serverId: string): string | null {
    if (serverId === PERSONAL_ID) return this.vault?.sync ? this.vault.syncToken() : null
    return this.index.servers?.find((x) => x.id === serverId)?.token ?? null
  }

  private accountOrNull(serverId: string): Account | null {
    if (serverId === PERSONAL_ID) {
      const p = this.vault
      if (!p?.sync) return null
      return { id: PERSONAL_ID, url: p.sync.serverUrl, username: p.sync.username, api: new SyncApi(p.sync.serverUrl, p.syncToken()), sealer: p }
    }
    const entry = this.index.servers?.find((x) => x.id === serverId)
    if (!entry) return null
    const key = fromBase64(entry.accountKey)
    const sealer = Vault.createWithKey(key)
    key.fill(0)
    return { id: entry.id, url: entry.url, username: entry.username, api: new SyncApi(entry.url, entry.token), sealer }
  }

  private account(serverId: string): Account {
    const account = this.accountOrNull(serverId)
    if (!account) throw new Error('That sync server is not connected')
    return account
  }

  private async requireVaultsFeature(api: SyncApi): Promise<void> {
    if (!(await api.features()).includes('vaults')) throw new Error(OLD_SERVER)
  }

  private serverViews(): ServerView[] {
    const vaultsOf = (serverId: string) => this.index.vaults.filter((v) => v.serverId === serverId).map((v) => v.id)
    const out: ServerView[] = []
    const ps = this.vault?.sync
    if (ps) {
      out.push({
        id: PERSONAL_ID,
        serverUrl: ps.serverUrl,
        username: ps.username,
        personal: true,
        insecure: isInsecureUrl(ps.serverUrl),
        needsSignIn: this.syncState.needsSignIn,
        ...(this.syncState.error ? { error: this.syncState.error } : {}),
        vaultIds: [PERSONAL_ID, ...vaultsOf(PERSONAL_ID)],
        ...this.fingerprintOf(PERSONAL_ID),
      })
    }
    for (const x of this.index.servers ?? []) {
      const state = this.serverState.get(x.id)
      out.push({
        id: x.id,
        serverUrl: x.url,
        username: x.username,
        personal: false,
        insecure: isInsecureUrl(x.url),
        needsSignIn: !!state?.needsSignIn,
        ...(state?.error ? { error: state.error } : {}),
        vaultIds: vaultsOf(x.id),
        ...this.fingerprintOf(x.id),
      })
    }
    return out
  }

  private syncView(serverId: string | undefined, vault: Vault): { serverId?: string; lastSyncAt?: number; pending?: number } {
    if (!serverId || !vault.sync) return {}
    return { serverId, lastSyncAt: vault.sync.lastSyncAt, pending: vault.dirtyItems().length }
  }

  /** Stops syncing every vault that used a server account (signed out, or the account was deleted). */
  private unlinkVaults(serverId: string): void {
    for (const entry of this.index.vaults) {
      if (entry.serverId !== serverId) continue
      this.others.get(entry.id)?.clearSync()
    }
    this.index = { ...this.index, vaults: this.index.vaults.map((v) => (v.serverId === serverId ? unlinked(v) : v)) }
    this.saveIndex()
  }

  async addServer(input: AccountInput & { create: boolean }): Promise<string> {
    void this.p // throws when locked
    if (!this.platform.storage.writeNamed) throw new Error('This device keeps one vault only')
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const username = checkUsername(input.username)
    const known = [
      ...(this.p.sync ? [{ url: this.p.sync.serverUrl, username: this.p.sync.username }] : []),
      ...(this.index.servers ?? []),
    ]
    if (known.some((k) => k.url === serverUrl && k.username === username)) {
      throw new Error('This device is already signed in to that account')
    }
    const api = new SyncApi(serverUrl)
    await this.requireVaultsFeature(api)
    let account: Vault
    let token: string
    if (input.create) {
      this.checkNewPassword(input.password)
      account = await Vault.create(input.password)
      token = await api.register(username, account.kdf, await account.authKeyFor(input.password), account.wrappedVaultKey)
    } else {
      const kdf = await api.prelogin(username)
      const { authKey } = await deriveKeys(input.password, kdf)
      const login = await api.login(username, authKey)
      token = login.token
      account = await Vault.fromAccount(kdf, login.wrappedVaultKey, input.password)
    }
    const key = account.exportKey()
    account.lock()
    const id = randomId()
    const entry: ServerEntry = { id, url: serverUrl, username, accountKey: toBase64(key), token }
    key.fill(0)
    this.index = { ...this.index, servers: [...(this.index.servers ?? []), entry] }
    this.saveIndex()
    this.onSnapshot(this.snapshot())
    void this.labelServerSession(id)
    return id
  }

  /** Names this device's session on a further server, as for the Personal account. */
  private async labelServerSession(serverId: string): Promise<void> {
    const account = this.accountOrNull(serverId)
    if (!account) return
    await account.api
      .labelSession(account.sealer.sealText(this.platform.deviceName().slice(0, 64) || 'Unnamed device', 'device'))
      .catch(() => undefined)
  }

  async removeServer(id: string): Promise<void> {
    void this.p // throws when locked
    if (id === PERSONAL_ID) throw new Error('Turn off sync for the Personal vault on the Sync page')
    const account = this.account(id)
    this.unlinkVaults(id)
    this.index = { ...this.index, servers: (this.index.servers ?? []).filter((x) => x.id !== id) }
    this.serverState.delete(id)
    this.saveIndex()
    this.onSnapshot(this.snapshot())
    await account.api.logout().catch(() => undefined) // best effort; this device has already forgotten it
  }

  async serverSignIn(id: string, password: string): Promise<void> {
    if (id === PERSONAL_ID) return this.syncReauth(password)
    void this.p // throws when locked
    const entry = this.index.servers?.find((x) => x.id === id)
    if (!entry) throw new Error('That sync server is not connected')
    const api = new SyncApi(entry.url)
    const kdf = await api.prelogin(entry.username)
    const { authKey } = await deriveKeys(password, kdf)
    const { token, wrappedVaultKey } = await api.login(entry.username, authKey)
    const account = await Vault.fromAccount(kdf, wrappedVaultKey, password)
    const key = account.exportKey()
    account.lock()
    this.index = {
      ...this.index,
      servers: (this.index.servers ?? []).map((x) => (x.id === id ? { ...x, token, accountKey: toBase64(key) } : x)),
    }
    key.fill(0)
    this.serverState.delete(id)
    this.saveIndex()
    void this.labelServerSession(id)
    await this.syncNow()
  }

  async serverVaults(id: string): Promise<RemoteVaultView[]> {
    const account = this.account(id)
    await this.requireVaultsFeature(account.api)
    const remote = await account.api.vaults()
    const out: RemoteVaultView[] = []
    for (const r of remote) {
      let name = 'Vault that cannot be read'
      try {
        name = (JSON.parse(await this.openRemoteText(account, r.meta, vaultMetaContext(r.id))) as { name: string }).name
      } catch {
        // sealed for another key (the account was made again): shown, but it cannot be added
      }
      out.push({ id: r.id, name, onDevice: this.others.has(r.id) })
    }
    return out
  }

  async addServerVault(serverId: string, vaultId: string): Promise<string> {
    void this.p // throws when locked
    if (!this.platform.storage.writeNamed) throw new Error('This device keeps one vault only')
    if (this.others.has(vaultId)) throw new Error('That vault is already on this device')
    if (this.index.vaults.length >= MAX_VAULTS) throw new Error(`At most ${MAX_VAULTS + 1} vaults on a device`)
    const account = this.account(serverId)
    const remote = (await account.api.vaults()).find((r) => r.id === vaultId)
    if (!remote) throw new Error('That vault is not on the server')
    let key: Uint8Array
    let name: string
    try {
      key = fromBase64(await this.openRemoteText(account, remote.wrappedKey, vaultKeyContext(vaultId)))
      name = (JSON.parse(await this.openRemoteText(account, remote.meta, vaultMetaContext(vaultId))) as { name: string }).name
    } catch {
      throw new Error('This vault cannot be opened with this account’s key')
    }
    if (this.others.has(vaultId)) throw new Error('That vault is already on this device')
    const vault = Vault.createWithKey(key)
    vault.setSync(account.url, account.username, '', { remoteVaultId: vaultId })
    const label = this.freeName(typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : 'Vault')
    const entry: VaultEntry = { id: vaultId, name: label, key: toBase64(key), serverId, ...remoteState(remote) }
    this.index = { ...this.index, vaults: [...this.index.vaults, entry] }
    key.fill(0)
    this.attach(vaultId, vault)
    this.saveOther(vaultId)
    this.saveIndex()
    this.onSnapshot(this.snapshot())
    await this.syncNow().catch(() => undefined) // shown on the Sync page
    return vaultId
  }

  /** A vault name not used on this device yet: "Work", else "Work (2)" and so on. */
  private freeName(name: string): string {
    const taken = new Set([this.index.personalName, ...this.index.vaults.map((v) => v.name)].map((n) => n.toLowerCase()))
    if (!taken.has(name.toLowerCase())) return name
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 58)} (${i})`
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
  }

  async connectVault(vaultId: string, serverId: string): Promise<void> {
    void this.p // throws when locked
    const vault = this.others.get(vaultId)
    const entry = this.index.vaults.find((v) => v.id === vaultId)
    if (!vault || !entry) throw new Error(vaultId === PERSONAL_ID ? 'The Personal vault syncs from the Sync page' : 'Vault not found')
    if (entry.serverId) throw new Error('That vault already syncs')
    const account = this.account(serverId)
    await this.requireVaultsFeature(account.api)
    const key = vault.exportKey()
    const wrappedKey = account.sealer.sealText(toBase64(key), vaultKeyContext(vaultId))
    key.fill(0)
    const meta = account.sealer.sealText(JSON.stringify({ name: entry.name }), vaultMetaContext(vaultId))
    try {
      await account.api.createVault(vaultId, wrappedKey, meta)
    } catch (e) {
      // Sent before, with the answer lost: carry on if it is this account's.
      const ours = e instanceof SyncError && e.status === 409 && (await account.api.vaults()).some((r) => r.id === vaultId)
      if (!ours) throw e
    }
    vault.setSync(account.url, account.username, '', { newAccount: true, remoteVaultId: vaultId })
    this.index = {
      ...this.index,
      vaults: this.index.vaults.map((v) => (v.id === vaultId ? { ...v, serverId, role: 'admin' as const, epoch: 0, members: 1, lost: undefined } : v)),
    }
    this.saveIndex()
    this.saveOther(vaultId)
    this.onSnapshot(this.snapshot())
    await this.syncNow().catch(() => undefined) // shown on the Sync page
  }

  async disconnectVault(vaultId: string, options: { fromServer?: boolean } = {}): Promise<void> {
    void this.p // throws when locked
    const vault = this.others.get(vaultId)
    const entry = this.index.vaults.find((v) => v.id === vaultId)
    if (!vault || !entry?.serverId) return
    if (options.fromServer) await this.leaveRemote(vaultId)
    vault.clearSync()
    this.index = { ...this.index, vaults: this.index.vaults.map((v) => (v.id === vaultId ? unlinked(v) : v)) }
    this.saveIndex()
    this.saveOther(vaultId)
    this.onSnapshot(this.snapshot())
  }

  /** Deletes a vault's copy on its server (for this account; the last member's leaving deletes it). */
  private async leaveRemote(vaultId: string): Promise<void> {
    const entry = this.index.vaults.find((v) => v.id === vaultId)
    if (!entry?.serverId) return
    try {
      await this.account(entry.serverId).api.leaveVault(vaultId)
    } catch (e) {
      if (!(e instanceof SyncError && e.status === 404)) throw e // already gone there
    }
  }
}

/** A vault entry's server-side state, from the server's list of vaults. */
function remoteState(r: RemoteVault): Partial<VaultEntry> {
  return { role: r.role === 'member' ? 'member' : 'admin', epoch: r.epoch ?? 0, ...(r.members ? { members: r.members } : {}), lost: undefined }
}

/** A vault entry no longer synced. */
function unlinked(v: VaultEntry): VaultEntry {
  const { serverId: _s, role: _r, epoch: _e, members: _m, ...rest } = v
  return rest
}

/** Commands typed in sessions to one host or shell, kept to suggest them again. */
interface HistoryData {
  /** Which host or shell: see `historyKey` in the interface. */
  key: string
  /** Oldest first, no repeats. */
  commands: string[]
}

const HISTORY_LIMIT = 500
/** Jump hosts in a row, at most: deeper chains are almost certainly a mistake. */
export const MAX_JUMPS = 5

/** Removes repeats, keeping each command's latest position. */
function dedupeKeepLast(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]!
    if (typeof c === 'string' && !seen.has(c)) {
      seen.add(c)
      out.push(c)
    }
  }
  return out.reverse()
}
