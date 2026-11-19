import type { KeyData } from '@termterm/core'

/**
 * What the shared app logic needs from the device it runs on. The desktop app
 * implements these with Node and Electron; the mobile app with Capacitor.
 */

/** Durable storage for the encrypted vault file. */
export interface VaultStorage {
  /** The stored vault JSON, or null if there is none yet. */
  read(): Promise<string | null>
  /** Must not leave a half-written file behind if interrupted. */
  write(data: string): Promise<void>
  /**
   * Further files beside the vault (other vaults, and their list), by name:
   * lowercase letters, digits and dashes. A platform without them holds one
   * vault only.
   */
  readNamed?(name: string): Promise<string | null>
  writeNamed?(name: string, data: string): Promise<void>
  removeNamed?(name: string): Promise<void>
}

/** A name `VaultStorage` accepts for a further file. */
export const STORAGE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The operating system's credential store, holding the vault key for "open unlocked". */
export interface DeviceKeyStore {
  available(): Promise<boolean>
  save(key: Uint8Array): Promise<void>
  load(): Promise<Uint8Array | null>
  clear(): void | Promise<void>
  /** Whether a key is currently stored. */
  has?(): boolean | Promise<boolean>
  /**
   * True when releasing the key needs the user to be present (a fingerprint
   * or face check), as on a phone. Such a key is never used silently at
   * launch, is kept when the vault locks (the check is the protection), and
   * is only written when missing, since writing it prompts too.
   */
  readonly userPresence?: boolean
}

/** SSH key handling, which depends on the platform's SSH library. */
export interface KeyTools {
  generate(label: string, type: 'ed25519' | 'rsa'): KeyData | Promise<KeyData>
  /** Validates a private key (and passphrase) and derives its public half. Throws a user-facing error. */
  import(label: string, privateKey: string, passphrase?: string): KeyData | Promise<KeyData>
}

export interface Platform {
  storage: VaultStorage
  deviceKey: DeviceKeyStore
  keys: KeyTools
  /** Shown to the user's other devices (encrypted) in the device list. */
  deviceName(): string
  /** The user's "open unlocked on this device" setting. */
  rememberDevice(): boolean
}
