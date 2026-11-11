import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SyncApi,
  SyncError,
  Vault,
  WrongPasswordError,
  deriveKeys,
  syncVault,
  type HostData,
} from '../../../packages/core/src/index.ts'
import { createApp } from '../src/app.ts'

const host = (label: string, password = 'pw'): HostData => ({
  label,
  address: 'example.test',
  port: 22,
  username: 'root',
  tags: [],
  password,
})

let url: string
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  app = createApp({ dbPath: ':memory:' })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => app.server.close(() => r())))

/** First device: local vault, then creates the account. */
async function firstDevice(username: string, password: string): Promise<Vault> {
  const vault = await Vault.create(password)
  const api = new SyncApi(url)
  const token = await api.register(
    username,
    vault.kdf,
    await vault.authKeyFor(password),
    vault.wrappedVaultKey,
  )
  vault.setSync(url, username, token)
  return vault
}

/** Additional device: knows only server, username and master password. */
async function newDevice(username: string, password: string): Promise<Vault> {
  const api = new SyncApi(url)
  const kdf = await api.prelogin(username)
  const { authKey } = await deriveKeys(password, kdf)
  const { token, wrappedVaultKey } = await api.login(username, authKey)
  const vault = await Vault.fromAccount(kdf, wrappedVaultKey, password)
  vault.setSync(url, username, token)
  return vault
}

describe('sync', () => {
  it('syncs items between two devices', async () => {
    const a = await firstDevice('dean', 'master')
    const h = a.put('host', host('alpha'))
    a.put('snippet', { label: 'uptime', script: 'uptime' })
    await syncVault(a)

    const b = await newDevice('dean', 'master')
    await syncVault(b)
    expect(b.list()).toHaveLength(2)
    expect(b.get<HostData>(h.id)?.data).toEqual(host('alpha'))

    b.put('host', host('alpha-renamed'), h.id)
    await syncVault(b)
    await syncVault(a)
    expect(a.get<HostData>(h.id)?.data.label).toBe('alpha-renamed')
    expect(a.dirtyItems()).toHaveLength(0)
  })

  it('propagates deletions', async () => {
    const a = await firstDevice('dean', 'master')
    const h = a.put('host', host('gone'))
    await syncVault(a)
    const b = await newDevice('dean', 'master')
    await syncVault(b)

    a.delete(h.id)
    await syncVault(a)
    await syncVault(b)
    expect(b.list()).toHaveLength(0)
    expect(Object.keys(a.toFile().items)).toHaveLength(0)
  })

  it('resolves concurrent edits last-writer-wins on both devices', async () => {
    const a = await firstDevice('dean', 'master')
    const h = a.put('host', host('v1'))
    await syncVault(a)
    const b = await newDevice('dean', 'master')
    await syncVault(b)

    a.put('host', host('from-a'), h.id)
    await new Promise((r) => setTimeout(r, 5))
    b.put('host', host('from-b'), h.id) // later edit
    await syncVault(a)
    await syncVault(b) // conflicts with a's push, b is newer so it wins
    await syncVault(a)

    expect(a.get<HostData>(h.id)?.data.label).toBe('from-b')
    expect(b.get<HostData>(h.id)?.data.label).toBe('from-b')
    expect(a.dirtyItems()).toHaveLength(0)
    expect(b.dirtyItems()).toHaveLength(0)
  })

  it('an older concurrent edit loses even if it syncs last', async () => {
    const a = await firstDevice('dean', 'master')
    const h = a.put('host', host('v1'))
    await syncVault(a)
    const b = await newDevice('dean', 'master')
    await syncVault(b)

    b.put('host', host('older'), h.id)
    await new Promise((r) => setTimeout(r, 5))
    a.put('host', host('newer'), h.id)
    await syncVault(a)
    await syncVault(b)
    expect(b.get<HostData>(h.id)?.data.label).toBe('newer')
    expect(b.dirtyItems()).toHaveLength(0)
  })

  it('never stores plaintext on the server', async () => {
    const a = await firstDevice('dean', 'master')
    a.put('host', host('needle-label', 'needle-password'))
    await syncVault(a)
    const dump = JSON.stringify([
      app.db.prepare('SELECT * FROM items').all(),
      app.db.prepare('SELECT username, kdf, wrapped_vault_key FROM users').all(),
    ])
    expect(dump).not.toContain('needle')
    expect(dump).not.toContain('example.test')
  })
})

