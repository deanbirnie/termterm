/**
 * The vault key, locked by a key that only a "prove it is you" check can use.
 *
 * Here that check is Windows Hello. Its key lives in the computer's security
 * chip and signs only after a face, fingerprint or PIN check. The vault key is
 * encrypted with a key derived from the signature of a random challenge;
 * Windows Hello keys sign deterministically (RSA, PKCS#1 v1.5), so signing the
 * same challenge later gives the same signature and the same key. The file on
 * disk holds only the challenge and the ciphertext, which are useless without
 * the security chip and the user.
 *
 * The signing itself is behind `HelloSigner`, so this logic is testable
 * without Windows.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DeviceKeyStore } from '@termterm/app'

export interface HelloSigner {
  supported(): Promise<boolean>
  /** Creates or replaces the signing key. May prompt. */
  create(): Promise<void>
  /** Signs with the key. Prompts. Throws HelloCancelled or HelloKeyMissing. */
  sign(challenge: Buffer): Promise<Buffer>
  remove(): Promise<void>
}

/** The user dismissed the prompt. The message is what the interface stays quiet about. */
export class HelloCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'HelloCancelled'
  }
}

/** The signing key is gone (for example Windows Hello was reset). */
export class HelloKeyMissing extends Error {
  constructor() {
    super('The Windows Hello key is missing')
    this.name = 'HelloKeyMissing'
  }
}

interface StoredKey {
  version: 1
  challenge: string
  iv: string
  data: string
  tag: string
}

const INFO = Buffer.from('termterm/windows-hello/v1')
const SET_UP_AGAIN = 'Windows Hello unlock needs setting up again. Use your master password.'

function wrapKey(signature: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', signature, Buffer.alloc(0), INFO, 32))
}

export class HelloKeyStore implements DeviceKeyStore {
  readonly userPresence = true
  private supportedCheck: Promise<boolean> | undefined

  constructor(
    private readonly path: string,
    private readonly signer: HelloSigner,
  ) {}

  available(): Promise<boolean> {
    // Asking Windows takes a moment, and the answer does not change while running.
    this.supportedCheck ??= this.signer.supported().catch(() => false)
    return this.supportedCheck
  }

  has(): boolean {
    return existsSync(this.path)
  }

  async save(key: Uint8Array): Promise<void> {
    await this.signer.create()
    const challenge = randomBytes(32)
    const secret = wrapKey(await this.signer.sign(challenge))
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secret, iv)
    const data = Buffer.concat([cipher.update(key), cipher.final()])
    secret.fill(0)
    const stored: StoredKey = {
      version: 1,
      challenge: challenge.toString('base64'),
      iv: iv.toString('base64'),
      data: data.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  async load(): Promise<Uint8Array | null> {
    if (!this.has()) return null
    let stored: StoredKey
    try {
      stored = JSON.parse(readFileSync(this.path, 'utf8')) as StoredKey
      if (stored.version !== 1) throw new Error('unknown version')
    } catch {
      this.clear()
      throw new Error(SET_UP_AGAIN)
    }

    let signature: Buffer
    try {
      signature = await this.signer.sign(Buffer.from(stored.challenge, 'base64'))
    } catch (e) {
      if (e instanceof HelloKeyMissing) {
        this.clear()
        throw new Error(SET_UP_AGAIN)
      }
      throw e // cancelled, locked out, or a passing failure: keep the key for next time
    }

    const secret = wrapKey(signature)
    try {
      const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(stored.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
      const key = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()])
      return new Uint8Array(key)
    } catch {
      // A different signature: the Windows Hello key was replaced since this was stored.
      this.clear()
      throw new Error(SET_UP_AGAIN)
    } finally {
      secret.fill(0)
    }
  }

  clear(): void {
    const had = this.has()
    rmSync(this.path, { force: true })
    if (had) void this.signer.remove().catch(() => undefined)
  }
}
