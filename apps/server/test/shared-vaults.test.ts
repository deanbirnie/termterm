// Shared vaults end to end through VaultService: members, roles, personal
// logins, a member's own key, and a new vault key after removing someone.
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memberTag } from '../../../packages/core/src/index.ts'
import { VaultService, type Platform } from '../../../packages/app/src/index.ts'
import { createApp } from '../src/app.ts'

let url: string
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  app = createApp({ dbPath: ':memory:' })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => app.server.close(() => r())))

const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl own'

function device() {
  const files = new Map<string, string>()
  const key = (label: string, privateKey = 'PRIVATE KEY') => ({ label, privateKey, publicKey: PUBLIC, keyType: 'ssh-ed25519' })
  const platform: Platform = {
    storage: {
      read: async () => files.get('vault') ?? null,
      write: async (data) => void files.set('vault', data),
      readNamed: async (name) => files.get(name) ?? null,
      writeNamed: async (name, data) => void files.set(name, data),
      removeNamed: async (name) => void files.delete(name),
    },
    deviceKey: { available: async () => false, has: async () => false, save: async () => {}, load: async () => null, clear: () => {} },
    keys: { generate: async (label) => key(label), import: async (label, privateKey) => key(label, privateKey) },
    deviceName: () => 'test device',
    rememberDevice: () => false,
  }
  return new VaultService(platform, () => undefined, () => undefined)
}

async function person(username: string): Promise<VaultService> {
  const s = device()
  await s.create('master-password')
  await s.syncRegister({ serverUrl: url, username, password: 'master-password' })
  return s
}

const host = (label: string) => ({ label, address: `${label}.test`, port: 22, username: 'shared-user', tags: [], keyId: null })

/** Adds a member as an admin's app does, comparing the fingerprint their own app shows. */
async function add(admin: VaultService, vaultId: string, member: VaultService, username: string, role: 'admin' | 'member') {
  const { fingerprint } = await admin.lookupMember(vaultId, username)
  expect(fingerprint).toBe(member.snapshot().servers[0]!.fingerprint)
  await admin.addMember(vaultId, { username, role, fingerprint })
}

async function join(member: VaultService, vaultId: string) {
  await member.addServerVault('personal', vaultId)
  member.switchVault(vaultId)
}

