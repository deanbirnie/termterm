/**
 * Account key pairs, for shared vaults.
 *
 * Every sync server account has an X25519 key pair. Its public key is on the
 * server for anyone signed in there to fetch; its private key is on the
 * server too, but sealed with the account's own key, so only the account's
 * devices can open it. A shared vault's key is sealed to each member's public
 * key (`sealTo`), so adding a member never needs a password or a secret
 * channel: only a check that the public key is really theirs (`fingerprint`).
 *
 * Box layout: version(2) | ephemeral public key(32) | nonce(24) | ciphertext+tag.
 * The key is HKDF-SHA256 of the X25519 shared secret, salted with both public
 * keys, so a box opens only for the recipient it was made for.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromBase64, randomBytes, toBase64, utf8 } from './bytes.ts'
import { DecryptError } from './crypto.ts'

const PUBLIC_BOX_VERSION = 2
const NONCE_LEN = 24

export interface AccountKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export function generateAccountKeyPair(): AccountKeyPair {
  const privateKey = x25519.utils.randomSecretKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey)
}

function boxKey(shared: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array {
  if (shared.every((b) => b === 0)) throw new DecryptError('Invalid public key')
  const salt = new Uint8Array(64)
  salt.set(ephemeral, 0)
  salt.set(recipient, 32)
  return hkdf(sha256, shared, salt, utf8('termterm/box'), 32)
}

/** Encrypts `plaintext` so that only the holder of `publicKey`'s private key can read it. */
export function sealTo(publicKey: Uint8Array, plaintext: Uint8Array, aad: string): string {
  if (publicKey.length !== 32) throw new Error('Invalid public key')
  const ephemeral = x25519.utils.randomSecretKey()
  const ephemeralPublic = x25519.getPublicKey(ephemeral)
  const key = boxKey(x25519.getSharedSecret(ephemeral, publicKey), ephemeralPublic, publicKey)
  const nonce = randomBytes(NONCE_LEN)
  const ct = xchacha20poly1305(key, nonce, utf8(aad)).encrypt(plaintext)
  const out = new Uint8Array(1 + 32 + NONCE_LEN + ct.length)
  out[0] = PUBLIC_BOX_VERSION
  out.set(ephemeralPublic, 1)
  out.set(nonce, 33)
  out.set(ct, 33 + NONCE_LEN)
  return toBase64(out)
}

export function openWith(privateKey: Uint8Array, box: string, aad: string): Uint8Array {
  let raw: Uint8Array
  try {
    raw = fromBase64(box)
  } catch {
    throw new DecryptError('Malformed ciphertext')
  }
  if (raw.length < 1 + 32 + NONCE_LEN + 16 || raw[0] !== PUBLIC_BOX_VERSION) throw new DecryptError('Malformed ciphertext')
  const ephemeralPublic = raw.subarray(1, 33)
  let key: Uint8Array
  try {
    key = boxKey(x25519.getSharedSecret(privateKey, ephemeralPublic), ephemeralPublic, x25519.getPublicKey(privateKey))
    return xchacha20poly1305(key, raw.subarray(33, 33 + NONCE_LEN), utf8(aad)).decrypt(raw.subarray(33 + NONCE_LEN))
  } catch {
    throw new DecryptError()
  }
}

/** Whether a box was sealed to a public key (rather than with a shared secret key). */
export function isPublicBox(box: string): boolean {
  try {
    return fromBase64(box.slice(0, 4))[0] === PUBLIC_BOX_VERSION
  } catch {
    return false
  }
}

/**
 * What two people compare to be sure a public key is the right one: the
 * first 128 bits of its SHA-256, as eight groups of four hex digits.
 */
export function fingerprint(publicKey: Uint8Array): string {
  const hex = Array.from(sha256(publicKey).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(/.{4}/g)!.join(' ')
}

/**
 * The prefix of the ids of the items a member (not an admin) may write in a
 * shared vault: their own known hosts and their own key. The server works it
 * out the same way from the member's username.
 */
export function memberTag(username: string): string {
  const hex = Array.from(sha256(utf8(`termterm-member:${username}`)).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
  return `m-${hex}`
}
