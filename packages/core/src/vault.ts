import { fromUtf8, randomId, utf8 } from './bytes.ts'
import {
  DecryptError,
  VAULT_KEY_AAD,
  deriveKeys,
  generateVaultKey,
  itemAad,
  newKdfParams,
  open,
  seal,
  type KdfParams,
} from './crypto.ts'
import { TOMBSTONE, type Item, type StoredItem, type SyncState, type VaultFile } from './types.ts'

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect master password')
    this.name = 'WrongPasswordError'
  }
}

interface Payload {
  type: string
  updatedAt: number
  data: unknown
}

/**
 * An unlocked vault. Holds the vault key and a decrypted view of the items in
 * memory; `toFile()` yields the encrypted form for disk. All mutation goes
 * through here so every change is re-encrypted and flagged for sync.
 */
export class Vault {
  private cache = new Map<string, Item>()
  private listeners = new Set<() => void>()

  private constructor(
    private file: VaultFile,
    private vaultKey: Uint8Array,
  ) {
    for (const [id, stored] of Object.entries(file.items)) {
      if (stored.deleted) continue
      const p = this.openPayload(id, stored.blob)
      this.cache.set(id, { id, type: p.type, updatedAt: p.updatedAt, data: p.data })
    }
  }

  static async create(password: string): Promise<Vault> {
    const kdf = newKdfParams()
    const { wrapKey } = await deriveKeys(password, kdf)
    const vaultKey = generateVaultKey()
    const file: VaultFile = {
      format: 1,
      kdf,
      wrappedVaultKey: seal(wrapKey, vaultKey, VAULT_KEY_AAD),
      items: {},
      sync: null,
    }
    return new Vault(file, vaultKey)
  }

  static async unlock(file: VaultFile, password: string): Promise<Vault> {
    if (file.format !== 1) throw new Error(`Unsupported vault format: ${String(file.format)}`)
    const { wrapKey } = await deriveKeys(password, file.kdf)
    let vaultKey: Uint8Array
    try {
      vaultKey = open(wrapKey, file.wrappedVaultKey, VAULT_KEY_AAD)
    } catch (e) {
      if (e instanceof DecryptError) throw new WrongPasswordError()
      throw e
    }
    return new Vault(structuredClone(file), vaultKey)
  }

  /** Builds an empty local vault for an existing sync account (new device sign-in). */
  static async fromAccount(
    kdf: KdfParams,
    wrappedVaultKey: string,
    password: string,
  ): Promise<Vault> {
    return Vault.unlock({ format: 1, kdf, wrappedVaultKey, items: {}, sync: null }, password)
  }

  /** Re-derives the auth key, verifying the password against this vault first. */
  async authKeyFor(password: string): Promise<Uint8Array> {
    const { wrapKey, authKey } = await deriveKeys(password, this.file.kdf)
    try {
      open(wrapKey, this.file.wrappedVaultKey, VAULT_KEY_AAD)
    } catch {
      throw new WrongPasswordError()
    }
    return authKey
  }

  get kdf(): KdfParams {
    return this.file.kdf
  }

  get wrappedVaultKey(): string {
    return this.file.wrappedVaultKey
  }

  toFile(): VaultFile {
    return structuredClone(this.file)
  }

