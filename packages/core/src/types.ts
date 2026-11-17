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
  /** A constant sealed with the vault key, so a stored key can be validated without the password. */
  keyCheck?: string
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
  /** id of another `host` item to connect through (ssh's ProxyJump) */
  jumpHostId?: string
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

/**
 * A port forward through a saved host. `local`: a port on this computer
 * reaches dest through the server (ssh -L). `remote`: a port on the server
 * reaches dest from this computer (ssh -R). `dynamic`: a SOCKS proxy on this
 * computer that goes out through the server (ssh -D); it has no dest.
 */
export interface ForwardData {
  label: string
  /** id of the `host` item to forward through */
  hostId: string
  kind: 'local' | 'remote' | 'dynamic'
  /** Where to listen: on this computer (local, dynamic) or on the server (remote). */
  bindHost: string
  bindPort: number
  destHost?: string
  destPort?: number
}

export interface ItemTypes {
  host: HostData
  key: KeyData
  snippet: SnippetData
  knownHost: KnownHostData
  forward: ForwardData
}
