import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SyncApi,
  Vault,
  fingerprint,
  fromBase64,
  generateAccountKeyPair,
  memberTag,
  openWith,
  randomId,
  sealTo,
  toBase64,
  utf8,
} from '../../../packages/core/src/index.ts'
import { createApp } from '../src/app.ts'

let url: string
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  app = createApp({ dbPath: ':memory:' })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => app.server.close(() => r())))

/** An account with a key pair, as an app sets one up. */
async function account(username: string) {
  const account = await Vault.create('password123')
  const api = new SyncApi(url)
  await api.register(username, account.kdf, await account.authKeyFor('password123'), account.wrappedVaultKey)
  const pair = generateAccountKeyPair()
  await api.setAccountKeys(toBase64(pair.publicKey), account.sealText(toBase64(pair.privateKey), 'account-private-key'))
  return { username, api, account, pair }
}

describe('shared vaults on the server', () => {
  it('keeps an account key pair: set once, its private key sealed, its public key for others', async () => {
    const a = await account('alice')
    const b = await account('bob')
    const mine = await a.api.accountKeys()
    expect(mine.publicKey).toBe(toBase64(a.pair.publicKey))
    expect(a.account.openText(mine.sealedPrivateKey!, 'account-private-key')).toBe(toBase64(a.pair.privateKey))
    // Sealing it again is fine; a different key pair is not.
    await a.api.setAccountKeys(mine.publicKey!, a.account.sealText(toBase64(a.pair.privateKey), 'account-private-key'))
    await expect(a.api.setAccountKeys(toBase64(generateAccountKeyPair().publicKey), 'AAAA')).rejects.toMatchObject({ status: 409 })
    expect(await b.api.userKey('alice')).toBe(mine.publicKey)
    await expect(b.api.userKey('nobody')).rejects.toMatchObject({ status: 404 })
    expect(fingerprint(a.pair.publicKey)).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/)
  })

  it('an admin adds a member, who opens the vault key and reads, but writes only their own items', async () => {
    const a = await account('alice')
    const b = await account('bob')
    const id = randomId()
    const vaultKey = Vault.createWithKey().exportKey()
    await a.api.createVault(id, a.account.sealText(toBase64(vaultKey), `vault-key:${id}`), 'AAAA')
    await a.api.vaultPush(id, [{ id: 'host-1', baseSeq: 0, blob: 'AAAA' }])

    const bobKey = fromBase64(await a.api.userKey('bob'))
    await a.api.addMember(id, 0, { username: 'bob', role: 'member', wrappedKey: sealTo(bobKey, vaultKey, `vault-key:${id}`), meta: sealTo(bobKey, utf8('{}'), `vault-meta:${id}`) })
    await expect(a.api.addMember(id, 0, { username: 'bob', role: 'member', wrappedKey: 'AAAA', meta: 'AAAA' })).rejects.toMatchObject({ status: 409 })

    const [listed] = await b.api.vaults()
    expect(listed).toMatchObject({ id, role: 'member', epoch: 0 })
    expect(openWith(b.pair.privateKey, listed!.wrappedKey, `vault-key:${id}`)).toEqual(vaultKey)
    expect((await b.api.vaultPull(id, 0)).items.map((i) => i.id)).toEqual(['host-1'])
    expect(await b.api.members(id)).toEqual([
      { username: 'alice', role: 'admin', publicKey: toBase64(a.pair.publicKey) },
      { username: 'bob', role: 'member', publicKey: toBase64(b.pair.publicKey) },
    ])

    await expect(b.api.vaultPush(id, [{ id: 'host-2', baseSeq: 0, blob: 'AAAA' }])).rejects.toMatchObject({ status: 403 })
    const own = `${memberTag('bob')}-known-1`
    expect((await b.api.vaultPush(id, [{ id: own, baseSeq: 0, blob: 'AAAA' }])).results[0]).toMatchObject({ status: 'ok' })
    // Someone else's tag is not theirs.
    await expect(b.api.vaultPush(id, [{ id: `${memberTag('alice')}-x`, baseSeq: 0, blob: 'AAAA' }])).rejects.toMatchObject({ status: 403 })
    // Members manage nothing.
    await expect(b.api.addMember(id, 0, { username: 'alice', role: 'member', wrappedKey: 'AAAA', meta: 'AAAA' })).rejects.toMatchObject({ status: 403 })
    await expect(b.api.setMemberRole(id, 'bob', 'admin')).rejects.toMatchObject({ status: 403 })
    await expect(b.api.removeMember(id, 'alice')).rejects.toMatchObject({ status: 403 })
  })

  it('keeps an admin: the last one cannot step down, be removed, or leave others behind', async () => {
    const a = await account('alice')
    const b = await account('bob')
    const id = randomId()
    await a.api.createVault(id, 'AAAA', 'AAAA')
    await a.api.addMember(id, 0, { username: 'bob', role: 'member', wrappedKey: 'AAAA', meta: 'AAAA' })
    await expect(a.api.setMemberRole(id, 'alice', 'member')).rejects.toMatchObject({ status: 409 })
    await expect(a.api.removeMember(id, 'alice')).rejects.toMatchObject({ status: 409 })
    await expect(a.api.leaveVault(id)).rejects.toMatchObject({ status: 409 })
    await a.api.setMemberRole(id, 'bob', 'admin')
    await b.api.setMemberRole(id, 'alice', 'member') // bob is an admin now
    await a.api.leaveVault(id)
    expect((await b.api.members(id)).map((m) => m.username)).toEqual(['bob'])
  })

  it('a new vault key replaces every member copy and every item at once, or nothing', async () => {
    const a = await account('alice')
    const b = await account('bob')
    const c = await account('carol')
    const id = randomId()
    await a.api.createVault(id, 'AAAA', 'AAAA')
    for (const u of ['bob', 'carol']) await a.api.addMember(id, 0, { username: u, role: 'member', wrappedKey: 'AAAA', meta: 'AAAA' })
    await a.api.vaultPush(id, [
      { id: 'one', baseSeq: 0, blob: 'AAAA' },
      { id: 'two', baseSeq: 0, blob: 'AAAA' },
    ])
    await a.api.removeMember(id, 'carol')
    await expect(c.api.vaultPull(id, 0)).rejects.toMatchObject({ status: 404 })

    const keys = [
      { username: 'alice', wrappedKey: 'QUxJQ0U=' },
      { username: 'bob', wrappedKey: 'Qk9C' },
    ]
    // Missing an item, or still sealing for carol: refused, nothing changes.
    await expect(a.api.rekeyVault(id, 0, keys, [{ id: 'one', blob: 'BBBB' }])).rejects.toMatchObject({ status: 409 })
    await expect(
      a.api.rekeyVault(id, 0, [...keys, { username: 'carol', wrappedKey: 'AAAA' }], [{ id: 'one', blob: 'BBBB' }, { id: 'two', blob: 'BBBB' }]),
    ).rejects.toMatchObject({ status: 409 })
    // A member cannot.
    await expect(b.api.rekeyVault(id, 0, keys, [])).rejects.toMatchObject({ status: 403 })

    const { epoch } = await a.api.rekeyVault(id, 0, keys, [{ id: 'one', blob: 'BBBB' }, { id: 'two', blob: 'CCCC' }])
    expect(epoch).toBe(1)
    const [listed] = await b.api.vaults()
    expect(listed).toMatchObject({ wrappedKey: 'Qk9C', epoch: 1, head: 4 })
    expect((await b.api.vaultPull(id, 2)).items.map((i) => [i.id, i.blob])).toEqual([['one', 'BBBB'], ['two', 'CCCC']])
    // A stale epoch is refused (another admin got there first).
    await expect(a.api.rekeyVault(id, 0, keys, [{ id: 'one', blob: 'B' }, { id: 'two', blob: 'C' }])).rejects.toMatchObject({ status: 409 })
    await expect(a.api.addMember(id, 0, { username: 'carol', role: 'member', wrappedKey: 'AAAA', meta: 'AAAA' })).rejects.toMatchObject({ status: 409 })
  })

  it('says the server can share vaults', async () => {
    expect(await new SyncApi(url).features()).toEqual(['vaults', 'shared'])
  })
})