describe('accounts', () => {
  it('rejects a wrong master password and duplicate usernames', async () => {
    await firstDevice('dean', 'master')
    await expect(newDevice('dean', 'wrong')).rejects.toMatchObject({ status: 401 })
    await expect(firstDevice('dean', 'other')).rejects.toMatchObject({ status: 409 })
  })

  it('does not reveal whether a username exists', async () => {
    await firstDevice('dean', 'master')
    const api = new SyncApi(url)
    const ghost1 = await api.prelogin('nobody')
    const ghost2 = await api.prelogin('nobody')
    expect(ghost1).toEqual(ghost2)
    expect(Object.keys(ghost1).sort()).toEqual(Object.keys(await api.prelogin('dean')).sort())
    await expect(api.login('nobody', new Uint8Array(32))).rejects.toMatchObject({
      status: 401,
      message: 'Incorrect username or master password',
    })
  })

  it('throttles repeated failed logins', async () => {
    await firstDevice('dean', 'master')
    const api = new SyncApi(url)
    for (let i = 0; i < 10; i++) {
      await expect(api.login('dean', new Uint8Array(32))).rejects.toMatchObject({ status: 401 })
    }
    await expect(api.login('dean', new Uint8Array(32))).rejects.toMatchObject({ status: 429 })
  })

  it('requires a valid session and isolates accounts', async () => {
    await expect(new SyncApi(url, 'bogus').pull(0)).rejects.toBeInstanceOf(SyncError)
    const a = await firstDevice('alice', 'pw-a')
    a.put('host', host('alice-host'))
    await syncVault(a)
    const b = await firstDevice('bob', 'pw-b')
    await syncVault(b)
    expect(b.list()).toHaveLength(0)

    await new SyncApi(url, a.syncToken()).logout()
    await expect(syncVault(a)).rejects.toMatchObject({ status: 401 })
  })

  it('changes the master password and moves other devices over', async () => {
    const a = await firstDevice('dean', 'old-master')
    const h = a.put('host', host('kept'))
    await syncVault(a)
    const b = await newDevice('dean', 'old-master')
    await syncVault(b)

    // Device A changes the password.
    const apiA = new SyncApi(url, a.syncToken())
    await expect(a.prepareRekey('wrong', 'new-master')).rejects.toBeInstanceOf(WrongPasswordError)
    const rekey = await a.prepareRekey('old-master', 'new-master')
    await expect(
      apiA.changePassword(new Uint8Array(32), rekey.newAuthKey, rekey.kdf, rekey.wrappedVaultKey),
    ).rejects.toMatchObject({ status: 401 })
    await apiA.changePassword(rekey.currentAuthKey, rekey.newAuthKey, rekey.kdf, rekey.wrappedVaultKey)
    a.commitRekey(rekey.kdf, rekey.wrappedVaultKey)

    // A keeps working and now unlocks only with the new password.
    await syncVault(a)
    await expect(Vault.unlock(a.toFile(), 'old-master')).rejects.toBeInstanceOf(WrongPasswordError)
    expect((await Vault.unlock(a.toFile(), 'new-master')).get(h.id)).toBeDefined()

    // The old password no longer signs in; B was signed out.
    await expect(newDevice('dean', 'old-master')).rejects.toMatchObject({ status: 401 })
    await expect(syncVault(b)).rejects.toMatchObject({ status: 401 })

    // B re-authenticates with the new password and adopts the new keys.
    const apiB = new SyncApi(url)
    const kdf = await apiB.prelogin('dean')
    const { authKey } = await deriveKeys('new-master', kdf)
    const { token, wrappedVaultKey } = await apiB.login('dean', authKey)
    await expect(b.adoptAccountKeys(kdf, wrappedVaultKey, 'old-master')).rejects.toBeInstanceOf(
      WrongPasswordError,
    )
    await b.adoptAccountKeys(kdf, wrappedVaultKey, 'new-master')
    b.setSyncToken(token)
    await syncVault(b)
    expect((await Vault.unlock(b.toFile(), 'new-master')).get<HostData>(h.id)?.data.label).toBe('kept')
  })

  it('refuses to adopt keys for a different vault', async () => {
    const mine = await Vault.create('pw')
    const other = await Vault.create('pw')
    await expect(mine.adoptAccountKeys(other.kdf, other.wrappedVaultKey, 'pw')).rejects.toThrow(
      /different vault/,
    )
  })

  it('lists devices with encrypted names and signs one out remotely', async () => {
    const a = await firstDevice('dean', 'master')
    const b = await newDevice('dean', 'master')
    const other = await firstDevice('mallory', 'pw-m')
    const apiA = new SyncApi(url, a.syncToken())
    const apiB = new SyncApi(url, b.syncToken())
    await apiA.labelSession(a.sealText('Desktop', 'device'))
    await apiB.labelSession(b.sealText('Laptop', 'device'))

    const seen = await apiA.sessions()
    expect(seen).toHaveLength(2)
    expect(seen.filter((s) => s.current)).toHaveLength(1)
    expect(seen.map((s) => a.openText(s.label!, 'device')).sort()).toEqual(['Desktop', 'Laptop'])
    expect(JSON.stringify(app.db.prepare('SELECT label FROM sessions').all())).not.toContain('Laptop')

    // Another account can neither see nor revoke these sessions.
    const laptop = seen.find((s) => !s.current)!
    const apiOther = new SyncApi(url, other.syncToken())
    expect(await apiOther.sessions()).toHaveLength(1)
    await expect(apiOther.revokeSession(laptop.id)).rejects.toMatchObject({ status: 404 })

    await apiA.revokeSession(laptop.id)
    await expect(syncVault(b)).rejects.toMatchObject({ status: 401 })
    expect(await apiA.sessions()).toHaveLength(1)
    await syncVault(a)
  })

  it('answers cross-origin preflight requests and sets CORS headers', async () => {
    const preflight = await fetch(`${url}/v1/sync`, {
      method: 'OPTIONS',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    const health = await fetch(`${url}/v1/health`)
    expect(health.headers.get('access-control-allow-origin')).toBe('*')
    // No credentials mode is offered, so cookies can never authenticate a request.
    expect(health.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('reconnects a device to its account after sync was turned off', async () => {
    const a = await firstDevice('dean', 'master')
    const kept = a.put('host', host('kept'))
    await syncVault(a)
    const b = await newDevice('dean', 'master')
    await syncVault(b)

    // Device A turns sync off, keeps working offline, then signs back in.
    a.clearSync()
    a.put('host', host('renamed-offline'), kept.id)
    const added = a.put('host', host('added-offline'))
    b.put('snippet', { label: 'from-b', script: 'uptime' })
    await syncVault(b)

    const api = new SyncApi(url)
    const kdf = await api.prelogin('dean')
    const { authKey } = await deriveKeys('master', kdf)
    const { token, wrappedVaultKey } = await api.login('dean', authKey)
    await expect(a.joinAccount(kdf, wrappedVaultKey, 'wrong')).rejects.toBeInstanceOf(
      WrongPasswordError,
    )
    const joined = await a.joinAccount(kdf, wrappedVaultKey, 'master')
    expect(joined.merged).toBe(false)
    a.setSync(url, 'dean', token)
    await syncVault(a)
    await syncVault(b)

    // No duplicates, offline work kept, and what B added arrived.
    for (const v of [a, b]) {
      expect(v.list('host')).toHaveLength(2)
      expect(v.get<HostData>(kept.id)?.data.label).toBe('renamed-offline')
      expect(v.get(added.id)).toBeDefined()
      expect(v.list('snippet')).toHaveLength(1)
      expect(v.dirtyItems()).toHaveLength(0)
    }
  })

  it('merges an unrelated local vault into an existing account', async () => {
    const account = await firstDevice('dean', 'account-pw')
    const theirs = account.put('host', host('from-account'))
    await syncVault(account)

    // A vault created separately, with a different password and key.
    const local = await Vault.create('local-pw')
    const mine = local.put('host', host('from-local', 'local-secret'))

    const api = new SyncApi(url)
    const kdf = await api.prelogin('dean')
    const { authKey } = await deriveKeys('account-pw', kdf)
    const { token, wrappedVaultKey } = await api.login('dean', authKey)
    const joined = await local.joinAccount(kdf, wrappedVaultKey, 'account-pw')
    expect(joined.merged).toBe(true)
    local.setSync(url, 'dean', token)
    await syncVault(local)
    await syncVault(account)

    for (const v of [local, account]) {
      expect(v.list('host')).toHaveLength(2)
      expect(v.get<HostData>(mine.id)?.data.password).toBe('local-secret')
      expect(v.get(theirs.id)).toBeDefined()
    }
    // The device now unlocks with the account's password, not its old one.
    await expect(Vault.unlock(local.toFile(), 'local-pw')).rejects.toBeInstanceOf(WrongPasswordError)
    const reopened = await Vault.unlock(local.toFile(), 'account-pw')
    expect(reopened.list('host')).toHaveLength(2)
    expect(Vault.unlockWithKey(local.toFile(), account.exportKey()).list()).toHaveLength(2)
  })

  it('can disable registration', async () => {
    const closed = createApp({ dbPath: ':memory:', allowRegistration: false })
    await new Promise<void>((r) => closed.server.listen(0, '127.0.0.1', r))
    const closedUrl = `http://127.0.0.1:${(closed.server.address() as AddressInfo).port}`
    const vault = await Vault.create('pw')
    await expect(
      new SyncApi(closedUrl).register('x-user', vault.kdf, new Uint8Array(32), vault.wrappedVaultKey),
    ).rejects.toMatchObject({ status: 403 })
    await new Promise<void>((r) => closed.server.close(() => r()))
  })
})
