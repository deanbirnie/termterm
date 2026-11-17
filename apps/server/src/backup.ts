/**
 * Backs up the sync server's database while it runs:
 *
 *   node backup.ts [destination]
 *
 * In Docker:
 *
 *   docker exec termterm-sync node --disable-warning=ExperimentalWarning backup.ts
 *
 * SQLite's VACUUM INTO writes a consistent copy even while the server is
 * writing, so there is no need to stop it. The copy is checked before it is
 * reported as done. Without a destination it goes to `backups/` next to the
 * database, named by date and time. The copy is only as secret as the
 * database: vault items are ciphertext, but usernames and login hashes are in
 * it too, so keep backups where only you can read them.
 */
import { chownSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dbPath = resolve(process.env.TERMTERM_DB ?? './data/termterm.db')

export function backup(source: string, destination: string): { users: number; items: number; bytes: number } {
  if (!existsSync(source)) throw new Error(`No database at ${source}`)
  if (existsSync(destination)) throw new Error(`${destination} already exists; choose another name`)
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.prepare('VACUUM INTO ?').run(destination)
  } finally {
    db.close()
  }
  const copy = new DatabaseSync(destination, { readOnly: true })
  try {
    const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (check.integrity_check !== 'ok') throw new Error(`The copy failed its integrity check: ${check.integrity_check}`)
    const { users } = copy.prepare('SELECT COUNT(*) AS users FROM users').get() as { users: number }
    const { items } = copy.prepare('SELECT COUNT(*) AS items FROM items').get() as { items: number }
    return { users, items, bytes: statSync(destination).size }
  } finally {
    copy.close()
  }
}

if (import.meta.main) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const destination = resolve(process.argv[2] ?? join(dirname(dbPath), 'backups', `termterm-${stamp}.db`))
  try {
    const { users, items, bytes } = backup(dbPath, destination)
    // Run as root (docker exec), give the copy to the database's owner, so the
    // server's own user can read it and a restore needs no chown.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const { uid, gid } = statSync(dbPath)
      chownSync(destination, uid, gid)
      chownSync(dirname(destination), uid, gid)
    }
    console.log(`Backed up ${users} account(s) and ${items} item(s) to ${destination} (${bytes} bytes, integrity ok)`)
  } catch (err) {
    console.error(`Backup failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
