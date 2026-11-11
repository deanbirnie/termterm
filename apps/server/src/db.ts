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
  `)
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'server_secret',
    randomBytes(32),
  )
  return db
}
