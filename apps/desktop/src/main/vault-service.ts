import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
  HostInput,
  KeyImportInput,
  SyncStatus,
  VaultSnapshot,
} from '../shared/api'
import { fingerprintOfPublicLine, generateKey, importKey } from './keys'

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
 * Owns the vault file and the unlocked vault. Everything that touches secrets
 * lives in the main process behind this class.
 */
export class VaultService {
  private vault: Vault | null = null
  private syncState: Pick<SyncStatus, 'state' | 'error' | 'needsSignIn'> = {
    state: 'idle',
    needsSignIn: false,
  }
  private syncRunning: Promise<void> | null = null
  private syncAgain = false
  private syncTimer: NodeJS.Timeout | null = null
  private interval: NodeJS.Timeout | null = null
  private notifyQueued = false

  constructor(
    private readonly path: string,
    private readonly onSnapshot: (snapshot: VaultSnapshot) => void,
    private readonly onPhase: (phase: AppPhase) => void,
  ) {}

  phase(): AppPhase {
    if (this.vault) return 'unlocked'
    return existsSync(this.path) ? 'locked' : 'new'
  }

  // ---- lifecycle -------------------------------------------------------------

  async create(password: string): Promise<void> {
    if (existsSync(this.path)) throw new Error('A vault already exists on this device')
    this.checkNewPassword(password)
    this.adopt(await Vault.create(password))
  }

  async signIn(input: AccountInput): Promise<void> {
    if (existsSync(this.path)) throw new Error('A vault already exists on this device')
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const username = checkUsername(input.username)
    const api = new SyncApi(serverUrl)
    const kdf = await api.prelogin(username)
    const { authKey } = await deriveKeys(input.password, kdf)
    const { token, wrappedVaultKey } = await api.login(username, authKey)
    const vault = await Vault.fromAccount(kdf, wrappedVaultKey, input.password)
    vault.setSync(serverUrl, username, token)
    this.adopt(vault)
    await this.syncNow()
  }

  async unlock(password: string): Promise<void> {
    if (this.vault) return
    const file = JSON.parse(readFileSync(this.path, 'utf8')) as VaultFile
    this.adopt(await Vault.unlock(file, password))
  }

  lock(): void {
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

  /** Write-then-rename so a crash mid-write cannot corrupt the vault. */
  private save(): void {
    if (!this.vault) return
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.vault.toFile()), { mode: 0o600 })
    renameSync(tmp, this.path)
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

  generateKey(label: string, type: 'ed25519' | 'rsa'): string {
    if (type !== 'ed25519' && type !== 'rsa') throw new Error('Unsupported key type')
    return this.v.put('key', generateKey(required(label, 'Label', 128), type)).id
  }

  importKey(input: KeyImportInput): string {
    const label = required(input.label, 'Label', 128)
    const privateKey = required(input.privateKey, 'Private key', 32 * 1024)
    return this.v.put('key', importKey(label, privateKey, input.passphrase)).id
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
    await this.syncNow()
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