  /** Wipes key material; the instance is unusable afterwards. */
  lock(): void {
    this.vaultKey.fill(0)
    this.cache.clear()
    this.listeners.clear()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  // ---- items ---------------------------------------------------------------

  list<T = unknown>(type?: string): Item<T>[] {
    const all = [...this.cache.values()] as Item<T>[]
    return type ? all.filter((i) => i.type === type) : all
  }

  get<T = unknown>(id: string): Item<T> | undefined {
    return this.cache.get(id) as Item<T> | undefined
  }

  put<T>(type: string, data: T, id: string = randomId()): Item<T> {
    if (type === TOMBSTONE) throw new Error('Reserved item type')
    const existing = this.cache.get(id)
    if (existing && existing.type !== type) throw new Error('Item type cannot change')
    const item: Item<T> = { id, type, updatedAt: this.nextTimestamp(id), data }
    this.file.items[id] = {
      blob: this.sealPayload(id, item),
      seq: this.file.items[id]?.seq ?? 0,
      dirty: true,
      deleted: false,
    }
    this.cache.set(id, item)
    this.emit()
    return item
  }

  delete(id: string): void {
    const stored = this.file.items[id]
    if (!stored || stored.deleted) return
    this.cache.delete(id)
    if (stored.seq === 0 && !this.file.sync) {
      // Never left this device and nothing to sync with: no tombstone needed.
      delete this.file.items[id]
    } else {
      this.file.items[id] = {
        blob: this.sealPayload(id, { type: TOMBSTONE, updatedAt: this.nextTimestamp(id), data: null }),
        seq: stored.seq,
        dirty: true,
        deleted: true,
      }
    }
    this.emit()
  }

  /** Strictly increasing per item so a later local edit always wins over the one it replaced. */
  private nextTimestamp(id: string): number {
    const prev = this.cache.get(id)?.updatedAt ?? 0
    return Math.max(Date.now(), prev + 1)
  }

  private sealPayload(id: string, p: Payload): string {
    const { type, updatedAt, data } = p
    return seal(this.vaultKey, utf8(JSON.stringify({ type, updatedAt, data })), itemAad(id))
  }

  private openPayload(id: string, blob: string): Payload {
    const p = JSON.parse(fromUtf8(open(this.vaultKey, blob, itemAad(id)))) as Payload
    if (typeof p.type !== 'string' || typeof p.updatedAt !== 'number') {
      throw new DecryptError('Malformed item')
    }
    return p
  }

  // ---- sync bookkeeping (used by SyncClient) ---------------------------------

  get sync(): SyncState | null {
    return this.file.sync
  }

  setSync(serverUrl: string, username: string, token: string): void {
    this.file.sync = {
      serverUrl,
      username,
      tokenBlob: seal(this.vaultKey, utf8(token), 'termterm:token'),
      cursor: 0,
    }
    // Deletions made before sync existed left no tombstones, and everything
    // else must be offered to the new server.
    for (const stored of Object.values(this.file.items)) {
      stored.seq = 0
      stored.dirty = true
    }
    this.emit()
  }

  clearSync(): void {
    this.file.sync = null
    for (const [id, stored] of Object.entries(this.file.items)) {
      if (stored.deleted) delete this.file.items[id]
    }
    this.emit()
  }

  syncToken(): string {
    if (!this.file.sync) throw new Error('Sync is not configured')
    return fromUtf8(open(this.vaultKey, this.file.sync.tokenBlob, 'termterm:token'))
  }

  setCursor(cursor: number): void {
    if (this.file.sync) {
      this.file.sync.cursor = cursor
      this.file.sync.lastSyncAt = Date.now()
    }
  }

  dirtyItems(): Array<{ id: string } & StoredItem> {
    return Object.entries(this.file.items)
      .filter(([, s]) => s.dirty)
      .map(([id, s]) => ({ id, ...s }))
  }

  /** The server accepted our copy of `id` (identified by `blob`) at `seq`. */
  markSynced(id: string, blob: string, seq: number): void {
    const stored = this.file.items[id]
    if (!stored) return
    stored.seq = seq
    // If the item was edited while the push was in flight, keep it dirty.
    if (stored.blob !== blob) return
    if (stored.deleted) delete this.file.items[id]
    else stored.dirty = false
  }

  /**
   * Merges a server copy into the vault. Returns true if local state changed.
   * A clean local copy is simply replaced; a dirty one is resolved
   * last-writer-wins on the encrypted `updatedAt`. When local wins it is
   * rebased onto the server's sequence so the next push is accepted.
   */
  applyRemote(remote: { id: string; seq: number; blob: string }): boolean {
    const { id, seq, blob } = remote
    const local = this.file.items[id]
    if (local && local.blob === blob) {
      local.seq = seq
      return false
    }
    // Throws DecryptError if the server tampered with or misrouted the blob.
    const incoming = this.openPayload(id, blob)

    if (local?.dirty) {
      const mine = this.openPayload(id, local.blob)
      if (mine.updatedAt >= incoming.updatedAt) {
        local.seq = seq
        return false
      }
    } else if (local && seq <= local.seq) {
      return false // stale replay of something we already have
    }

    if (incoming.type === TOMBSTONE) {
      delete this.file.items[id]
      this.cache.delete(id)
    } else {
      this.file.items[id] = { blob, seq, dirty: false, deleted: false }
      this.cache.set(id, {
        id,
        type: incoming.type,
        updatedAt: incoming.updatedAt,
        data: incoming.data,
      })
    }
    this.emit()
    return true
  }
}
