/**
 * Vault cryptography.
 *
 *   master password --Argon2id(salt)--> master key (never stored, never sent)
 *   master key --HKDF("termterm/wrap")--> wrap key  (encrypts the vault key)
 *   master key --HKDF("termterm/auth")--> auth key  (proves identity to the sync server)
 *
 * The vault key is 32 random bytes and encrypts every item. The server only
 * ever sees the auth key, the wrapped vault key and item ciphertext, none of
 * which let it read the vault.
 *
 * Sealed box layout: version(1) | nonce(24) | XChaCha20-Poly1305 ciphertext+tag.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { argon2id } from 'hash-wasm'
import { fromBase64, randomBytes, toBase64, utf8 } from './bytes.ts'

export interface KdfParams {
  alg: 'argon2id'
  /** base64, 16 bytes */
  salt: string
  /** memory in KiB */
  m: number
  /** iterations */
  t: number
  /** parallelism */
  p: number
}

export const DEFAULT_KDF = { alg: 'argon2id', m: 64 * 1024, t: 3, p: 1 } as const

/** Bounds accepted from a (possibly hostile) server or vault file. */
const KDF_LIMITS = { mMin: 19 * 1024, mMax: 1024 * 1024, tMin: 2, tMax: 16, pMin: 1, pMax: 8 }

const BOX_VERSION = 1
const NONCE_LEN = 24
const KEY_LEN = 32

export class DecryptError extends Error {
  constructor(message = 'Decryption failed') {
    super(message)
    this.name = 'DecryptError'
  }
}

export function newKdfParams(): KdfParams {
  return { ...DEFAULT_KDF, salt: toBase64(randomBytes(16)) }
}

export function validateKdfParams(kdf: unknown): asserts kdf is KdfParams {
  const k = kdf as Partial<KdfParams> | null
  const int = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
  if (
    !k ||
    k.alg !== 'argon2id' ||
    typeof k.salt !== 'string' ||
    !int(k.m, KDF_LIMITS.mMin, KDF_LIMITS.mMax) ||
    !int(k.t, KDF_LIMITS.tMin, KDF_LIMITS.tMax) ||
    !int(k.p, KDF_LIMITS.pMin, KDF_LIMITS.pMax)
  ) {
    throw new Error('Unsupported or unsafe key derivation parameters')
  }
  if (fromBase64(k.salt).length < 16) throw new Error('Key derivation salt is too short')
}

export interface DerivedKeys {
  wrapKey: Uint8Array
  authKey: Uint8Array
}

export async function deriveKeys(password: string, kdf: KdfParams): Promise<DerivedKeys> {
  validateKdfParams(kdf)
  const masterKey = await argon2id({
    password: password.normalize('NFKC'),
    salt: fromBase64(kdf.salt),
    memorySize: kdf.m,
    iterations: kdf.t,
    parallelism: kdf.p,
    hashLength: KEY_LEN,
    outputType: 'binary',
  })
  try {
    return {
      wrapKey: hkdf(sha256, masterKey, undefined, utf8('termterm/wrap'), KEY_LEN),
      authKey: hkdf(sha256, masterKey, undefined, utf8('termterm/auth'), KEY_LEN),
    }
  } finally {
    masterKey.fill(0)
  }
}

export function generateVaultKey(): Uint8Array {
  return randomBytes(KEY_LEN)
}

/** Encrypts `plaintext`; `aad` binds the box to its context (e.g. the item id). */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): string {
  const nonce = randomBytes(NONCE_LEN)
  const ct = xchacha20poly1305(key, nonce, utf8(aad)).encrypt(plaintext)
  const out = new Uint8Array(1 + NONCE_LEN + ct.length)
  out[0] = BOX_VERSION
  out.set(nonce, 1)
  out.set(ct, 1 + NONCE_LEN)
  return toBase64(out)
}

export function open(key: Uint8Array, box: string, aad: string): Uint8Array {
  let raw: Uint8Array
  try {
    raw = fromBase64(box)
  } catch {
    throw new DecryptError('Malformed ciphertext')
  }
  if (raw.length < 1 + NONCE_LEN + 16 || raw[0] !== BOX_VERSION) {
    throw new DecryptError('Malformed ciphertext')
  }
  try {
    return xchacha20poly1305(key, raw.subarray(1, 1 + NONCE_LEN), utf8(aad)).decrypt(
      raw.subarray(1 + NONCE_LEN),
    )
  } catch {
    throw new DecryptError()
  }
}

export const VAULT_KEY_AAD = 'termterm:vaultkey'
export const itemAad = (id: string) => `termterm:item:${id}`