describe('shared vaults', () => {
  it('members connect but cannot change it; personal logins reach only their member and the admins; removing someone replaces the key', async () => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const work = alice.addVault('Team')
    alice.switchVault(work)
    const db = alice.saveHost(null, { ...host('db'), personalLogin: true })
    const web = alice.saveHost(null, host('web'))
    await alice.connectVault(work, 'personal')

    await add(alice, work, bob, 'bob', 'member')
    await expect(alice.addMember(work, { username: 'carol', role: 'member', fingerprint: '0000 0000 0000 0000 0000 0000 0000 0000' })).rejects.toThrow(
      'key changed',
    )
    await add(alice, work, carol, 'carol', 'member')
    expect((await alice.vaultMembers(work)).map((m) => [m.username, m.role, m.you])).toEqual([
      ['alice', 'admin', true],
      ['bob', 'member', false],
      ['carol', 'member', false],
    ])

    // A personal login for bob; its password sealed for bob and the admins.
    alice.saveIdentity(null, { label: 'Bob', username: 'bob-ssh', keyId: null, password: 'bob-secret', assignee: 'bob' })
    await alice.syncNow()

    await join(bob, work)
    expect(bob.snapshot()).toMatchObject({ readOnly: true, sharedAs: { username: 'bob', admin: false } })
    expect(bob.snapshot().hosts.map((h) => h.label).sort()).toEqual(['db', 'web'])
    expect(() => bob.saveHost(null, host('mine'))).toThrow('only its admins can change it')
    expect(() => bob.deleteItem(web)).toThrow('only its admins')
    const bobScope = bob.scope(work)
    expect(bobScope.host(db)?.data).toMatchObject({ username: 'bob-ssh', password: 'bob-secret' })
    expect(bobScope.host(web)?.data.username).toBe('shared-user')

    // Bob's own key: only his devices can open its private half; the admins see the public one.
    await bob.generateMemberKey('ed25519')
    const keyId = bobScope.host(db)!.data.keyId!
    expect(keyId).toBe(`${memberTag('bob')}-key`)
    expect(bobScope.key(keyId)?.data.privateKey).toBe('PRIVATE KEY')
    // A host key he trusts is his own item, which the server takes from a member.
    bobScope.trustHostKey({ host: 'db.test', port: 22, keyType: 'ssh-ed25519', publicKey: 'AAAA', fingerprint: 'SHA256:x' }, false)
    await bob.syncNow()
    expect(bob.snapshot().vaults.find((v) => v.id === work)).toMatchObject({ pending: 0, role: 'member', members: 3 })
    await alice.syncNow()
    expect((await alice.vaultMembers(work)).find((m) => m.username === 'bob')?.key?.publicKey).toBe(PUBLIC)
    expect(alice.scope(work).key(keyId)).toBeUndefined() // not alice's to use
    expect(alice.scope(work).knownHostsFor('db.test', 22)).toHaveLength(1)

    // Carol is a member: no personal login, and bob's is closed to her.
    await join(carol, work)
    expect(() => carol.scope(work).host(db)).toThrow('No personal login is assigned to carol')
    const bobLogin = carol.snapshot().identities.find((i) => i.assignee === 'bob')!
    expect(bobLogin).toMatchObject({ username: 'bob-ssh', hasPassword: true })
    // (Inside the service: what carol's device can open of bob's login.)
    type Inside = { others: Map<string, { get(id: string): unknown }>; openLogin(v: string, l: unknown): { password?: string } | null }
    const loginAs = (s: VaultService) => (s as unknown as Inside).openLogin(work, (s as unknown as Inside).others.get(work)!.get(bobLogin.id))
    expect(loginAs(carol)).toBeNull()

    // Made an admin, she is given the personal logins too.
    await alice.setMemberRole(work, 'carol', 'admin')
    await carol.syncNow()
    expect(carol.snapshot()).toMatchObject({ readOnly: false })
    expect(loginAs(carol)).toEqual({ password: 'bob-secret' })
    carol.saveIdentity(bobLogin.id, { label: 'Bob', username: 'bob-ssh', keyId: null, assignee: 'bob' }) // keeps the password: she can open it
    await carol.syncNow()
    await bob.syncNow()
    expect(bob.scope(work).host(db)?.data.password).toBe('bob-secret')

    // Bob is removed: a new vault key, his own items gone, his copy of his login dropped.
    await alice.removeMember(work, 'bob')
    expect(alice.snapshot().vaults.find((v) => v.id === work)).toMatchObject({ members: 2 })
    expect(alice.snapshot().hosts.map((h) => h.label).sort()).toEqual(['db', 'web'])
    expect(alice.scope(work).knownHostsFor('db.test', 22)).toHaveLength(0)
    await bob.syncNow()
    expect(bob.snapshot().vaults.find((v) => v.id === work)).toMatchObject({ lost: true })
    expect(bob.snapshot().vaults.find((v) => v.id === work)?.role).toBeUndefined()
    await carol.syncNow()
    carol.switchVault(work)
    expect(carol.snapshot().hosts.map((h) => h.label).sort()).toEqual(['db', 'web'])
    expect(carol.snapshot().identities.find((i) => i.assignee === 'bob')).toBeTruthy()
    // The old key no longer opens what the server holds.
    const rows = app.db.prepare('SELECT epoch FROM vaults WHERE id = ?').get(work) as { epoch: number }
    expect(rows.epoch).toBe(1)
  })

  it('a member of a shared vault cannot leave it without an admin, and the last admin keeps it', async () => {
    const alice = await person('alice')
    const bob = await person('bob')
    const work = alice.addVault('Team')
    await alice.connectVault(work, 'personal')
    await add(alice, work, bob, 'bob', 'member')
    await join(bob, work)
    await expect(alice.removeMember(work, 'alice')).rejects.toThrow()
    await expect(bob.addMember(work, { username: 'alice', role: 'member', fingerprint: 'x' })).rejects.toThrow('Only the vault’s admins')
    await expect(alice.deleteVault(work, { fromServer: true })).rejects.toThrow('Make another member an admin')
    // Bob leaves; the vault stays with alice.
    await bob.deleteVault(work, { fromServer: true })
    expect((await alice.vaultMembers(work)).map((m) => m.username)).toEqual(['alice'])
  })
})
