// Vaults beyond the Personal one, synced through sync server accounts: the
// Personal vault's own account, and further accounts with their own password.
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VaultService, type Platform } from '../../../packages/app/src/index.ts'
import { createApp } from '../src/app.ts'

const host = (label: string) => ({ label, address: `${label}.test`, port: 22, username: 'u', tags: [], keyId: null })

let url: string
let other: string
let app: ReturnType<typeof createApp>
let app2: ReturnType<typeof createApp>

async function start(): Promise<{ app: ReturnType<typeof createApp>; url: string }> {
  const a = createApp({ dbPath: ':memory:' })
  await new Promise<void>((r) => a.server.listen(0, '127.0.0.1', r))
  return { app: a, url: `http://127.0.0.1:${(a.server.address() as AddressInfo).port}` }
}

beforeEach(async () => {
  ;({ app, url } = await start())
  ;({ app: app2, url: other } = await start())
})
afterEach(async () => {
  await new Promise<void>((r) => app.server.close(() => r()))
  await new Promise<void>((r) => app2.server.close(() => r()))
})

/** A device: its files, and the service that opens them. */
function device() {
  const files = new Map<string, string>()
  const platform: Platform = {
    storage: {
      read: async () => files.get('vault') ?? null,
      write: async (data) => void files.set('vault', data),
      readNamed: async (name) => files.get(name) ?? null,
      writeNamed: async (name, data) => void files.set(name, data),
      removeNamed: async (name) => void files.delete(name),
    },
    deviceKey: { available: async () => false, has: async () => false, save: async () => {}, load: async () => null, clear: () => {} },
    keys: { generate: () => Promise.reject(new Error('unused')), import: () => Promise.reject(new Error('unused')) },
    deviceName: () => 'test device',
    rememberDevice: () => false,
  }
  return { files, open: () => new VaultService(platform, () => undefined, () => undefined) }
}

const labels = (s: VaultService) => s.snapshot().hosts.map((h) => h.label).sort()

