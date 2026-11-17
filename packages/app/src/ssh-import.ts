/**
 * Reading OpenSSH's own files, to bring existing hosts into the vault:
 * `~/.ssh/config` (hosts) and `~/.ssh/known_hosts` (trusted host keys).
 * Pure parsing; reading the files is up to each app.
 */
import { fromBase64 } from '@termterm/core'
import { fingerprintOf, keyTypeOfBlob } from './fingerprint.ts'

export interface ConfigHost {
  /** The name after `Host`, used as the label. */
  alias: string
  address: string
  port: number
  /** Empty when the config does not say (ssh then uses the local user name). */
  username: string
  /** IdentityFile as written (may start with ~). */
  identityFile?: string
  /** ProxyJump as written: not imported yet, reported so it is not silently lost. */
  proxyJump?: string
}

/**
 * The concrete hosts in an ssh config: one per name on a `Host` line,
 * skipping patterns (`*`, `?`, `!`). Settings from `Host *` and other
 * patterns that match a name apply to it, as ssh does: the first value
 * found for each setting wins. `Match` blocks are skipped.
 */
export function parseSshConfig(text: string): ConfigHost[] {
  type Block = { patterns: string[]; settings: Map<string, string> }
  const blocks: Block[] = []
  let current: Block | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = unquote(m[2]!.trim())
    if (key === 'host') {
      current = { patterns: value.split(/\s+/).filter(Boolean), settings: new Map() }
      blocks.push(current)
    } else if (key === 'match') {
      current = null // conditions this does not evaluate
    } else if (current && !current.settings.has(key)) {
      current.settings.set(key, value)
    } else if (!current && blocks.length === 0) {
      // Settings before any Host line apply to every host.
      blocks.push((current = { patterns: ['*'], settings: new Map([[key, value]]) }))
    }
  }

  const names: string[] = []
  for (const b of blocks) {
    for (const p of b.patterns) if (!/[*?!]/.test(p) && !names.includes(p)) names.push(p)
  }
  return names.map((alias) => {
    const get = (key: string) => {
      for (const b of blocks) if (matches(alias, b.patterns) && b.settings.has(key)) return b.settings.get(key)
      return undefined
    }
    const port = Number(get('port') ?? 22)
    return {
      alias,
      address: get('hostname')?.replace(/%h/g, alias) || alias,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
      username: get('user') ?? '',
      identityFile: get('identityfile'),
      proxyJump: get('proxyjump'),
    }
  })
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/** ssh's Host pattern matching: `*` and `?` wildcards, `!` negates. */
function matches(name: string, patterns: string[]): boolean {
  let hit = false
  for (const p of patterns) {
    const negated = p.startsWith('!')
    const glob = negated ? p.slice(1) : p
    const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
    if (re.test(name)) {
      if (negated) return false
      hit = true
    }
  }
  return hit
}

export interface KnownHostEntry {
  host: string
  port: number
  keyType: string
  /** base64 of the public key blob */
  publicKey: string
  fingerprint: string
}

export interface KnownHostsResult {
  entries: KnownHostEntry[]
  /** Lines that cannot be imported: hashed names, revoked keys, CA lines, unreadable keys. */
  skipped: number
}

/** The plain entries of a known_hosts file, one per host name. */
export function parseKnownHosts(text: string): KnownHostsResult {
  const entries: KnownHostEntry[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts[0]!.startsWith('@')) {
      skipped++ // @revoked and @cert-authority are not plain trusted keys
      continue
    }
    const [hosts, keyType, publicKey] = parts
    if (!hosts || !keyType || !publicKey) {
      skipped++
      continue
    }
    let blob: Uint8Array
    try {
      blob = fromBase64(publicKey)
    } catch {
      skipped++
      continue
    }
    if (keyTypeOfBlob(blob) !== keyType) {
      skipped++
      continue
    }
    for (const name of hosts.split(',')) {
      if (name.startsWith('|')) {
        skipped++ // hashed: the name cannot be read back
        continue
      }
      if (/[*?!]/.test(name)) continue
      const bracketed = /^\[(.+)\]:(\d+)$/.exec(name)
      entries.push({
        host: bracketed ? bracketed[1]! : name,
        port: bracketed ? Number(bracketed[2]) : 22,
        keyType,
        publicKey,
        fingerprint: fingerprintOf(blob),
      })
    }
  }
  return { entries, skipped }
}
