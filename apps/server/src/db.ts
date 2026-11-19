import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      kdf TEXT NOT NULL,
      auth_salt BLOB NOT NULL,
      auth_hash BLOB NOT NULL,
      wrapped_vault_key TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash BLOB PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      blob TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS items_by_seq ON items (user_id, seq);
    -- Further vaults (an account's own ones, and later shared ones). Each has
    -- its own sequence; its members each hold its key, sealed for them, and
    -- its name, sealed too. The server sees ciphertext only.
    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_members (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      meta TEXT NOT NULL,
      PRIMARY KEY (vault_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS vault_members_by_user ON vault_members (user_id);
    CREATE TABLE IF NOT EXISTS vault_items (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      blob TEXT NOT NULL,
      PRIMARY KEY (vault_id, id)
    );
    CREATE INDEX IF NOT EXISTS vault_items_by_seq ON vault_items (vault_id, seq);
  `)
  // Added after the first release: an encrypted, client-chosen device label.
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
  if (!sessionColumns.some((c) => c.name === 'label')) {
    db.exec('ALTER TABLE sessions ADD COLUMN label TEXT')
  }
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'server_secret',
    randomBytes(32),
  )
  return db
}
