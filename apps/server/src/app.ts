/**
 * termterm sync server.
 *
 * Stores opaque, client-encrypted blobs per account and hands them back in
 * sequence order. It never sees the master password, the vault key or any
 * plaintext: authentication uses a key derived from the master password on
 * the client, which is hashed again here before storage.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from './db.ts'

export interface ServerOptions {
  dbPath: string
  allowRegistration?: boolean
  /** Release version reported by the health endpoint. */
  version?: string
  /** Honour X-Forwarded-For (set only when behind a reverse proxy you control). */
  trustProxy?: boolean
}

const LIMITS = {
  bodyBytes: 8 * 1024 * 1024,
  blobChars: 512 * 1024,
  changesPerPush: 500,
  itemsPerUser: 20_000,
  pullPage: 500,
  sessionsPerUser: 50,
  failedLogins: 10,
  failedLoginWindowMs: 15 * 60_000,
  sessionIdleMs: 180 * 24 * 3600_000,
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._@+-]{2,63}$/
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

// The mobile app runs in a WebView, whose requests are cross-origin. Any
// origin may call the API: it is authenticated by a bearer token the caller
// must already hold, never by cookies, so there is nothing for another site
// to ride on.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const scryptAsync = (secret: Buffer, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  )

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest()

interface UserRow {
  id: number
  username: string
  kdf: string
  auth_salt: Uint8Array
  auth_hash: Uint8Array
  wrapped_vault_key: string
  seq: number
}

