/**
 * Compatibility with earlier releases.
 *
 * - Vault files and server databases written by earlier releases' own code
 *   (compat/fixtures/<tag>, made by compat/make-fixtures.sh) open in today's
 *   app and server, with everything in them.
 * - An older app (0.9.0's code, frozen in compat/v0.9.0) and today's app sync
 *   together, through either release's server.
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import * as now from '../../../packages/core/src/index.ts'
import { VaultService, type Platform } from '../../../packages/app/src/index.ts'
import { createApp } from '../src/app.ts'
import * as old from './compat/v0.9.0/packages/core/src/index.ts'
import { createApp as createOldApp } from './compat/v0.9.0/apps/server/src/app.ts'

const fixtures = join(import.meta.dirname, 'compat/fixtures')
const tags = readdirSync(fixtures).sort()
const tmp = mkdtempSync(join(tmpdir(), 'termterm-compat-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

type Expected = {
  password: string
  username: string
  local: { items: Array<{ id: string; type: string; data: unknown }>; deletedId: string }
  synced: { items: Array<{ id: string; type: string; data: unknown }>; deletedId: string }
}
const read = (tag: string, file: string) => readFileSync(join(fixtures, tag, file), 'utf8')
const items = (vault: { list(): Array<{ id: string; type: string; data: unknown }> }) =>
  vault
    .list()
    .filter((i) => i.type !== 'history')
    .map(({ id, type, data }) => ({ id, type, data }))
    .sort((a, b) => a.id.localeCompare(b.id))

async function serve(make: typeof createApp, dbPath: string) {
  const app = make({ dbPath })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => app.server.close(() => r())),
  }
}

type Core = typeof now | typeof old

/** Signs a new device in to an account, with whichever release's core. */
async function signIn(core: typeof now, url: string, username: string, password: string): Promise<now.Vault>
async function signIn(core: typeof old, url: string, username: string, password: string): Promise<old.Vault>
async function signIn(core: Core, url: string, username: string, password: string) {
  const api = new core.SyncApi(url)
  const kdf = await api.prelogin(username)
  const { authKey } = await core.deriveKeys(password, kdf)
  const { token, wrappedVaultKey } = await api.login(username, authKey)
  const vault = await core.Vault.fromAccount(kdf, wrappedVaultKey, password)
  vault.setSync(url, username, token)
  return vault
}

async function register(core: typeof now, url: string, username: string, password: string): Promise<now.Vault>
async function register(core: typeof old, url: string, username: string, password: string): Promise<old.Vault>
async function register(core: Core, url: string, username: string, password: string) {
  const vault = await core.Vault.create(password)
  const token = await new core.SyncApi(url).register(username, vault.kdf, await vault.authKeyFor(password), vault.wrappedVaultKey)
  vault.setSync(url, username, token)
  return vault
}

const host = (label: string, extra: object = {}) => ({ label, address: `${label}.example`, port: 22, username: 'u', tags: [], ...extra })

describe.each(tags)('data written by %s', (tag) => {
  const expected = JSON.parse(read(tag, 'expected.json')) as Expected

  it('its unsynced vault opens with everything in it, and keeps it when saved again', async () => {
    const vault = await now.Vault.unlock(JSON.parse(read(tag, 'vault-local.json')), expected.password)
    expect(items(vault)).toEqual(expected.local.items)
    expect(vault.get(expected.local.deletedId)).toBeUndefined()
    const again = await now.Vault.unlock(vault.toFile(), expected.password)
    expect(items(again)).toEqual(expected.local.items)
    await expect(now.Vault.unlock(JSON.parse(read(tag, 'vault-local.json')), 'wrong password')).rejects.toBeInstanceOf(
      now.WrongPasswordError,
    )
  })

  it('the app opens its vault file and lists its hosts', async () => {
    let file: string | null = read(tag, 'vault-local.json')
    const platform: Platform = {
      storage: { read: async () => file, write: async (d) => void (file = d) },
      deviceKey: { available: async () => false, has: async () => false, save: async () => {}, load: async () => null, clear: () => {} },
      keys: { generate: () => Promise.reject(new Error('unused')), import: () => Promise.reject(new Error('unused')) },
      deviceName: () => 'compat',
      rememberDevice: () => false,
    }
    const service = new VaultService(platform, () => undefined, () => undefined)
    expect(await service.phase()).toBe('locked')
    await service.unlock(expected.password)
    const hosts = expected.local.items.filter((i) => i.type === 'host').length
    expect(service.snapshot().hosts).toHaveLength(hosts)
  })

  it('today’s server opens its database; its synced vault and a new device both sync', async () => {
    const dbPath = join(tmp, `${tag}.db`)
    copyFileSync(join(fixtures, tag, 'server.sqlite'), dbPath)
    const server = await serve(createApp, dbPath)
    try {
      // The vault that synced with that release, now pointed at today's server.
      const file = JSON.parse(read(tag, 'vault-synced.json'))
      file.sync.serverUrl = server.url
      const vault = await now.Vault.unlock(file, expected.password)
      expect(await now.syncVault(vault)).toMatchObject({ pulled: 0, pushed: 0, rolledBack: 0, serverBehind: false })
      expect(items(vault)).toEqual(expected.synced.items)

      const fresh = await signIn(now, server.url, expected.username, expected.password)
      await now.syncVault(fresh)
      expect(items(fresh)).toEqual(expected.synced.items)
      expect(fresh.get(expected.synced.deletedId)).toBeUndefined()

      // And they keep working together.
      const first = expected.synced.items.find((i) => i.type === 'host')!
      vault.put('host', { ...(first.data as object), label: 'edited after the upgrade' }, first.id)
      await now.syncVault(vault)
      await now.syncVault(fresh)
      expect(fresh.get<now.HostData>(first.id)?.data.label).toBe('edited after the upgrade')
    } finally {
      await server.close()
    }
  })
})

