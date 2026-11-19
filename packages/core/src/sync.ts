import { toBase64 } from './bytes.ts'
import { validateKdfParams, type KdfParams } from './crypto.ts'
import type { Vault } from './vault.ts'

export interface RemoteItem {
  id: string
  seq: number
  blob: string
}

export interface Change {
  id: string
  /** server sequence the change was made on top of; 0 for a new item */
  baseSeq: number
  blob: string
}

export type PushResult =
  | { id: string; status: 'ok'; seq: number }
  | { id: string; status: 'conflict'; item: RemoteItem }

export interface RemoteSession {
  id: string
  /** device name sealed with the vault key, or null if the device never set one */
  label: string | null
  createdAt: number
  lastUsedAt: number
  current: boolean
}

/** A vault on the server that the account is a member of; key and name are sealed for the account. */
export interface RemoteVault {
  id: string
  role: string
  wrappedKey: string
  meta: string
  head: number
  /** Which vault key: it goes up each time the key is replaced (after removing a member). Servers before 0.14 omit it. */
  epoch?: number
  /** How many accounts are members (servers before 0.14 omit it). */
  members?: number
}

export interface RemoteMember {
  username: string
  role: 'admin' | 'member'
  /** null for an account that never made a key pair */
  publicKey: string | null
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

export function normalizeServerUrl(input: string): string {
  let raw = input.trim()
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Server URL must be http(s)')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** Plain HTTP is only acceptable for a server on this machine. */
export function isInsecureUrl(serverUrl: string): boolean {
  const url = new URL(serverUrl)
  return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/** Thin typed wrapper over the sync server's HTTP API. */
export class SyncApi {
  constructor(
    readonly serverUrl: string,
    private token?: string,
    // Wrapped, not passed bare: browsers reject fetch called as a method of another object.
    private fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.serverUrl}/v1${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      throw new SyncError(`Cannot reach sync server: ${(e as Error).message}`, 0)
    }
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new SyncError(`Unexpected response from sync server (HTTP ${res.status})`, res.status)
    }
    if (!res.ok) {
      const msg = (json as { error?: string }).error ?? `HTTP ${res.status}`
      throw new SyncError(msg, res.status)
    }
    return json as T
  }

  async prelogin(username: string): Promise<KdfParams> {
    const { kdf } = await this.call<{ kdf: KdfParams }>('POST', '/prelogin', { username })
    validateKdfParams(kdf)
    return kdf
  }

  async register(
    username: string,
    kdf: KdfParams,
    authKey: Uint8Array,
    wrappedVaultKey: string,
  ): Promise<string> {
    const { token } = await this.call<{ token: string }>('POST', '/register', {
      username,
      kdf,
      authKey: toBase64(authKey),
      wrappedVaultKey,
    })
    this.token = token
    return token
  }

  async login(
    username: string,
    authKey: Uint8Array,
  ): Promise<{ token: string; wrappedVaultKey: string }> {
    const out = await this.call<{ token: string; wrappedVaultKey: string }>('POST', '/login', {
      username,
      authKey: toBase64(authKey),
    })
    this.token = out.token
    return out
  }

  /** Rotates the account's auth key and wrapped vault key; signs out every other device. */
  changePassword(
    currentAuthKey: Uint8Array,
    newAuthKey: Uint8Array,
    kdf: KdfParams,
    wrappedVaultKey: string,
  ): Promise<unknown> {
    return this.call('POST', '/password', {
      authKey: toBase64(currentAuthKey),
      newAuthKey: toBase64(newAuthKey),
      kdf,
      wrappedVaultKey,
    })
  }

  /** Deletes the account, its stored items and every session. Needs the current auth key. */
  deleteAccount(authKey: Uint8Array): Promise<unknown> {
    return this.call('POST', '/account/delete', { authKey: toBase64(authKey) })
  }

  /** What the account stores on the server: item count (deletions included) and ciphertext size. */
  usage(): Promise<{ items: number; bytes: number; maxItems: number; vaultItems?: number; vaultBytes?: number }> {
    return this.call('GET', '/usage')
  }

  async sessions(): Promise<RemoteSession[]> {
    return (await this.call<{ sessions: RemoteSession[] }>('GET', '/sessions')).sessions
  }

  /** Names the current session. The label is ciphertext to the server. */
  labelSession(label: string): Promise<unknown> {
    return this.call('POST', '/sessions/label', { label })
  }

  revokeSession(id: string): Promise<unknown> {
    return this.call('POST', '/sessions/revoke', { id })
  }

  logout(): Promise<unknown> {
    return this.call('POST', '/logout')
  }

  /** `head` (servers from 0.10 on): the account's newest sequence number. */
  pull(since: number): Promise<{ items: RemoteItem[]; cursor: number; more: boolean; head?: number }> {
    return this.call('GET', `/sync?since=${since}`)
  }

  push(changes: Change[]): Promise<{ results: PushResult[] }> {
    return this.call('POST', '/sync', { changes })
  }

  /** What the server can do beyond the first release (`vaults`: more than one vault per account). */
  async features(): Promise<string[]> {
    const out = await this.call<{ features?: unknown }>('GET', '/health')
    return Array.isArray(out.features) ? out.features.filter((f): f is string => typeof f === 'string') : []
  }

  async vaults(): Promise<RemoteVault[]> {
    return (await this.call<{ vaults: RemoteVault[] }>('GET', '/vaults')).vaults
  }

  createVault(id: string, wrappedKey: string, meta: string): Promise<unknown> {
    return this.call('POST', '/vaults', { id, wrappedKey, meta })
  }

  /** Replaces this account's sealed copy of a vault's key or name. */
  updateVault(vaultId: string, change: { wrappedKey?: string; meta?: string }): Promise<unknown> {
    return this.call('POST', '/vaults/update', { vaultId, ...change })
  }

  /** Leaves a vault; the server deletes it once no member is left. */
  leaveVault(vaultId: string): Promise<unknown> {
    return this.call('POST', '/vaults/leave', { vaultId })
  }

  vaultPull(vaultId: string, since: number): Promise<{ items: RemoteItem[]; cursor: number; more: boolean; head?: number }> {
    return this.call('GET', `/vaults/sync?vault=${encodeURIComponent(vaultId)}&since=${since}`)
  }

  vaultPush(vaultId: string, changes: Change[]): Promise<{ results: PushResult[] }> {
    return this.call('POST', '/vaults/sync', { vaultId, changes })
  }

  // ---- shared vaults ----

  accountKeys(): Promise<{ publicKey: string | null; sealedPrivateKey: string | null }> {
    return this.call('GET', '/account/keys')
  }

  setAccountKeys(publicKey: string, sealedPrivateKey: string): Promise<unknown> {
    return this.call('POST', '/account/keys', { publicKey, sealedPrivateKey })
  }

  async userKey(username: string): Promise<string> {
    return (await this.call<{ publicKey: string }>('POST', '/users/key', { username })).publicKey
  }

  async members(vaultId: string): Promise<RemoteMember[]> {
    return (await this.call<{ members: RemoteMember[] }>('GET', `/vaults/members?vault=${encodeURIComponent(vaultId)}`)).members
  }

  addMember(vaultId: string, epoch: number, member: { username: string; role: 'admin' | 'member'; wrappedKey: string; meta: string }): Promise<unknown> {
    return this.call('POST', '/vaults/members/add', { vaultId, epoch, ...member })
  }

  setMemberRole(vaultId: string, username: string, role: 'admin' | 'member'): Promise<unknown> {
    return this.call('POST', '/vaults/members/role', { vaultId, username, role })
  }

  removeMember(vaultId: string, username: string): Promise<unknown> {
    return this.call('POST', '/vaults/members/remove', { vaultId, username })
  }

  /** Replaces the vault key: every member's sealed copy and every item, at once. */
  rekeyVault(
    vaultId: string,
    epoch: number,
    keys: Array<{ username: string; wrappedKey: string }>,
    items: Array<{ id: string; blob: string }>,
  ): Promise<{ epoch: number }> {
    return this.call('POST', '/vaults/rekey', { vaultId, epoch, keys, items })
  }
}

export interface SyncSummary {
  pulled: number
  pushed: number
  /**
   * Server copies refused for being older than what this device had already
   * seen (each answered with this device's copy). Not zero means the server
   * was rolled back: restored from an old backup, or tampered with.
   */
  rolledBack: number
  /** The server had less history than this device had seen, so everything was sent again. */
  serverBehind: boolean
}

const PUSH_BATCH = 200

/**
 * One full sync round: pull everything newer than our cursor, then push local
 * changes. Push conflicts (another device got there first) are merged and
 * retried; the loop is bounded so a misbehaving server cannot spin us forever.
 */
export async function syncVault(
  vault: Vault,
  fetchImpl?: typeof fetch,
  /** The session token, for a vault that does not hold its own (see `SyncState.remoteVaultId`). */
  token?: string,
): Promise<SyncSummary> {
  const state = vault.sync
  if (!state) throw new Error('Sync is not configured')
  const client = new SyncApi(state.serverUrl, token ?? vault.syncToken(), fetchImpl)
  const remote = state.remoteVaultId
  const api = remote
    ? { pull: (since: number) => client.vaultPull(remote, since), push: (c: Change[]) => client.vaultPush(remote, c) }
    : client
  const summary: SyncSummary = { pulled: 0, pushed: 0, rolledBack: 0, serverBehind: false }

  let cursor = state.cursor
  for (;;) {
    const page = await api.pull(cursor)
    if (typeof page.head === 'number' && page.head < vault.seenSeq && !summary.serverBehind) {
      // The server's history ends before what this device has seen: read it
      // all again (older copies are refused item by item) and send ours back.
      summary.serverBehind = true
      vault.resyncAll()
      cursor = 0
      continue
    }
    for (const item of page.items) {
      if (vault.applyRemote(item)) summary.pulled++
    }
    cursor = page.cursor
    vault.setCursor(cursor)
    if (!page.more) break
  }

  for (let round = 0; round < 5; round++) {
    const dirty = vault.dirtyItems()
    if (dirty.length === 0) break
    for (let i = 0; i < dirty.length; i += PUSH_BATCH) {
      const batch = dirty.slice(i, i + PUSH_BATCH)
      const { results } = await api.push(
        batch.map(({ id, seq, blob }) => ({ id, baseSeq: seq, blob })),
      )
      for (const r of results) {
        if (r.status === 'ok') {
          const sent = batch.find((b) => b.id === r.id)
          if (sent) {
            vault.markSynced(r.id, sent.blob, r.seq)
            summary.pushed++
          }
        } else {
          if (vault.applyRemote(r.item)) summary.pulled++
        }
      }
    }
  }
  vault.setCursor(cursor)
  summary.rolledBack = vault.takeRollbacks()
  return summary
}