export function createApp(options: ServerOptions): { server: Server; db: DatabaseSync } {
  const db = openDb(options.dbPath)
  const allowRegistration = options.allowRegistration ?? true
  const version = options.version ?? 'dev'
  const serverSecret = Buffer.from(
    (db.prepare('SELECT value FROM meta WHERE key = ?').get('server_secret') as { value: Uint8Array })
      .value,
  )

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (username, kdf, auth_salt, auth_hash, wrapped_vault_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)',
    ),
    session: db.prepare('SELECT user_id, last_used_at FROM sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    listSessions: db.prepare(
      'SELECT token_hash, label, created_at, last_used_at FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC',
    ),
    labelSession: db.prepare('UPDATE sessions SET label = ? WHERE token_hash = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    updateCredentials: db.prepare(
      'UPDATE users SET kdf = ?, auth_salt = ?, auth_hash = ?, wrapped_vault_key = ? WHERE id = ?',
    ),
    pruneSessions: db.prepare(
      `DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN
         (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?)`,
    ),
    pull: db.prepare(
      'SELECT id, seq, blob FROM items WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ),
    item: db.prepare('SELECT id, seq, blob FROM items WHERE user_id = ? AND id = ?'),
    itemCount: db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?'),
    upsertItem: db.prepare(
      `INSERT INTO items (user_id, id, seq, blob) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET seq = excluded.seq, blob = excluded.blob`,
    ),
    bumpSeq: db.prepare('UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq'),
  }

  // ---- brute-force throttling (in memory; resets on restart) -----------------
  const failures = new Map<string, number[]>()
  const throttleKeys = (ip: string, username: string) => [`ip:${ip}`, `user:${username}`]
  function checkThrottle(keys: string[]): void {
    const cutoff = Date.now() - LIMITS.failedLoginWindowMs
    for (const key of keys) {
      const recent = (failures.get(key) ?? []).filter((t) => t > cutoff)
      if (recent.length) failures.set(key, recent)
      else failures.delete(key)
      if (recent.length >= LIMITS.failedLogins) {
        throw new HttpError(429, 'Too many failed attempts. Try again later.')
      }
    }
  }
  function recordFailure(keys: string[]): void {
    for (const key of keys) failures.set(key, [...(failures.get(key) ?? []), Date.now()])
  }

  // ---- helpers ----------------------------------------------------------------
  function clientIp(req: IncomingMessage): string {
    if (options.trustProxy) {
      const fwd = req.headers['x-forwarded-for']
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
      if (first) return first
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > LIMITS.bodyBytes) throw new HttpError(413, 'Request too large')
      chunks.push(chunk as Buffer)
    }
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return body as Record<string, unknown>
      }
    } catch {
      /* fall through */
    }
    throw new HttpError(400, 'Invalid JSON body')
  }

  function str(v: unknown, name: string, max: number, re?: RegExp): string {
    if (typeof v !== 'string' || v.length === 0 || v.length > max || (re && !re.test(v))) {
      throw new HttpError(400, `Invalid ${name}`)
    }
    return v
  }

  const usernameOf = (v: unknown) =>
    str(typeof v === 'string' ? v.trim().toLowerCase() : v, 'username', 64, USERNAME_RE)

  function authKeyOf(v: unknown): Buffer {
    const key = Buffer.from(str(v, 'authKey', 64, B64_RE), 'base64')
    if (key.length !== 32) throw new HttpError(400, 'Invalid authKey')
    return key
  }

  function kdfOf(v: unknown): string {
    const k = v as Record<string, unknown> | null
    const int = (x: unknown, min: number, max: number) =>
      typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max
    if (
      !k ||
      k.alg !== 'argon2id' ||
      typeof k.salt !== 'string' ||
      !B64_RE.test(k.salt) ||
      k.salt.length > 128 ||
      !int(k.m, 19 * 1024, 1024 * 1024) ||
      !int(k.t, 2, 16) ||
      !int(k.p, 1, 8)
    ) {
      throw new HttpError(400, 'Invalid kdf')
    }
    return JSON.stringify({ alg: k.alg, salt: k.salt, m: k.m, t: k.t, p: k.p })
  }

  function newSession(userId: number): string {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    q.insertSession.run(sha256(token), userId, now, now)
    q.pruneSessions.run(userId, userId, LIMITS.sessionsPerUser)
    return token
  }

  function authenticate(req: IncomingMessage): { user: UserRow; tokenHash: Buffer } {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) throw new HttpError(401, 'Not signed in')
    const tokenHash = sha256(token)
    const session = q.session.get(tokenHash) as { user_id: number; last_used_at: number } | undefined
    const now = Date.now()
    if (!session || now - session.last_used_at > LIMITS.sessionIdleMs) {
      if (session) q.deleteSession.run(tokenHash)
      throw new HttpError(401, 'Session expired. Sign in again.')
    }
    if (now - session.last_used_at > 3600_000) q.touchSession.run(now, tokenHash)
    const user = q.userById.get(session.user_id) as UserRow | undefined
    if (!user) throw new HttpError(401, 'Not signed in')
    return { user, tokenHash }
  }

  // ---- routes -------------------------------------------------------------------
  type Handler = (req: IncomingMessage, url: URL) => Promise<unknown> | unknown

  const routes: Record<string, Handler> = {
    'GET /v1/health': () => ({ ok: true, version, registration: allowRegistration }),

    // Returns the KDF parameters a client needs to derive its auth key. Unknown
    // usernames get stable fake parameters so accounts cannot be enumerated.
    'POST /v1/prelogin': async (req) => {
      const username = usernameOf((await readJson(req)).username)
      const user = q.userByName.get(username) as UserRow | undefined
      if (user) return { kdf: JSON.parse(user.kdf) as unknown }
      const salt = createHmac('sha256', serverSecret).update(username).digest().subarray(0, 16)
      return { kdf: { alg: 'argon2id', salt: salt.toString('base64'), m: 64 * 1024, t: 3, p: 1 } }
    },

    'POST /v1/register': async (req) => {
      if (!allowRegistration) throw new HttpError(403, 'Registration is disabled on this server')
      const body = await readJson(req)
      const username = usernameOf(body.username)
      const kdf = kdfOf(body.kdf)
      const authKey = authKeyOf(body.authKey)
      const wrappedVaultKey = str(body.wrappedVaultKey, 'wrappedVaultKey', 1024, B64_RE)
      const salt = randomBytes(16)
      const hash = await scryptAsync(authKey, salt)
      if (q.userByName.get(username)) throw new HttpError(409, 'That username is already taken')
      const { lastInsertRowid } = q.insertUser.run(
        username,
        kdf,
        salt,
        hash,
        wrappedVaultKey,
        Date.now(),
      )
      return { token: newSession(Number(lastInsertRowid)) }
    },

    'POST /v1/login': async (req) => {
      const body = await readJson(req)
      const username = usernameOf(body.username)
      const authKey = authKeyOf(body.authKey)
      const keys = throttleKeys(clientIp(req), username)
      checkThrottle(keys)
      const user = q.userByName.get(username) as UserRow | undefined
      // Always do the hash so timing does not reveal whether the account exists.
      const hash = await scryptAsync(authKey, Buffer.from(user?.auth_salt ?? serverSecret.subarray(0, 16)))
      if (!user || !timingSafeEqual(hash, Buffer.from(user.auth_hash))) {
        recordFailure(keys)
        throw new HttpError(401, 'Incorrect username or master password')
      }
      return {
        token: newSession(user.id),
        wrappedVaultKey: user.wrapped_vault_key,
      }
    },

    // Master password change. Requires both a live session and the current
    // auth key, and signs out every other device so they must re-authenticate
    // with the new password.
    'POST /v1/password': async (req) => {
      const { user, tokenHash } = authenticate(req)
      const body = await readJson(req)
      const authKey = authKeyOf(body.authKey)
      const newAuthKey = authKeyOf(body.newAuthKey)
      const kdf = kdfOf(body.kdf)
      const wrappedVaultKey = str(body.wrappedVaultKey, 'wrappedVaultKey', 1024, B64_RE)
      const keys = throttleKeys(clientIp(req), user.username)
      checkThrottle(keys)
      const hash = await scryptAsync(authKey, Buffer.from(user.auth_salt))
      if (!timingSafeEqual(hash, Buffer.from(user.auth_hash))) {
        recordFailure(keys)
        throw new HttpError(401, 'Incorrect master password')
      }
      const salt = randomBytes(16)
      const newHash = await scryptAsync(newAuthKey, salt)
      q.updateCredentials.run(kdf, salt, newHash, wrappedVaultKey, user.id)
      q.deleteOtherSessions.run(user.id, tokenHash)
      return { ok: true }
    },

    // Devices signed in to this account. A session's public id is its token
    // hash, which identifies it without being usable as a credential.
    'GET /v1/sessions': (req) => {
      const { user, tokenHash } = authenticate(req)
      const rows = q.listSessions.all(user.id) as Array<{
        token_hash: Uint8Array
        label: string | null
        created_at: number
        last_used_at: number
      }>
      return {
        sessions: rows.map((r) => {
          const hash = Buffer.from(r.token_hash)
          return {
            id: hash.toString('hex'),
            label: r.label,
            createdAt: r.created_at,
            lastUsedAt: r.last_used_at,
            current: hash.equals(tokenHash),
          }
        }),
      }
    },

    'POST /v1/sessions/label': async (req) => {
      const { tokenHash } = authenticate(req)
      const label = str((await readJson(req)).label, 'label', 1024, B64_RE)
      q.labelSession.run(label, tokenHash)
      return { ok: true }
    },

    'POST /v1/sessions/revoke': async (req) => {
      const { user } = authenticate(req)
      const id = str((await readJson(req)).id, 'id', 64, /^[0-9a-f]{64}$/)
      const target = Buffer.from(id, 'hex')
      const session = q.session.get(target) as { user_id: number } | undefined
      // Only your own sessions; someone else's id looks the same as a missing one.
      if (!session || session.user_id !== user.id) throw new HttpError(404, 'Device not found')
      q.deleteSession.run(target)
      return { ok: true }
    },

    'POST /v1/logout': (req) => {
      const { tokenHash } = authenticate(req)
      q.deleteSession.run(tokenHash)
      return { ok: true }
    },

    'GET /v1/sync': (req, url) => {
      const { user } = authenticate(req)
      const since = Number(url.searchParams.get('since') ?? '0')
      if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'Invalid since')
      const rows = q.pull.all(user.id, since, LIMITS.pullPage + 1) as Array<{
        id: string
        seq: number
        blob: string
      }>
      const more = rows.length > LIMITS.pullPage
      const items = more ? rows.slice(0, LIMITS.pullPage) : rows
      return { items, more, cursor: items.at(-1)?.seq ?? since }
    },

    'POST /v1/sync': async (req) => {
      const { user } = authenticate(req)
      const { changes } = await readJson(req)
      if (!Array.isArray(changes) || changes.length > LIMITS.changesPerPush) {
        throw new HttpError(400, 'Invalid changes')
      }
      const parsed = changes.map((c: Record<string, unknown>) => {
        const baseSeq = c?.baseSeq
        if (typeof baseSeq !== 'number' || !Number.isSafeInteger(baseSeq) || baseSeq < 0) {
          throw new HttpError(400, 'Invalid baseSeq')
        }
        return {
          id: str(c.id, 'id', 64, ID_RE),
          blob: str(c.blob, 'blob', LIMITS.blobChars, B64_RE),
          baseSeq,
        }
      })

      const results: unknown[] = []
      db.exec('BEGIN IMMEDIATE')
      try {
        let count = (q.itemCount.get(user.id) as { n: number }).n
        for (const change of parsed) {
          const current = q.item.get(user.id, change.id) as
            | { id: string; seq: number; blob: string }
            | undefined
          // Optimistic concurrency: reject if someone else changed it first.
          if (current && current.seq !== change.baseSeq) {
            results.push({ id: change.id, status: 'conflict', item: current })
            continue
          }
          if (!current && ++count > LIMITS.itemsPerUser) {
            throw new HttpError(413, 'Vault item limit reached')
          }
          const { seq } = q.bumpSeq.get(user.id) as { seq: number }
          q.upsertItem.run(user.id, change.id, seq, change.blob)
          results.push({ id: change.id, status: 'ok', seq })
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return { results }
    },
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body)
      res.writeHead(status, {
        ...CORS_HEADERS,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(json),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(json)
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      return res.end()
    }
    const handler = routes[`${req.method} ${url.pathname.replace(/\/+$/, '')}`]
    if (!handler) return send(404, { error: 'Not found' })
    Promise.resolve()
      .then(() => handler(req, url))
      .then((body) => send(200, body))
      .catch((e: unknown) => {
        if (e instanceof HttpError) return send(e.status, { error: e.message })
        console.error(e)
        send(500, { error: 'Internal server error' })
      })
  })
  server.on('close', () => db.close())
  return { server, db }
}
