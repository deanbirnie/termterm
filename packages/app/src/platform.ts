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
}

/** The operating system's credential store, holding the vault key for "open unlocked". */
export interface DeviceKeyStore {
  available(): Promise<boolean>
  save(key: Uint8Array): Promise<void>
  load(): Promise<Uint8Array | null>
  clear(): void | Promise<void>
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
