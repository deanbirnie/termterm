import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SyncApi, SyncError, Vault, randomId, syncVault, type HostData } from '../../../packages/core/src/index.ts'
import { createApp } from '../src/app.ts'

const host = (label: string): HostData => ({ label, address: 'example.test', port: 22, username: 'root', tags: [] })

let url: string
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  app = createApp({ dbPath: ':memory:' })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => app.server.close(() => r())))

/** An account, and the vault whose key seals its further vaults' keys. */
async function account(username: string): Promise<{ api: SyncApi; account: Vault; token: string }> {
  const account = await Vault.create('password123')
  const api = new SyncApi(url)
  const token = await api.register(username, account.kdf, await account.authKeyFor('password123'), account.wrappedVaultKey)
  return { api, account, token }
}

/** A further vault on the server, as an app makes one: key and name sealed with the account's key. */
async function newVault(a: { api: SyncApi; account: Vault; token: string }, name: string): Promise<{ id: string; vault: Vault }> {
  const id = randomId()
  const vault = Vault.createWithKey()
  const key = Buffer.from(vault.exportKey()).toString('base64')
  await a.api.createVault(id, a.account.sealText(key, `vault-key:${id}`), a.account.sealText(JSON.stringify({ name }), `vault-meta:${id}`))
  vault.setSync(url, 'unused', '', { newAccount: true, remoteVaultId: id })
  return { id, vault }
}

describe('further vaults', () => {
  it('says the server holds more than one vault', async () => {
    expect(await new SyncApi(url).features()).toContain('vaults')
  })

  it('syncs a vault between two devices of one account, apart from the Personal items', async () => {
    const a = await account('alice')
    const { id, vault } = await newVault(a, 'Work')
    vault.put('host', host('work-box'))
    await syncVault(vault, undefined, a.token)

    // The second device lists the account's vaults and opens this one with the account's key.
    const [listed] = await a.api.vaults()
    expect(listed).toMatchObject({ id, role: 'owner', head: 1 })
    expect(JSON.parse(a.account.openText(listed!.meta, `vault-meta:${id}`))).toEqual({ name: 'Work' })
    const key = Buffer.from(a.account.openText(listed!.wrappedKey, `vault-key:${id}`), 'base64')
    const copy = Vault.createWithKey(new Uint8Array(key))
    copy.setSync(url, 'alice', '', { remoteVaultId: id })
    await syncVault(copy, undefined, a.token)
    expect(copy.list<HostData>('host').map((h) => h.data.label)).toEqual(['work-box'])

    // An edit on the second device reaches the first.
    copy.put('host', host('second'))
    await syncVault(copy, undefined, a.token)
    await syncVault(vault, undefined, a.token)
    expect(vault.list<HostData>('host').map((h) => h.data.label).sort()).toEqual(['second', 'work-box'])

    // The Personal items are untouched.
    expect((await a.api.pull(0)).items).toEqual([])
  })

  it('hides a vault from accounts that are not members of it', async () => {
    const a = await account('alice')
    const b = await account('bob')
    const { id, vault } = await newVault(a, 'Work')
    vault.put('host', host('secret'))
    await syncVault(vault, undefined, a.token)
    expect(await b.api.vaults()).toEqual([])
    await expect(b.api.vaultPull(id, 0)).rejects.toMatchObject({ status: 404 })
    await expect(b.api.vaultPush(id, [{ id: 'x', baseSeq: 0, blob: 'AAAA' }])).rejects.toMatchObject({ status: 404 })
    await expect(b.api.leaveVault(id)).rejects.toMatchObject({ status: 404 })
    // Nor can another account take its id.
    await expect(b.api.createVault(id, 'AAAA', 'AAAA')).rejects.toMatchObject({ status: 409 })
  })

  it('refuses a stale change with a conflict, as for the Personal vault', async () => {
    const a = await account('alice')
    const { id } = await newVault(a, 'Work')
    const [first] = (await a.api.vaultPush(id, [{ id: 'item', baseSeq: 0, blob: 'AAAA' }])).results
    expect(first).toMatchObject({ status: 'ok', seq: 1 })
    const [second] = (await a.api.vaultPush(id, [{ id: 'item', baseSeq: 0, blob: 'BBBB' }])).results
    expect(second).toMatchObject({ status: 'conflict', item: { id: 'item', seq: 1, blob: 'AAAA' } })
  })

  it('renames, and deletes a vault once its last member leaves', async () => {
    const a = await account('alice')
    const { id } = await newVault(a, 'Work')
    const meta = a.account.sealText(JSON.stringify({ name: 'Job' }), `vault-meta:${id}`)
    await a.api.updateVault(id, { meta })
    expect((await a.api.vaults())[0]!.meta).toBe(meta)
    await a.api.leaveVault(id)
    expect(await a.api.vaults()).toEqual([])
    // Gone for good: the id can be used again.
    await a.api.createVault(id, 'AAAA', 'AAAA')
  })

  it('deletes the vaults of a deleted account', async () => {
    const a = await account('alice')
    const { id } = await newVault(a, 'Work')
    await a.api.vaultPush(id, [{ id: 'item', baseSeq: 0, blob: 'AAAA' }])
    expect(await a.api.usage()).toMatchObject({ items: 0, vaultItems: 1 })
    await a.api.deleteAccount(await a.account.authKeyFor('password123'))
    const b = await account('bob')
    await b.api.createVault(id, 'AAAA', 'AAAA') // the id is free again
  })

  it('checks what it is sent', async () => {
    const a = await account('alice')
    await expect(a.api.createVault('bad id!', 'AAAA', 'AAAA')).rejects.toBeInstanceOf(SyncError)
    await expect(a.api.createVault(randomId(), 'not base64!', 'AAAA')).rejects.toMatchObject({ status: 400 })
    await expect(new SyncApi(url).vaults()).rejects.toMatchObject({ status: 401 })
  })
})
