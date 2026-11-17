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
  type KeyData,
  type KnownHostData,
  type SnippetData,
  type VaultFile,
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
  SshImportFiles,
  SshImportPreview,
  SshImportResult,
  SyncStatus,
  VaultSnapshot,
} from './contract.ts'
import { fingerprintOfPublicLine } from './fingerprint.ts'
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

/**
 * Owns the vault file and the unlocked vault: unlocking, editing, saving and
 * syncing. It is the same on every platform; what differs (storage, the OS
 * credential store, SSH key handling) is supplied as a `Platform`.
 */
export class VaultService {
  private vault: Vault | null = null
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
    if (!this.vault) this.adopt(vault)
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
      if (!this.vault) this.adopt(vault)
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
      if (!this.vault) this.adopt(vault)
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
          jumpHostId: data.jumpHostId,
          identityId: data.identityId,
          group: data.group,
          keepAlive: data.keepAlive,
          startupSnippetId: data.startupSnippetId,
          env: data.env,
          color: data.color,
        }))
        .sort(byLabel),
      identities: v
        .list<IdentityData>('identity')
        .map(({ id, data }) => ({
          id,
          label: data.label,
          username: data.username,
          hasPassword: !!data.password,
          keyId: data.keyId,
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
    const host = this.v.get<HostData>(id)
    if (host?.type !== 'host' || !host.data.identityId) return host
    const identity = this.v.get<IdentityData>(host.data.identityId)
    if (identity?.type !== 'identity') return host
    const { password: _p, keyId: _k, ...own } = host.data
    const { username, password, keyId } = identity.data
    return {
      ...host,
      data: { ...own, username: username || own.username, ...(password ? { password } : {}), ...(keyId ? { keyId } : {}) },
    }
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

  saveIdentity(id: string | null, input: IdentityInput): string {
    const existing = id ? this.v.get<IdentityData>(id) : undefined
    if (id && existing?.type !== 'identity') throw new Error('Identity not found')
    if (input.keyId && this.v.get(input.keyId)?.type !== 'key') throw new Error('Key not found')
    const username = required(input.username, 'Username', 128)
    const password = input.password === undefined ? existing?.data.password : input.password || undefined
    const data: IdentityData = {
      label: (input.label ?? '').trim().slice(0, 128) || username,
      username,
      ...(password ? { password } : {}),
      ...(input.keyId ? { keyId: input.keyId } : {}),
    }
    return this.v.put('identity', data, id ?? undefined).id
  }

  renameGroup(from: string, to: string): void {
    const name = String(to ?? '').trim().slice(0, 64)
    for (const host of this.v.list<HostData>('host')) {
      if (host.data.group !== from) continue
      const { group: _old, ...rest } = host.data
      this.v.put('host', name ? { ...rest, group: name } : rest, host.id)
    }
  }

  deleteItem(id: string): void {
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
    if (add.length === 0) return
    const items = this.historyItems(historyKey)
    const merged = dedupeKeepLast([...items.flatMap((i) => i.data.commands), ...add]).slice(-HISTORY_LIMIT)
    const [keep, ...extra] = items
    this.v.put<HistoryData>('history', { key: historyKey, commands: merged }, keep?.id)
    for (const item of extra) this.v.delete(item.id)
  }

  clearCommandHistory(): void {
    for (const item of this.v.list<HistoryData>('history')) this.v.delete(item.id)
  }

  private historyItems(key: string) {
    return this.v
      .list<HistoryData>('history')
      .filter((i) => i.data?.key === key && Array.isArray(i.data.commands))
  }

  // ---- sync ------------------------------------------------------------------

  async syncRegister(input: AccountInput): Promise<void> {
    const v = this.v
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
    const v = this.v
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

  /** How much the account stores on the sync server. Null from servers that do not say (before 0.11). */
  async syncUsage(): Promise<{ items: number; bytes: number; maxItems: number } | null> {
    const v = this.v
    if (!v.sync) return null
    try {
      return await new SyncApi(v.sync.serverUrl, v.syncToken()).usage()
    } catch (e) {
      if (e instanceof SyncError && e.status === 404) return null
      throw e
    }
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

  /**
   * Deletes the sync account on the server: every device's copy there and
   * every sign-in. This device keeps its vault, with sync turned off. Other
   * devices keep theirs too and are told they are signed out.
   */
  async syncDeleteAccount(password: string): Promise<void> {
    const v = this.v
    if (!v.sync) throw new Error('Sync is not set up')
    const authKey = await v.authKeyFor(password)
    await new SyncApi(v.sync.serverUrl, v.syncToken()).deleteAccount(authKey)
    v.clearSync()
    this.syncState = { state: 'idle', needsSignIn: false }
    this.save()
    this.onSnapshot(this.snapshot())
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
    const vault = this.vault
    if (!vault?.sync) return
    this.syncState = { state: 'syncing', needsSignIn: false }
    this.onSnapshot(this.snapshot())
    try {
      await this.finishPasswordChange(vault)
      const summary = await syncVault(vault)
      if (summary.rolledBack || summary.serverBehind) {
        this.rollback = {
          at: Date.now(),
          items: summary.rolledBack + (this.rollback?.items ?? 0),
          serverBehind: summary.serverBehind || !!this.rollback?.serverBehind,
        }
      }
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
