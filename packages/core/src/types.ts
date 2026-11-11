import type { KdfParams } from './crypto.ts'

/** A decrypted vault record. `type` and `data` are opaque to the vault and the server. */
export interface Item<T = unknown> {
  id: string
  type: string
  /** ms since epoch; used for last-writer-wins conflict resolution */
  updatedAt: number
  data: T
}

export const TOMBSTONE = '$tombstone'

/** How an item is stored on disk and on the server: ciphertext plus sync bookkeeping. */
export interface StoredItem {
  /** sealed JSON of { type, updatedAt, data } */
  blob: string
  /** server sequence this copy is based on; 0 = never synced */
  seq: number
  /** has local changes not yet accepted by the server */
  dirty: boolean
  deleted: boolean
}

export interface SyncState {
  serverUrl: string
  username: string
  /** session token, sealed with the vault key */
  tokenBlob: string
  cursor: number
  lastSyncAt?: number
}

export interface VaultFile {
  format: 1
  kdf: KdfParams
  wrappedVaultKey: string
  items: Record<string, StoredItem>
  sync: SyncState | null
}

// ---- Item payloads used by the apps -------------------------------------

export interface HostData {
  label: string
  address: string
  port: number
  username: string
  tags: string[]
  password?: string
  /** id of a `key` item */
  keyId?: string
}

export interface KeyData {
  label: string
  /** OpenSSH or PEM private key */
  privateKey: string
  /** OpenSSH public key line */
  publicKey: string
  keyType: string
  passphrase?: string
}

export interface SnippetData {
  label: string
  script: string
}

export interface KnownHostData {
  host: string
  port: number
  keyType: string
  /** base64 of the SSH public key blob */
  publicKey: string
  /** SHA256:... */
  fingerprint: string
}

export interface ItemTypes {
  host: HostData
  key: KeyData
  snippet: SnippetData
  knownHost: KnownHostData
}
