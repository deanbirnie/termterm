import { chownSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function idFrom(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const id = Number(raw)
  if (!Number.isInteger(id) || id < 0 || id > 2 ** 31) {
    throw new Error(`${name} must be a numeric user or group id, got "${raw}"`)
  }
  return id
}

/**
 * Makes the data directory usable and stops running as root.
 *
 * Docker creates a bind-mounted data folder owned by root, which an
 * unprivileged server could not write to. So the container starts as root,
 * hands the folder to the user it will run as (PUID/PGID, default 1000:1000),
 * and drops to that user before opening any socket or file of its own.
 *
 * When the container is started as a non-root user (`--user`), or the server
 * runs outside Docker, this only creates the directory.
 */
export function prepareDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return

  const uid = idFrom('PUID', 1000)
  const gid = idFrom('PGID', 1000)
  if (uid === 0) return // explicitly asked to stay root

  chownSync(dataDir, uid, gid)
  for (const entry of readdirSync(dataDir)) chownSync(join(dataDir, entry), uid, gid)

  // Order matters: groups and gid can only be changed while still root.
  process.setgroups!([gid])
  process.setgid!(gid)
  process.setuid!(uid)
}
