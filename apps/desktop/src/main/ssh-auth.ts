/**
 * Two things ssh2 does not do on its own, both checked against OpenSSH:
 *
 * - Logging in with an OpenSSH user certificate. ssh2 sends one algorithm
 *   name both in the request and inside the signature, but for a certificate
 *   they differ ("ssh-ed25519-cert-v01@openssh.com" asks, "ssh-ed25519"
 *   signs), so OpenSSH refuses it. `useCertificates` replaces that one step
 *   on a connection for certificate keys only.
 * - Agent forwarding (ssh -A) from the vault: `VaultAgent` answers the
 *   server's agent requests itself, with the vault's keys and certificates.
 *   The keys never leave this computer; the server only gets signatures.
 */
import { createRequire } from 'node:module'
import { Duplex } from 'node:stream'
import type { Client, ParsedKey } from 'ssh2'

const load = createRequire(import.meta.url)
// Loaded the same way as its helpers below, so this also runs outside the bundle (in tests).
const { BaseAgent, utils } = load('ssh2') as typeof import('ssh2')
// ssh2's own helpers for the packet it would otherwise build itself.
const { convertSignature, sendPacket } = load('ssh2/lib/protocol/utils.js') as {
  convertSignature(signature: Buffer, keyType: string): Buffer | false
  sendPacket(protocol: unknown, packet: Buffer): void
}

const USERAUTH_REQUEST = 50
const CERT_SUFFIX = '-cert-v01@openssh.com'
const SIGNATURE_ALGO = Symbol('signatureAlgo')
const KEY_TYPE = Symbol('keyType')

/** A parsed private key that presents an OpenSSH certificate instead of its public key. */
type CertificateKey = ParsedKey & { [SIGNATURE_ALGO]: string; [KEY_TYPE]: string }

