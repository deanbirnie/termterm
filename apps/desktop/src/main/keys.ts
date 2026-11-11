import { utils } from 'ssh2'
import type { KeyTools } from '@termterm/app'
import type { KeyData } from '@termterm/core'

/** Reads the algorithm name out of an SSH public key blob (length-prefixed string). */
export function keyTypeOfBlob(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const len = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + len).toString('ascii') || 'unknown'
}

export function generateKey(label: string, type: 'ed25519' | 'rsa'): KeyData {
  // ssh2's generator occasionally (roughly 1 in 400 for Ed25519) emits a key
  // that its own parser rejects. Never store a key we cannot read back.
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair =
      type === 'rsa'
        ? utils.generateKeyPairSync('rsa', { bits: 4096, comment: label })
        : utils.generateKeyPairSync('ed25519', { comment: label })
    if (utils.parseKey(pair.private) instanceof Error) continue
    return {
      label,
      privateKey: pair.private,
      publicKey: pair.public,
      keyType: type === 'rsa' ? 'ssh-rsa' : 'ssh-ed25519',
    }
  }
  throw new Error('Could not generate a valid key. Try again.')
}

/** Validates a pasted private key (and passphrase) and derives its public half. */
export function importKey(label: string, privateKey: string, passphrase?: string): KeyData {
  const text = privateKey.trim() + '\n'
  const parsed = utils.parseKey(text, passphrase || undefined)
  if (parsed instanceof Error) {
    const encrypted = /encrypted|passphrase/i.test(parsed.message)
    throw new Error(
      encrypted
        ? passphrase
          ? 'Wrong passphrase for this key'
          : 'This key is encrypted. Enter its passphrase.'
        : `Not a valid private key: ${parsed.message}`,
    )
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || !key.isPrivateKey()) throw new Error('That is a public key. Paste the private key.')
  return {
    label,
    privateKey: text,
    publicKey: `${key.type} ${key.getPublicSSH().toString('base64')} ${label}`,
    keyType: key.type,
    ...(passphrase ? { passphrase } : {}),
  }
}

/** SSH key handling for the desktop app, backed by ssh2. */
export const keyTools: KeyTools = { generate: generateKey, import: importKey }
