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
  /**
   * The highest sequence number this device has seen from the server, read
   * or written. A server whose newest is lower has lost history.
   */
  seenSeq?: number
  lastSyncAt?: number
  /**
   * For a vault other than the Personal one: its id on the server. Its
   * session token is the server connection's (kept in the device's list of
   * vaults), so `tokenBlob` holds an empty one.
   */
  remoteVaultId?: string
}

export interface VaultFile {
  format: 1
  kdf: KdfParams
  wrappedVaultKey: string
  /** A constant sealed with the vault key, so a stored key can be validated without the password. */
  keyCheck?: string
  items: Record<string, StoredItem>
  sync: SyncState | null
  /**
   * A master password change sent to the sync server whose answer has not
   * arrived: the new KDF and wrapped key, so the change can be finished (or
   * dropped) once the server says which it holds.
   */
  pendingRekey?: { kdf: KdfParams; wrappedVaultKey: string }
  /**
   * When each item this device has seen deleted was deleted (id -> the
   * tombstone's `updatedAt`), sealed with the vault key. With the live items'
   * own timestamps it is how far this device has seen the vault get, so an
   * older copy served later (a rollback) is recognised and refused.
   */
  deletedLog?: string
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
  /**
   * id of an `identity` item: when set, its username, password and key are
   * used instead of this host's own.
   */
  identityId?: string
  /** The group the host is listed under. Hosts with the same group name form a group. */
  group?: string
  /** Seconds between keep-alive messages; 0 turns them off. Unset: the default (20). */
  keepAlive?: number
  /** id of a `snippet` item run in the session each time it connects */
  startupSnippetId?: string
  /** Environment variables asked for when the shell starts (the server must allow them: AcceptEnv). */
  env?: Record<string, string>
  /** A colour to tell the host's tabs and panes apart (one of HOST_COLORS). */
  color?: string
  /**
   * A proxy to connect through. Used when this host is the first server
   * reached: connected to directly, or the outermost of its jump hosts.
   */
  proxy?: ProxyConfig
  /**
   * Lets the server use this vault's keys to log in onward (ssh -A), while a
   * session is open. Only for servers you trust: anyone with root there can
   * use the keys meanwhile (they never see them).
   */
  agentForward?: boolean
}

/** A SOCKS5 or HTTP (CONNECT) proxy. */
export interface ProxyConfig {
  kind: 'socks5' | 'http'
  host: string
  port: number
  username?: string
  password?: string
}

/** The colours a host can be given. */
export const HOST_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
export const DEFAULT_KEEPALIVE_SECONDS = 20

/** A login (username with a password and/or key) that several hosts can share. */
export interface IdentityData {
  label: string
  username: string
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
  /** An OpenSSH certificate for this key (the -cert.pub line), signed by a CA the servers trust. */
  certificate?: string
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
  /** Started by itself whenever the app opens the vault (on each device that can run it). */
  autoStart?: boolean
}

export interface ItemTypes {
  host: HostData
  key: KeyData
  snippet: SnippetData
  knownHost: KnownHostData
  forward: ForwardData
  identity: IdentityData
}
