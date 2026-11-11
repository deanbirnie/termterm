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

  pull(since: number): Promise<{ items: RemoteItem[]; cursor: number; more: boolean }> {
    return this.call('GET', `/sync?since=${since}`)
  }

  push(changes: Change[]): Promise<{ results: PushResult[] }> {
    return this.call('POST', '/sync', { changes })
  }
}

export interface SyncSummary {
  pulled: number
  pushed: number
}

const PUSH_BATCH = 200

/**
 * One full sync round: pull everything newer than our cursor, then push local
 * changes. Push conflicts (another device got there first) are merged and
 * retried; the loop is bounded so a misbehaving server cannot spin us forever.
 */
export async function syncVault(vault: Vault, fetchImpl?: typeof fetch): Promise<SyncSummary> {
  const state = vault.sync
  if (!state) throw new Error('Sync is not configured')
  const api = new SyncApi(state.serverUrl, vault.syncToken(), fetchImpl)
  const summary: SyncSummary = { pulled: 0, pushed: 0 }

  let cursor = state.cursor
  for (;;) {
    const page = await api.pull(cursor)
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
  return summary
}
