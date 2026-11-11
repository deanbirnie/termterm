import { sha256 } from '@noble/hashes/sha2.js'
import { fromBase64, toBase64 } from '@termterm/core'

/** OpenSSH-style SHA256 fingerprint of a public key blob. */
export const fingerprintOf = (publicKeyBlob: Uint8Array): string =>
  `SHA256:${toBase64(sha256(publicKeyBlob)).replace(/=+$/, '')}`

/** Fingerprint of an OpenSSH public key line ("ssh-ed25519 AAAA... comment"). */
export function fingerprintOfPublicLine(line: string): string {
  try {
    return fingerprintOf(fromBase64(line.trim().split(/\s+/)[1] ?? ''))
  } catch {
    return 'SHA256:(unreadable)'
  }
}

/** Reads the algorithm name ("ssh-ed25519", ...) from the start of a public key blob. */
export function keyTypeOfBlob(blob: Uint8Array): string {
  if (blob.length < 4) return 'unknown'
  const length = ((blob[0]! << 24) | (blob[1]! << 16) | (blob[2]! << 8) | blob[3]!) >>> 0
  if (length === 0 || length > blob.length - 4) return 'unknown'
  return String.fromCharCode(...blob.subarray(4, 4 + length))
}