function str(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

function parsePrivate(privateKey: string, passphrase?: string): ParsedKey {
  const parsed = utils.parseKey(privateKey, passphrase)
  if (parsed instanceof Error) throw parsed
  return Array.isArray(parsed) ? parsed[0]! : parsed
}

/** The certificate's blob, after checking it certifies this very key. */
function certificateBlob(key: ParsedKey, certificate: string): { type: string; blob: Buffer } {
  const [type, b64] = certificate.trim().split(/\s+/)
  if (!type?.endsWith(CERT_SUFFIX) || !b64) throw new Error('Not an OpenSSH certificate')
  const blob = Buffer.from(b64, 'base64')
  const own = key.getPublicSSH()
  const fields = own.subarray(4 + own.readUInt32BE(0)) // the key's fields, after its type name
  let at = 4 + blob.readUInt32BE(0) // past the type name
  at += 4 + blob.readUInt32BE(at) // past the nonce
  if (!blob.subarray(at, at + fields.length).equals(fields)) throw new Error('The certificate is for a different key')
  return { type, blob }
}

/**
 * A private key that logs in with its certificate. RSA signs with SHA-512
 * (OpenSSH no longer accepts SHA-1 signatures).
 */
export function certificateKey(privateKey: string, passphrase: string | undefined, certificate: string): ParsedKey {
  const key = parsePrivate(privateKey, passphrase)
  const { type, blob } = certificateBlob(key, certificate)
  const rsa = key.type === 'ssh-rsa'
  return Object.create(key, {
    type: { value: rsa ? `rsa-sha2-512${CERT_SUFFIX}` : type },
    getPublicSSH: { value: () => blob },
    sign: { value: (data: Buffer) => key.sign(data, rsa ? 'sha512' : undefined) },
    [SIGNATURE_ALGO]: { value: rsa ? 'rsa-sha2-512' : key.type },
    [KEY_TYPE]: { value: key.type },
  }) as CertificateKey
}

const isCertificateKey = (key: unknown): key is CertificateKey =>
  !!key && typeof key === 'object' && SIGNATURE_ALGO in key

interface Protocol {
  authPK(username: string, key: unknown, keyAlgo?: unknown, cbSign?: unknown): void
  _kex: { sessionID: Buffer }
  _authsQueue: string[]
  _packetRW: { write: { alloc(n: number): Buffer; allocStart: number; finalize(p: Buffer): Buffer } }
}

/**
 * Makes `client` log in correctly with certificate keys. Call right after
 * `client.connect()` (which creates the connection's protocol object;
 * logging in starts only later, once keys are exchanged).
 */
export function useCertificates(client: Client): void {
  const protocol = (client as unknown as { _protocol?: Protocol })._protocol
  if (!protocol) throw new Error('useCertificates must be called after connect()')
  const original = protocol.authPK.bind(protocol)
  protocol.authPK = (username: string, key: unknown, keyAlgo?: unknown, cbSign?: unknown) => {
    if (!isCertificateKey(key)) return original(username, key, keyAlgo, cbSign)
    const sign = (typeof keyAlgo === 'function' ? keyAlgo : cbSign) as
      | ((data: Buffer, done: (signature: Buffer) => void) => void)
      | undefined
    const request = (signed: boolean) =>
      Buffer.concat([
        Buffer.from([USERAUTH_REQUEST]),
        str(username),
        str('ssh-connection'),
        str('publickey'),
        Buffer.from([signed ? 1 : 0]),
        str(key.type),
        str(key.getPublicSSH()),
      ])
    const send = (payload: Buffer) => {
      const writer = protocol._packetRW.write
      const packet = writer.alloc(payload.length)
      packet.set(payload, writer.allocStart)
      protocol._authsQueue.push('publickey')
      sendPacket(protocol, writer.finalize(packet))
    }
    if (!sign) return send(request(false))
    sign(Buffer.concat([str(protocol._kex.sessionID), request(true)]), (raw) => {
      const signature = convertSignature(raw, key[KEY_TYPE])
      if (signature === false) throw new Error('Could not sign with this key')
      send(Buffer.concat([request(true), str(Buffer.concat([str(key[SIGNATURE_ALGO]), str(signature)]))]))
    })
  }
}

// ---- agent forwarding -------------------------------------------------------

/** A key the forwarded agent offers: a vault key, or that key with its certificate. */
interface AgentKey {
  blob: Buffer
  comment: string
  key: ParsedKey
}

export interface VaultKey {
  label: string
  privateKey: string
  passphrase?: string
  certificate?: string
}

const SSH_AGENT_FAILURE = 5
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENT_IDENTITIES_ANSWER = 12
const SSH_AGENTC_SIGN_REQUEST = 13
const SSH_AGENT_SIGN_RESPONSE = 14
const SSH_AGENT_RSA_SHA2_256 = 2
const SSH_AGENT_RSA_SHA2_512 = 4

/**
 * The agent a server reaches when this computer's agent is forwarded to it:
 * it lists the vault's keys (and certificates) and signs with them. Nothing
 * else (adding or removing keys, locking) is allowed.
 */
export class VaultAgent extends BaseAgent {
  private readonly keys: AgentKey[] = []

  constructor(vaultKeys: VaultKey[]) {
    super()
    for (const k of vaultKeys) {
      let key: ParsedKey
      try {
        key = parsePrivate(k.privateKey, k.passphrase)
      } catch {
        continue // a key this computer cannot read is simply not offered
      }
      this.keys.push({ blob: key.getPublicSSH(), comment: k.label, key })
      if (k.certificate) {
        try {
          this.keys.push({ blob: certificateBlob(key, k.certificate).blob, comment: `${k.label} (certificate)`, key })
        } catch {
          // a certificate for another key: offer the key alone
        }
      }
    }
  }

  get count(): number {
    return this.keys.length
  }

  // Not used to log in (the connection's own auth handler does that), but
  // ssh2 asks agents for this.
  getIdentities(cb: (err: Error | null, keys?: ParsedKey[]) => void): void {
    cb(null, [])
  }

  sign(_key: unknown, _data: Buffer, _options: unknown, cb?: (err: Error) => void): void {
    cb?.(new Error('Not used for logging in'))
  }

  /** A stream speaking the agent protocol; ssh2 pipes each forwarded agent channel to one. */
  getStream(cb: (err: Error | null, stream?: Duplex) => void): void {
    let pending = Buffer.alloc(0)
    const stream = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, done) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
          const length = pending.readUInt32BE(0)
          const message = pending.subarray(4, 4 + length)
          pending = pending.subarray(4 + length)
          stream.push(str(this.answer(message)))
        }
        done()
      },
    })
    cb(null, stream)
  }

  private answer(message: Buffer): Buffer {
    try {
      if (message[0] === SSH_AGENTC_REQUEST_IDENTITIES) {
        const count = Buffer.alloc(4)
        count.writeUInt32BE(this.keys.length)
        return Buffer.concat([
          Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]),
          count,
          ...this.keys.flatMap((k) => [str(k.blob), str(k.comment)]),
        ])
      }
      if (message[0] === SSH_AGENTC_SIGN_REQUEST) {
        let at = 1
        const field = () => {
          const length = message.readUInt32BE(at)
          const value = message.subarray(at + 4, at + 4 + length)
          at += 4 + length
          return value
        }
        const blob = field()
        const data = field()
        const flags = message.readUInt32BE(at)
        const found = this.keys.find((k) => k.blob.equals(blob))
        if (!found) return Buffer.from([SSH_AGENT_FAILURE])
        let algo: string = found.key.type
        let hash: string | undefined
        if (algo === 'ssh-rsa') {
          if (flags & SSH_AGENT_RSA_SHA2_512) [algo, hash] = ['rsa-sha2-512', 'sha512']
          else if (flags & SSH_AGENT_RSA_SHA2_256) [algo, hash] = ['rsa-sha2-256', 'sha256']
          else hash = 'sha1'
        }
        const raw = found.key.sign(data, hash)
        if (raw instanceof Error) return Buffer.from([SSH_AGENT_FAILURE])
        const signature = convertSignature(raw, found.key.type)
        if (signature === false) return Buffer.from([SSH_AGENT_FAILURE])
        return Buffer.concat([Buffer.from([SSH_AGENT_SIGN_RESPONSE]), str(Buffer.concat([str(algo), str(signature)]))])
      }
    } catch {
      // malformed request
    }
    return Buffer.from([SSH_AGENT_FAILURE])
  }
}