describe('0.9.0 and today’s app together', () => {
  it.each([
    ['today’s server', createApp, 'mixed-new.db'],
    ['a 0.9.0 server', createOldApp, 'mixed-old.db'],
  ] as const)('sync both ways through %s', async (_name, make, db) => {
    const server = await serve(make as typeof createApp, join(tmp, db))
    try {
      const older = await register(old, server.url, 'mixed', 'mixed password')
      const kept = older.put('host', host('from-old'))
      const gone = older.put('host', host('to-delete'))
      const identity = older.put('identity', { label: 'Ops', username: 'ops' })
      older.put('host', host('grouped', { identityId: identity.id, group: 'Lab' }))
      await old.syncVault(older)

      const newer = await signIn(now, server.url, 'mixed', 'mixed password')
      await now.syncVault(newer)
      expect(newer.list('host')).toHaveLength(3)

      // Edits and deletions cross in both directions.
      newer.put('host', host('edited-by-new'), kept.id)
      newer.delete(gone.id)
      const added = newer.put('host', host('added-by-new'))
      const summary = await now.syncVault(newer)
      await old.syncVault(older)
      expect(older.get<now.HostData>(kept.id)?.data.label).toBe('edited-by-new')
      expect(older.get(gone.id)).toBeUndefined()
      expect(older.get<now.HostData>(added.id)?.data.label).toBe('added-by-new')

      older.put('host', host('edited-by-old'), added.id)
      await old.syncVault(older)
      await now.syncVault(newer)
      expect(newer.get<now.HostData>(added.id)?.data.label).toBe('edited-by-old')
      const grouped = newer.list<now.HostData>('host').find((h) => h.data.label === 'grouped')
      expect(grouped?.data).toMatchObject({ identityId: identity.id, group: 'Lab' })

      // No false alarms from rollback protection, whichever server it is.
      expect(summary).toMatchObject({ rolledBack: 0, serverBehind: false })
      expect(await now.syncVault(newer)).toMatchObject({ rolledBack: 0, serverBehind: false })
    } finally {
      await server.close()
    }
  })

  it('today’s app says nothing about storage on a 0.9.0 server, rather than failing', async () => {
    const server = await serve(createOldApp as unknown as typeof createApp, join(tmp, 'usage-old.db'))
    try {
      let file: string | null = null
      const service = new VaultService(
        {
          storage: { read: async () => file, write: async (d) => void (file = d) },
          deviceKey: { available: async () => false, has: async () => false, save: async () => {}, load: async () => null, clear: () => {} },
          keys: { generate: () => Promise.reject(new Error('unused')), import: () => Promise.reject(new Error('unused')) },
          deviceName: () => 'compat',
          rememberDevice: () => false,
        },
        () => undefined,
        () => undefined,
      )
      await service.create('mixed password')
      await service.syncRegister({ serverUrl: server.url, username: 'usage', password: 'mixed password' })
      expect(await service.syncUsage()).toBeNull()
    } finally {
      await server.close()
    }
  })
})
