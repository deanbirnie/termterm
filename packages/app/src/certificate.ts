import { fromBase64 } from '@termterm/core'

/** What an OpenSSH certificate says about itself. */
export interface CertificateInfo {
  /** "ssh-ed25519-cert-v01@openssh.com" and so on */
  type: string
  /** The key type it certifies: "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"... */
  keyType: string
  keyId: string
  /** The usernames it is valid for; empty means any. */
  principals: string[]
  /** ms since 1970, or null for "always" */
  validAfter: number | null
  /** ms since 1970, or null for "forever" */
  validBefore: number | null
}

const CERT_SUFFIX = '-cert-v01@openssh.com'

/** How many public-key fields each certified key type has, after the nonce. */
const KEY_FIELDS: Record<string, number> = {
  'ssh-ed25519': 1,
  'ssh-rsa': 2,
  'ecdsa-sha2-nistp256': 2,
  'ecdsa-sha2-nistp384': 2,
  'ecdsa-sha2-nistp521': 2,
}

class Reader {
  private at = 0
  constructor(private readonly bytes: Uint8Array) {}

  uint32(): number {
    if (this.at + 4 > this.bytes.length) throw new Error('truncated')
    const b = this.bytes
    const v = ((b[this.at]! << 24) | (b[this.at + 1]! << 16) | (b[this.at + 2]! << 8) | b[this.at + 3]!) >>> 0
    this.at += 4
    return v
  }

  uint64(): bigint {
    return (BigInt(this.uint32()) << 32n) | BigInt(this.uint32())
  }

  bytesField(): Uint8Array {
    const length = this.uint32()
    if (this.at + length > this.bytes.length) throw new Error('truncated')
    const out = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return out
  }

  text(): string {
    return new TextDecoder().decode(this.bytesField())
  }

  get position(): number {
    return this.at
  }
}

const NOT_A_CERT = 'This is not an OpenSSH certificate (the line from a "-cert.pub" file, starting with "ssh-ed25519-cert-v01@openssh.com" or similar).'

function blobOf(line: string): { type: string; blob: Uint8Array } {
  const [type, b64] = line.trim().split(/\s+/)
  if (!type || !b64) throw new Error(NOT_A_CERT)
  let blob: Uint8Array
  try {
    blob = fromBase64(b64)
  } catch {
    throw new Error(NOT_A_CERT)
  }
  return { type, blob }
}

/** Reads an OpenSSH user certificate line. Throws, with a reason fit to show, if it is not one. */
export function parseCertificate(line: string): CertificateInfo {
  const { type, blob } = blobOf(line)
  if (!type.endsWith(CERT_SUFFIX)) throw new Error(NOT_A_CERT)
  const keyType = type.slice(0, -CERT_SUFFIX.length)
  const fields = KEY_FIELDS[keyType]
  if (fields === undefined) throw new Error(`Certificates for ${keyType} keys are not supported`)
  try {
    const r = new Reader(blob)
    if (r.text() !== type) throw new Error(NOT_A_CERT)
    r.bytesField() // nonce
    for (let i = 0; i < fields; i++) r.bytesField()
    r.uint64() // serial
    const kind = r.uint32()
    if (kind !== 1) throw new Error('This is a host certificate; a user certificate is needed to log in.')
    const keyId = r.text()
    const principalBytes = r.bytesField()
    const principals: string[] = []
    const p = new Reader(principalBytes)
    while (p.position < principalBytes.length) principals.push(p.text())
    const after = r.uint64()
    const before = r.uint64()
    return {
      type,
      keyType,
      keyId,
      principals,
      validAfter: after === 0n ? null : Number(after) * 1000,
      validBefore: before === 0xffffffffffffffffn ? null : Number(before) * 1000,
    }
  } catch (e) {
    if (e instanceof Error && e.message !== 'truncated') throw e
    throw new Error('This certificate is damaged (it ends too soon).')
  }
}

/**
 * Whether the certificate certifies this public key (an OpenSSH public key
 * line, as the vault stores for every key): its key fields must be the same.
 */
export function certificateMatchesKey(certificate: string, publicKey: string): boolean {
  try {
    const cert = blobOf(certificate)
    const key = blobOf(publicKey)
    const c = new Reader(cert.blob)
    c.text()
    c.bytesField() // nonce
    const k = new Reader(key.blob)
    k.text()
    const fields = key.blob.subarray(k.position)
    const after = cert.blob.subarray(c.position, c.position + fields.length)
    return fields.length > 0 && after.length === fields.length && after.every((b, i) => b === fields[i])
  } catch {
    return false
  }
}

/**
 * The problem with using this certificate for this key now, in words, or null
 * if there is none.
 */
export function certificateProblem(certificate: string, publicKey: string, now = Date.now()): string | null {
  let info: CertificateInfo
  try {
    info = parseCertificate(certificate)
  } catch (e) {
    return (e as Error).message
  }
  if (!certificateMatchesKey(certificate, publicKey)) return 'This certificate is for a different key.'
  if (info.validBefore !== null && info.validBefore < now) return `This certificate expired on ${new Date(info.validBefore).toLocaleString()}.`
  if (info.validAfter !== null && info.validAfter > now) return `This certificate is not valid until ${new Date(info.validAfter).toLocaleString()}.`
  return null
}