describe('vaults on sync servers', () => {
  it('syncs a further vault through the Personal account to a second device', async () => {
    const a = device().open()
    await a.create('master-password')
    await a.syncRegister({ serverUrl: url, username: 'alice', password: 'master-password' })
    const work = a.addVault('Work')
    a.switchVault(work)
    a.saveHost(null, host('office'))
    await a.connectVault(work, 'personal')
    expect(a.snapshot().servers).toMatchObject([{ id: 'personal', personal: true, vaultIds: ['personal', work] }])
    expect(a.snapshot().vaults[1]).toMatchObject({ id: work, serverId: 'personal', pending: 0 })

    // A new device signs in with the master password, then adds the vault.
    const b = device().open()
    await b.signIn({ serverUrl: url, username: 'alice', password: 'master-password' })
    expect(await b.serverVaults('personal')).toEqual([{ id: work, name: 'Work', onDevice: false }])
    await b.addServerVault('personal', work)
    b.switchVault(work)
    expect(labels(b)).toEqual(['office'])
    expect(b.snapshot().hosts.length).toBe(1)
    b.switchVault('personal')
    expect(labels(b)).toEqual([]) // the Work hosts stay in the Work vault

    // Edits go both ways; the Personal vault syncs as before.
    b.switchVault(work)
    b.saveHost(null, host('second'))
    await b.syncNow()
    await a.syncNow()
    expect(labels(a)).toEqual(['office', 'second'])
  })

  it('a further server has its own account and password; the vault reaches another device there', async () => {
    const a = device().open()
    await a.create('master-password')
    await a.syncRegister({ serverUrl: url, username: 'alice', password: 'master-password' })
    const team = await a.addServer({ serverUrl: other, username: 'alice', password: 'team-password', create: true })
    const work = a.addVault('Work')
    a.switchVault(work)
    a.saveHost(null, host('office'))
    await a.connectVault(work, team)
    expect(a.snapshot().servers.map((s) => [s.serverUrl, s.vaultIds])).toEqual([
      [url, ['personal']],
      [other, [work]],
    ])
    // Nothing of it on the Personal account's server.
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM vaults').get()).toEqual({ n: 0 })

    // A device with no Personal sync at all signs in to that server only.
    const b = device().open()
    await b.create('another-password')
    await expect(b.addServer({ serverUrl: other, username: 'alice', password: 'wrong-password', create: false })).rejects.toThrow()
    const there = await b.addServer({ serverUrl: other, username: 'alice', password: 'team-password', create: false })
    await b.addServerVault(there, work)
    b.switchVault(work)
    expect(labels(b)).toEqual(['office'])
    expect(b.snapshot().vaults.map((v) => v.name)).toEqual(['Personal', 'Work'])
  })

  it('refuses an older server, and an account this device already has', async () => {
    const a = device().open()
    await a.create('master-password')
    await a.syncRegister({ serverUrl: url, username: 'alice', password: 'master-password' })
    await expect(a.addServer({ serverUrl: url, username: 'alice', password: 'x-password', create: false })).rejects.toThrow(
      'already signed in',
    )
    const old = createApp({ dbPath: ':memory:' })
    // An older server: no `features` in its health answer.
    const realHandler = old.server.listeners('request')[0] as (req: unknown, res: { setHeader: unknown; end: (s: string) => void; writeHead: unknown }) => void
    old.server.removeAllListeners('request')
    old.server.on('request', (req: { url?: string }, res: { writeHead(n: number, h: object): void; end(s: string): void }) => {
      if (req.url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, version: '0.13.0' }))
      }
      realHandler(req, res as never)
    })
    await new Promise<void>((r) => old.server.listen(0, '127.0.0.1', r))
    const oldUrl = `http://127.0.0.1:${(old.server.address() as AddressInfo).port}`
    try {
      await expect(a.addServer({ serverUrl: oldUrl, username: 'bob', password: 'bob-password', create: true })).rejects.toThrow(
        'must be updated',
      )
    } finally {
      await new Promise<void>((r) => old.server.close(() => r()))
    }
  })

  it('stops syncing a vault, or deletes it from the server and every device', async () => {
    const a = device().open()
    await a.create('master-password')
    await a.syncRegister({ serverUrl: url, username: 'alice', password: 'master-password' })
    const work = a.addVault('Work')
    const lab = a.addVault('Lab')
    await a.connectVault(work, 'personal')
    await a.connectVault(lab, 'personal')
    await a.disconnectVault(lab)
    expect(a.snapshot().vaults.find((v) => v.id === lab)?.serverId).toBeUndefined()
    expect((await a.serverVaults('personal')).map((v) => v.id).sort()).toEqual([lab, work].sort()) // the server's copy stays
    await a.connectVault(lab, 'personal') // and it can come back
    await a.deleteVault(work, { fromServer: true })
    expect((await a.serverVaults('personal')).map((v) => v.id)).toEqual([lab])
    // Turning off Personal sync stops the vaults on that account too.
    await a.syncDisconnect()
    expect(a.snapshot().servers).toEqual([])
    expect(a.snapshot().vaults.find((v) => v.id === lab)?.serverId).toBeUndefined()
  })

  it('keeps server connections across a restart, and signs in again when signed out', async () => {
    const d = device()
    const a = d.open()
    await a.create('master-password')
    const team = await a.addServer({ serverUrl: other, username: 'alice', password: 'team-password', create: true })
    const work = a.addVault('Work')
    await a.connectVault(work, team)
    a.lock()

    const again = d.open()
    await again.unlock('master-password')
    expect(again.snapshot().servers).toMatchObject([{ id: team, serverUrl: other, vaultIds: [work] }])

    // The server signs every session out (the account's password changed, say).
    app2.db.prepare('DELETE FROM sessions').run()
    again.switchVault(work)
    again.saveHost(null, host('later'))
    await again.syncNow()
    expect(again.snapshot().servers[0]).toMatchObject({ needsSignIn: true })
    await expect(again.serverSignIn(team, 'wrong-password')).rejects.toThrow()
    await again.serverSignIn(team, 'team-password')
    expect(again.snapshot().servers[0]).toMatchObject({ needsSignIn: false })
    expect(again.snapshot().vaults.find((v) => v.id === work)?.pending).toBe(0)

    await again.removeServer(team)
    expect(again.snapshot().servers).toEqual([])
    expect(again.snapshot().vaults.find((v) => v.id === work)).toMatchObject({ name: 'Work' })
  })
})
