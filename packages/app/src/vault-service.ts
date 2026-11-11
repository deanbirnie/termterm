import {
  SyncApi,
  SyncError,
  Vault,
  deriveKeys,
  isInsecureUrl,
  normalizeServerUrl,
  syncVault,
  type HostData,
  type Item,
  type KeyData,
  type KnownHostData,
  type SnippetData,
  type VaultFile,
} from '@termterm/core'
import type {
  AccountInput,
  AppPhase,
  DeviceView,
  HostInput,
  KeyImportInput,
  SyncStatus,
  VaultSnapshot,
} from './contract.ts'
import { fingerprintOfPublicLine } from './fingerprint.ts'
import type { Platform } from './platform.ts'

const SYNC_DEBOUNCE_MS = 1500
const SYNC_INTERVAL_MS = 60_000

const byLabel = <T extends { label: string }>(a: T, b: T) => a.label.localeCompare(b.label)

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

/**
 * Owns the vault file and the unlocked vault: unlocking, editing, saving and
 * syncing. It is the same on every platform; what differs (storage, the OS
 * credential store, SSH key handling) is supplied as a `Platform`.
 */
export class VaultService {
  private vault: Vault | null = null
  private syncState: Pick<SyncStatus, 'state' | 'error' | 'needsSignIn'> = {
    state: 'idle',
    needsSignIn: false,
  }
  private syncRunning: Promise<void> | null = null
  private syncAgain = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setTimeout> | null = null
  private notifyQueued = false

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
    const data = await this.platform.storage.read()
    if (data === null) throw new Error('There is no vault on this device')
    return JSON.parse(data) as VaultFile
  }

  // ---- lifecycle -------------------------------------------------------------

  async create(password: string): Promise<void> {
    await this.assertNoVault()
    this.checkNewPassword(password)
    this.adopt(await Vault.create(password))
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
    this.adopt(vault)
    void this.labelDevice()
    await this.syncNow()
  }

  async unlock(password: string): Promise<void> {
    if (this.vault) return
    const vault = await Vault.unlock(await this.readFile(), password)
    if (!this.vault) this.adopt(vault)
  }

  /**
   * Opens the vault at launch with the key kept in the OS credential store,
   * if the user turned that on. Falls back to the password screen on any doubt.
   */
  async tryDeviceUnlock(): Promise<void> {
    await this.ready
    if (this.vault || !this.exists || !this.platform.rememberDevice()) return
    const key = await this.deviceKey.load()
    if (!key || this.vault) return
    try {
      const vault = Vault.unlockWithKey(await this.readFile(), key)
      if (!this.vault) this.adopt(vault)
    } catch {
      await this.deviceKey.clear()
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
    if (forget) void this.deviceKey.clear()
    if (!this.vault) return
    this.save()
    if (this.syncTimer) clearTimeout(this.syncTimer)
    if (this.interval) clearInterval(this.interval)
    this.syncTimer = this.interval = null
    this.vault.lock()
    this.vault = null
    this.syncState = { state: 'idle', needsSignIn: false }
    this.onPhase('locked')
  }

  async changePassword(current: string, next: string): Promise<void> {
    const v = this.v
    this.checkNewPassword(next)
    if (next === current) throw new Error('The new password is the same as the current one')
    const rekey = await v.prepareRekey(current, next)
    if (v.sync) {
      // Server first: if this fails nothing has changed anywhere.
      await new SyncApi(v.sync.serverUrl, v.syncToken()).changePassword(
        rekey.currentAuthKey,
        rekey.newAuthKey,
        rekey.kdf,
        rekey.wrappedVaultKey,
      )
    }
    v.commitRekey(rekey.kdf, rekey.wrappedVaultKey)
    this.save()
  }

  private adopt(vault: Vault): void {
    this.vault = vault
    vault.onChange(() => this.changed())
    this.save()
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

  private get v(): Vault {
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

  private changed(): void {
    // Coalesce bursts (e.g. a sync applying many items) into one save + notify.
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      if (!this.vault) return
      this.save()
      this.onSnapshot(this.snapshot())
      if (this.vault.dirtyItems().length) this.scheduleSync(SYNC_DEBOUNCE_MS)
    })
  }

  // ---- views ---------------------------------------------------------------

  snapshot(): VaultSnapshot {
    const v = this.v
    const sync = v.sync
    return {
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
        }))
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
        pending: sync ? v.dirtyItems().length : 0,
        ...this.syncState,
      },
    }
  }

  // ---- used by the SSH layer (main process only) -------------------------------

  host(id: string): Item<HostData> | undefined {
    return this.v.get<HostData>(id)
  }

  key(id: string): Item<KeyData> | undefined {
    return this.v.get<KeyData>(id)
  }

  knownHostsFor(host: string, port: number): Item<KnownHostData>[] {
    return this.v
      .list<KnownHostData>('knownHost')
      .filter((k) => k.data.host === host && k.data.port === port)
  }

  trustHostKey(entry: KnownHostData, replace: boolean): void {
    if (replace) {
      for (const old of this.knownHostsFor(entry.host, entry.port)) this.v.delete(old.id)
    }
    this.v.put('knownHost', entry)
  }

  // ---- mutations -------------------------------------------------------------

  saveHost(id: string | null, input: HostInput): string {
    const existing = id ? this.v.get<HostData>(id) : undefined
    if (id && existing?.type !== 'host') throw new Error('Host not found')
    const address = required(input.address, 'Address', 255)
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535')
    if (input.keyId && this.v.get(input.keyId)?.type !== 'key') throw new Error('Key not found')
    const password =
      input.password === undefined ? existing?.data.password : input.password || undefined
    const data: HostData = {
      label: (input.label ?? '').trim().slice(0, 128) || address,
      address,
      port,
      username: (input.username ?? '').trim().slice(0, 128),
      tags: [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 32),
      ...(password ? { password } : {}),
      ...(input.keyId ? { keyId: input.keyId } : {}),
    }
    return this.v.put('host', data, id ?? undefined).id
  }

  async generateKey(label: string, type: 'ed25519' | 'rsa'): Promise<string> {
    if (type !== 'ed25519' && type !== 'rsa') throw new Error('Unsupported key type')
    const key = await this.platform.keys.generate(required(label, 'Label', 128), type)
    return this.v.put('key', key).id
  }

  async importKey(input: KeyImportInput): Promise<string> {
    const label = required(input.label, 'Label', 128)
    const privateKey = required(input.privateKey, 'Private key', 32 * 1024)
    const key = await this.platform.keys.import(label, privateKey, input.passphrase)
    return this.v.put('key', key).id
  }

  renameKey(id: string, label: string): void {
    const key = this.v.get<KeyData>(id)
    if (key?.type !== 'key') throw new Error('Key not found')
    this.v.put('key', { ...key.data, label: required(label, 'Label', 128) }, id)
  }

  saveSnippet(id: string | null, input: { label: string; script: string }): string {
    if (id && this.v.get(id)?.type !== 'snippet') throw new Error('Snippet not found')
    const data: SnippetData = {
      label: required(input.label, 'Label', 128),
      script: required(input.script, 'Script', 64 * 1024),
    }
    return this.v.put('snippet', data, id ?? undefined).id
  }

  deleteItem(id: string): void {
    const item = this.v.get(id)
    if (!item) return
    if (item.type === 'key') {
      // Hosts must not keep pointing at a key that no longer exists.
      for (const host of this.v.list<HostData>('host')) {
        if (host.data.keyId === id) {
          const { keyId: _removed, ...rest } = host.data
          this.v.put('host', rest, host.id)
        }
      }
    }
    this.v.delete(id)
  }

  // ---- sync ------------------------------------------------------------------

  async syncRegister(input: AccountInput): Promise<void> {
    const v = this.v
    if (v.sync) throw new Error('Sync is already set up')
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const username = checkUsername(input.username)
    const authKey = await v.authKeyFor(input.password)
    const token = await new SyncApi(serverUrl).register(username, v.kdf, authKey, v.wrappedVaultKey)
    v.setSync(serverUrl, username, token)
    void this.labelDevice()
    await this.syncNow()
  }

  /**
   * Signs the open vault in to an existing account: the way back after sync
   * was turned off, and the way to bring a vault that was started on its own
   * into an account. Local items are kept; see `Vault.joinAccount`.
   */
  async syncSignIn(input: AccountInput): Promise<void> {
    const v = this.v
    if (v.sync) throw new Error('Sync is already set up')
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const username = checkUsername(input.username)
    const api = new SyncApi(serverUrl)
    const kdf = await api.prelogin(username)
    const { authKey } = await deriveKeys(input.password, kdf)
    // The server checks the password first, so a wrong one changes nothing here.
    const { token, wrappedVaultKey } = await api.login(username, authKey)
    await v.joinAccount(kdf, wrappedVaultKey, input.password)
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
    const v = this.v
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

  async syncDevices(): Promise<DeviceView[]> {
    const v = this.v
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
    const v = this.v
    if (!v.sync) throw new Error('Sync is not set up')
    await new SyncApi(v.sync.serverUrl, v.syncToken()).revokeSession(String(id))
  }

  async syncDisconnect(): Promise<void> {
    const v = this.v
    if (!v.sync) return
    const api = new SyncApi(v.sync.serverUrl, v.syncToken())
    v.clearSync()
    this.syncState = { state: 'idle', needsSignIn: false }
    this.onSnapshot(this.snapshot())
    await api.logout().catch(() => undefined) // best effort; local state is already clean
  }

  private scheduleSync(delay: number): void {
    if (!this.vault?.sync || this.syncState.needsSignIn) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.syncNow().catch(() => undefined) // surfaced through the snapshot
    }, delay)
  }

  /** Runs a sync; concurrent callers share the in-flight run and trigger one follow-up. */
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
    const vault = this.vault
    if (!vault?.sync) return
    this.syncState = { state: 'syncing', needsSignIn: false }
    this.onSnapshot(this.snapshot())
    try {
      await syncVault(vault)
      this.syncState = { state: 'idle', needsSignIn: false }
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
}
