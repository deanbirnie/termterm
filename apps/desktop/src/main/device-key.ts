import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

/**
 * Keeps the vault key in the operating system's credential store (DPAPI on
 * Windows, Keychain on macOS, the desktop keyring on Linux) so the vault can
 * open at launch without the master password. The file on disk holds only
 * the OS-encrypted blob.
 */
export class DeviceKeyStore {
  constructor(private readonly path: string) {
    // Automated tests run without a keyring; this opt-in makes Linux use an
    // in-memory key instead. Never set it on a real machine.
    if (process.env.TERMTERM_INSECURE_KEYSTORE === '1') safeStorage.setUsePlainTextEncryption(true)
  }

  /** Call after the app is ready. */
  async available(): Promise<boolean> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false
    if (process.platform !== 'linux') return true
    // Without a keyring, Linux falls back to a hard-coded key: that is not
    // protection, so refuse it unless the test override is set.
    const backend = safeStorage.getSelectedStorageBackend()
    return (
      (backend !== 'basic_text' && backend !== 'unknown') ||
      process.env.TERMTERM_INSECURE_KEYSTORE === '1'
    )
  }

  has(): boolean {
    return existsSync(this.path)
  }

  async save(key: Uint8Array): Promise<void> {
    if (!(await this.available())) {
      throw new Error('No secure credential store is available on this device')
    }
    const sealed = await safeStorage.encryptStringAsync(Buffer.from(key).toString('base64'))
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, sealed, { mode: 0o600 })
  }

  async load(): Promise<Uint8Array | null> {
    try {
      if (!this.has() || !(await this.available())) return null
      const { result } = await safeStorage.decryptStringAsync(readFileSync(this.path))
      return new Uint8Array(Buffer.from(result, 'base64'))
    } catch {
      return null
    }
  }

  clear(): void {
    rmSync(this.path, { force: true })
  }
}
