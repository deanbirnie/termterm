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
  itemsPerVault: 20_000,
  vaultsPerUser: 100,
  pullPage: 500,
  sessionsPerUser: 50,
  failedLogins: 10,
  failedLoginWindowMs: 15 * 60_000,
  sessionIdleMs: 180 * 24 * 3600_000,
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._@+-]{2,63}$/
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
/** An X25519 public key, base64. */
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/
const ROLES = ['admin', 'member'] as const
/** 'owner' is how the first builds named the vault's creator: an admin. */
const isAdmin = (role: string) => role === 'admin' || role === 'owner'

/**
 * The id prefix of the items a member who is not an admin may write: their
 * own known hosts and key. Worked out the same way in the app (`memberTag`).
 */
const memberTag = (username: string) =>
  `m-${createHash('sha256').update(`termterm-member:${username}`).digest().subarray(0, 16).toString('hex')}`

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
  public_key: string | null
  sealed_private_key: string | null
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
    // Sessions and items go with it (ON DELETE CASCADE).
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
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
    usage: db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(LENGTH(blob)), 0) AS bytes FROM items WHERE user_id = ?'),
    upsertItem: db.prepare(
      `INSERT INTO items (user_id, id, seq, blob) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET seq = excluded.seq, blob = excluded.blob`,
    ),
    bumpSeq: db.prepare('UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq'),
    // ---- further vaults ----
    myVaults: db.prepare(
      `SELECT v.id, v.seq, v.epoch, m.role, m.wrapped_key, m.meta,
         (SELECT COUNT(*) FROM vault_members o WHERE o.vault_id = v.id) AS member_count
       FROM vault_members m JOIN vaults v ON v.id = m.vault_id
       WHERE m.user_id = ? ORDER BY v.created_at`,
    ),
    membership: db.prepare(
      'SELECT v.id, v.seq, v.epoch, m.role FROM vault_members m JOIN vaults v ON v.id = m.vault_id WHERE m.vault_id = ? AND m.user_id = ?',
    ),
    setKeys: db.prepare('UPDATE users SET public_key = ?, sealed_private_key = ? WHERE id = ?'),
    members: db.prepare(
      `SELECT u.id, u.username, u.public_key, m.role FROM vault_members m JOIN users u ON u.id = m.user_id
       WHERE m.vault_id = ? ORDER BY u.username`,
    ),
    adminCount: db.prepare("SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ? AND role IN ('admin', 'owner')"),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ?'),
    setRole: db.prepare('UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?'),
    setMemberKey: db.prepare('UPDATE vault_members SET wrapped_key = ? WHERE vault_id = ? AND user_id = ?'),
    bumpEpoch: db.prepare('UPDATE vaults SET epoch = epoch + 1 WHERE id = ? RETURNING epoch'),
    vaultIds: db.prepare('SELECT id FROM vault_items WHERE vault_id = ?'),
    vaultExists: db.prepare('SELECT 1 FROM vaults WHERE id = ?'),
    vaultCount: db.prepare('SELECT COUNT(*) AS n FROM vault_members WHERE user_id = ?'),
    insertVault: db.prepare('INSERT INTO vaults (id, created_at) VALUES (?, ?)'),
    insertMember: db.prepare('INSERT INTO vault_members (vault_id, user_id, role, wrapped_key, meta) VALUES (?, ?, ?, ?, ?)'),
    updateMember: db.prepare(
      'UPDATE vault_members SET wrapped_key = COALESCE(?, wrapped_key), meta = COALESCE(?, meta) WHERE vault_id = ? AND user_id = ?',
    ),
    removeMember: db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?'),
    // A vault nobody is a member of any more has no one to read it: it goes.
    pruneVaults: db.prepare('DELETE FROM vaults WHERE id NOT IN (SELECT vault_id FROM vault_members)'),
    vaultPull: db.prepare('SELECT id, seq, blob FROM vault_items WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
    vaultItem: db.prepare('SELECT id, seq, blob FROM vault_items WHERE vault_id = ? AND id = ?'),
    vaultItemCount: db.prepare('SELECT COUNT(*) AS n FROM vault_items WHERE vault_id = ?'),
    vaultUpsertItem: db.prepare(
      `INSERT INTO vault_items (vault_id, id, seq, blob) VALUES (?, ?, ?, ?)
       ON CONFLICT (vault_id, id) DO UPDATE SET seq = excluded.seq, blob = excluded.blob`,
    ),
    vaultBumpSeq: db.prepare('UPDATE vaults SET seq = seq + 1 WHERE id = ? RETURNING seq'),
    vaultUsage: db.prepare(
      `SELECT COUNT(*) AS items, COALESCE(SUM(LENGTH(i.blob)), 0) AS bytes FROM vault_items i
       JOIN vault_members m ON m.vault_id = i.vault_id WHERE m.user_id = ? AND m.role IN ('admin', 'owner')`,
    ),
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

  /** The caller's membership of a vault; one they are not in might as well not exist. */
  function memberOf(vaultId: string, userId: number): { id: string; seq: number; epoch: number; role: string } {
    const row = q.membership.get(vaultId, userId) as { id: string; seq: number; epoch: number; role: string } | undefined
    if (!row) throw new HttpError(404, 'Vault not found')
    return row
  }

  function adminOf(vaultId: string, userId: number): { id: string; seq: number; epoch: number; role: string } {
    const row = memberOf(vaultId, userId)
    if (!isAdmin(row.role)) throw new HttpError(403, 'Only the vault\'s admins can do that')
    return row
  }

  function roleOf(v: unknown): (typeof ROLES)[number] {
    if (!ROLES.includes(v as (typeof ROLES)[number])) throw new HttpError(400, 'Invalid role')
    return v as (typeof ROLES)[number]
  }

  type Change = { id: string; blob: string; baseSeq: number }
  function parseChanges(changes: unknown): Change[] {
    if (!Array.isArray(changes) || changes.length > LIMITS.changesPerPush) throw new HttpError(400, 'Invalid changes')
    return changes.map((c: Record<string, unknown>) => {
      const baseSeq = c?.baseSeq
      if (typeof baseSeq !== 'number' || !Number.isSafeInteger(baseSeq) || baseSeq < 0) {
        throw new HttpError(400, 'Invalid baseSeq')
      }
      return { id: str(c.id, 'id', 64, ID_RE), blob: str(c.blob, 'blob', LIMITS.blobChars, B64_RE), baseSeq }
    })
  }

  /** Applies pushed changes in one transaction, with optimistic concurrency on each item. */
  function applyChanges(
    parsed: Change[],
    store: {
      count(): number
      limit: number
      item(id: string): { id: string; seq: number; blob: string } | undefined
      bump(): number
      upsert(id: string, seq: number, blob: string): void
    },
  ): { results: unknown[] } {
    const results: unknown[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      let count = store.count()
      for (const change of parsed) {
        const current = store.item(change.id)
        // Optimistic concurrency: reject if someone else changed it first.
        if (current && current.seq !== change.baseSeq) {
          results.push({ id: change.id, status: 'conflict', item: current })
          continue
        }
        if (!current && ++count > store.limit) throw new HttpError(413, 'Vault item limit reached')
        const seq = store.bump()
        store.upsert(change.id, seq, change.blob)
        results.push({ id: change.id, status: 'ok', seq })
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { results }
  }

  // ---- routes -------------------------------------------------------------------
  type Handler = (req: IncomingMessage, url: URL) => Promise<unknown> | unknown

  const routes: Record<string, Handler> = {
    // features: what this server can do beyond the first release, so an app
    // can tell an older server it must not ask for them.
    'GET /v1/health': () => ({ ok: true, version, registration: allowRegistration, features: ['vaults', 'shared'] }),

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

    // Deletes the account and everything stored for it. Like a password
    // change, it needs the master password (as the auth key), not only a session.
    'POST /v1/account/delete': async (req) => {
      const { user } = authenticate(req)
      const authKey = authKeyOf((await readJson(req)).authKey)
      const keys = throttleKeys(clientIp(req), user.username)
      checkThrottle(keys)
      const hash = await scryptAsync(authKey, Buffer.from(user.auth_salt))
      if (!timingSafeEqual(hash, Buffer.from(user.auth_hash))) {
        recordFailure(keys)
        throw new HttpError(401, 'Incorrect master password')
      }
      q.deleteUser.run(user.id)
      q.pruneVaults.run()
      return { ok: true }
    },

    // How much this account stores: items (deletions included, as they are
    // kept to reach every device) and the size of their ciphertext.
    'GET /v1/usage': (req) => {
      const { user } = authenticate(req)
      const { items, bytes } = q.usage.get(user.id) as { items: number; bytes: number }
      // Further vaults this account made count separately; each has its own limit.
      const other = q.vaultUsage.get(user.id) as { items: number; bytes: number }
      return { items, bytes, maxItems: LIMITS.itemsPerUser, vaultItems: other.items, vaultBytes: other.bytes }
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
      // head: the newest sequence number this account has. A device that has
      // already seen further than that knows the server lost history.
      return { items, more, cursor: items.at(-1)?.seq ?? since, head: user.seq }
    },

    // ---- further vaults --------------------------------------------------------------
    'GET /v1/vaults': (req) => {
      const { user } = authenticate(req)
      const rows = q.myVaults.all(user.id) as Array<{
        id: string
        seq: number
        epoch: number
        role: string
        wrapped_key: string
        meta: string
        member_count: number
      }>
      return {
        vaults: rows.map((r) => ({
          id: r.id,
          role: isAdmin(r.role) ? 'admin' : 'member',
          wrappedKey: r.wrapped_key,
          meta: r.meta,
          head: r.seq,
          epoch: r.epoch,
          members: r.member_count,
        })),
      }
    },

    'POST /v1/vaults': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const id = str(body.id, 'id', 64, ID_RE)
      const wrappedKey = str(body.wrappedKey, 'wrappedKey', 1024, B64_RE)
      const meta = str(body.meta, 'meta', 4096, B64_RE)
      db.exec('BEGIN IMMEDIATE')
      try {
        if (q.vaultExists.get(id)) throw new HttpError(409, 'That vault already exists')
        if ((q.vaultCount.get(user.id) as { n: number }).n >= LIMITS.vaultsPerUser) {
          throw new HttpError(413, 'Vault limit reached')
        }
        q.insertVault.run(id, Date.now())
        q.insertMember.run(id, user.id, 'admin', wrappedKey, meta)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return { ok: true }
    },

    // A member's own copy of the vault's key and name (renaming, or a new account password).
    'POST /v1/vaults/update': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const vaultId = str(body.vaultId, 'vaultId', 64, ID_RE)
      const wrappedKey = body.wrappedKey === undefined ? null : str(body.wrappedKey, 'wrappedKey', 1024, B64_RE)
      const meta = body.meta === undefined ? null : str(body.meta, 'meta', 4096, B64_RE)
      memberOf(vaultId, user.id)
      q.updateMember.run(wrappedKey, meta, vaultId, user.id)
      return { ok: true }
    },

    // Leaving a vault; the last member to leave deletes it.
    'POST /v1/vaults/leave': async (req) => {
      const { user } = authenticate(req)
      const vaultId = str((await readJson(req)).vaultId, 'vaultId', 64, ID_RE)
      const vault = memberOf(vaultId, user.id)
      if (
        isAdmin(vault.role) &&
        (q.adminCount.get(vaultId) as { n: number }).n === 1 &&
        (q.memberCount.get(vaultId) as { n: number }).n > 1
      ) {
        throw new HttpError(409, 'Make another member an admin before you leave')
      }
      q.removeMember.run(vaultId, user.id)
      q.pruneVaults.run()
      return { ok: true }
    },

    // ---- shared vaults -------------------------------------------------------------
    // The account's key pair: set once by its first device that needs it.
    'GET /v1/account/keys': (req) => {
      const { user } = authenticate(req)
      return { publicKey: user.public_key, sealedPrivateKey: user.sealed_private_key }
    },

    'POST /v1/account/keys': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const publicKey = str(body.publicKey, 'publicKey', 44, PUBLIC_KEY_RE)
      const sealedPrivateKey = str(body.sealedPrivateKey, 'sealedPrivateKey', 1024, B64_RE)
      // Others have sealed vault keys to the public key: it can be sealed again, never replaced.
      if (user.public_key && user.public_key !== publicKey) throw new HttpError(409, 'This account already has a key pair')
      q.setKeys.run(publicKey, sealedPrivateKey, user.id)
      return { ok: true }
    },

    // Another account's public key, to add them to a vault (after comparing its fingerprint).
    'POST /v1/users/key': async (req) => {
      authenticate(req)
      const username = usernameOf((await readJson(req)).username)
      const other = q.userByName.get(username) as UserRow | undefined
      if (!other?.public_key) throw new HttpError(404, 'No account by that name can be added to a vault yet')
      return { username, publicKey: other.public_key }
    },

    'GET /v1/vaults/members': (req, url) => {
      const { user } = authenticate(req)
      const vault = memberOf(str(url.searchParams.get('vault'), 'vault', 64, ID_RE), user.id)
      const rows = q.members.all(vault.id) as Array<{ username: string; public_key: string | null; role: string }>
      return {
        members: rows.map((r) => ({ username: r.username, role: isAdmin(r.role) ? 'admin' : 'member', publicKey: r.public_key })),
      }
    },

    // Adds an account, with the vault key and name sealed to its public key.
    'POST /v1/vaults/members/add': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const vault = adminOf(str(body.vaultId, 'vaultId', 64, ID_RE), user.id)
      const other = q.userByName.get(usernameOf(body.username)) as UserRow | undefined
      const role = roleOf(body.role)
      const wrappedKey = str(body.wrappedKey, 'wrappedKey', 1024, B64_RE)
      const meta = str(body.meta, 'meta', 4096, B64_RE)
      if (!other?.public_key) throw new HttpError(404, 'No account by that name can be added to a vault yet')
      if (body.epoch !== vault.epoch) throw new HttpError(409, 'The vault key changed; try again')
      db.exec('BEGIN IMMEDIATE')
      try {
        if (q.membership.get(vault.id, other.id)) throw new HttpError(409, 'Already a member')
        if ((q.vaultCount.get(other.id) as { n: number }).n >= LIMITS.vaultsPerUser) throw new HttpError(413, 'That account has too many vaults')
        q.insertMember.run(vault.id, other.id, role, wrappedKey, meta)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return { ok: true }
    },

    'POST /v1/vaults/members/role': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const vault = adminOf(str(body.vaultId, 'vaultId', 64, ID_RE), user.id)
      const other = q.userByName.get(usernameOf(body.username)) as UserRow | undefined
      const role = roleOf(body.role)
      const current = other && (q.membership.get(vault.id, other.id) as { role: string } | undefined)
      if (!other || !current) throw new HttpError(404, 'Not a member')
      if (isAdmin(current.role) && role === 'member' && (q.adminCount.get(vault.id) as { n: number }).n === 1) {
        throw new HttpError(409, 'A vault needs at least one admin')
      }
      q.setRole.run(role, vault.id, other.id)
      return { ok: true }
    },

    // Removes a member. Their app keeps what it already had, so the admin's
    // app then makes a new vault key (POST /v1/vaults/rekey).
    'POST /v1/vaults/members/remove': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const vault = adminOf(str(body.vaultId, 'vaultId', 64, ID_RE), user.id)
      const other = q.userByName.get(usernameOf(body.username)) as UserRow | undefined
      const current = other && (q.membership.get(vault.id, other.id) as { role: string } | undefined)
      if (!other || !current) throw new HttpError(404, 'Not a member')
      if (isAdmin(current.role) && (q.adminCount.get(vault.id) as { n: number }).n === 1) {
        throw new HttpError(409, 'A vault needs at least one admin')
      }
      q.removeMember.run(vault.id, other.id)
      return { ok: true }
    },

    // A new vault key: every member's sealed copy and every item, re-encrypted,
    // replaced in one go. Each item gets a new sequence number, so every device
    // reads them all again.
    'POST /v1/vaults/rekey': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const vault = adminOf(str(body.vaultId, 'vaultId', 64, ID_RE), user.id)
      if (body.epoch !== vault.epoch) throw new HttpError(409, 'The vault key changed; try again')
      if (!Array.isArray(body.keys) || !Array.isArray(body.items)) throw new HttpError(400, 'Invalid rekey')
      const keys = new Map<string, string>()
      for (const k of body.keys as Array<Record<string, unknown>>) {
        keys.set(usernameOf(k?.username), str(k?.wrappedKey, 'wrappedKey', 1024, B64_RE))
      }
      const items = new Map<string, string>()
      for (const i of body.items as Array<Record<string, unknown>>) {
        items.set(str(i?.id, 'id', 64, ID_RE), str(i?.blob, 'blob', LIMITS.blobChars, B64_RE))
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        const members = q.members.all(vault.id) as Array<{ id: number; username: string }>
        if (members.length !== keys.size || members.some((m) => !keys.has(m.username))) {
          throw new HttpError(409, 'The members changed; try again')
        }
        const existing = (q.vaultIds.all(vault.id) as Array<{ id: string }>).map((r) => r.id)
        if (existing.length !== items.size || existing.some((id) => !items.has(id))) {
          throw new HttpError(409, 'The vault changed; try again')
        }
        for (const m of members) q.setMemberKey.run(keys.get(m.username)!, vault.id, m.id)
        for (const [id, blob] of items) {
          const seq = (q.vaultBumpSeq.get(vault.id) as { seq: number }).seq
          q.vaultUpsertItem.run(vault.id, id, seq, blob)
        }
        const { epoch } = q.bumpEpoch.get(vault.id) as { epoch: number }
        db.exec('COMMIT')
        return { ok: true, epoch }
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },

    'GET /v1/vaults/sync': (req, url) => {
      const { user } = authenticate(req)
      const vault = memberOf(str(url.searchParams.get('vault'), 'vault', 64, ID_RE), user.id)
      const since = Number(url.searchParams.get('since') ?? '0')
      if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'Invalid since')
      const rows = q.vaultPull.all(vault.id, since, LIMITS.pullPage + 1) as Array<{ id: string; seq: number; blob: string }>
      const more = rows.length > LIMITS.pullPage
      const items = more ? rows.slice(0, LIMITS.pullPage) : rows
      return { items, more, cursor: items.at(-1)?.seq ?? since, head: vault.seq }
    },

    'POST /v1/vaults/sync': async (req) => {
      const { user } = authenticate(req)
      const body = await readJson(req)
      const vault = memberOf(str(body.vaultId, 'vaultId', 64, ID_RE), user.id)
      const parsed = parseChanges(body.changes)
      // A member writes only their own items (known hosts they trusted, their key).
      if (!isAdmin(vault.role)) {
        const own = `${memberTag(user.username)}-`
        if (parsed.some((c) => !c.id.startsWith(own))) throw new HttpError(403, 'Only the vault\'s admins can change it')
      }
      return applyChanges(parsed, {
        count: () => (q.vaultItemCount.get(vault.id) as { n: number }).n,
        limit: LIMITS.itemsPerVault,
        item: (id) => q.vaultItem.get(vault.id, id) as { id: string; seq: number; blob: string } | undefined,
        bump: () => (q.vaultBumpSeq.get(vault.id) as { seq: number }).seq,
        upsert: (id, seq, blob) => q.vaultUpsertItem.run(vault.id, id, seq, blob),
      })
    },

    'POST /v1/sync': async (req) => {
      const { user } = authenticate(req)
      const parsed = parseChanges((await readJson(req)).changes)
      return applyChanges(parsed, {
        count: () => (q.itemCount.get(user.id) as { n: number }).n,
        limit: LIMITS.itemsPerUser,
        item: (id) => q.item.get(user.id, id) as { id: string; seq: number; blob: string } | undefined,
        bump: () => (q.bumpSeq.get(user.id) as { seq: number }).seq,
        upsert: (id, seq, blob) => q.upsertItem.run(user.id, id, seq, blob),
      })
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
