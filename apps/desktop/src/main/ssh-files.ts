/** Reads this computer's OpenSSH files (~/.ssh) for importing hosts into the vault. */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseSshConfig, type SshImportFiles } from '@termterm/app'

const MAX_BYTES = 256 * 1024
/** The keys ssh tries when a host names none, in ssh's order. */
const DEFAULT_KEYS = ['id_rsa', 'id_ecdsa', 'id_ed25519']

async function readText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_BYTES) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

const isPrivateKey = (text: string | undefined): text is string => !!text && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)

export async function readSshFiles(dir: string): Promise<SshImportFiles> {
  const home = homedir()
  const expand = (p: string) => (p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : isAbsolute(p) ? p : join(dir, p))
  const config = await readText(join(dir, 'config'))
  const knownHosts = await readText(join(dir, 'known_hosts'))
  const keys: Record<string, string> = {}
  for (const host of config ? parseSshConfig(config) : []) {
    const path = host.identityFile
    if (!path || path in keys) continue
    const text = await readText(expand(path))
    if (isPrivateKey(text)) keys[path] = text
  }
  let defaultKey: string | undefined
  for (const name of DEFAULT_KEYS) {
    const text = await readText(join(dir, name))
    if (isPrivateKey(text)) {
      defaultKey = `~/.ssh/${name}`
      keys[defaultKey] = text
      break
    }
  }
  return { source: '~/.ssh on this computer', config, knownHosts, keys, defaultKey }
}
