import { describe, expect, it } from 'vitest'
import { VaultService, type DeviceKeyStore, type Platform } from '../src/index.ts'

/** An in-memory device: storage, plus a key store of either kind. */
function device(kind: 'presence' | 'silent' | 'none') {
  let file: string | null = null
  let stored: Uint8Array | null = null
  const log: string[] = []
  const state = { remember: false, cancelNext: false }

  const deviceKey: DeviceKeyStore = {
    userPresence: kind === 'presence' ? true : undefined,
    available: async () => kind !== 'none',
    has: async () => stored !== null,
    save: async (key) => {
      log.push('save')
      if (state.cancelNext) {
        state.cancelNext = false
        throw new Error('Cancelled')
      }
      stored = key.slice()
    },
    load: async () => {
      log.push('load')
      if (state.cancelNext) {
        state.cancelNext = false
        throw new Error('Cancelled')
      }
      return stored ? stored.slice() : null
    },
    clear: () => {
      log.push('clear')
      stored = null
    },
  }
  const platform: Platform = {
    storage: { read: async () => file, write: async (data) => void (file = data) },
    deviceKey,
    keys: {
      generate: () => {
        throw new Error('not used')
      },
      import: () => {
        throw new Error('not used')
      },
    },
    deviceName: () => 'test device',
    rememberDevice: () => state.remember,
  }
  const open = () => new VaultService(platform, () => undefined, () => undefined)
  return { open, state, log, hasKey: () => stored !== null, file: () => file }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('device key behind a fingerprint (phone)', () => {
  it('unlocks with the device key only when asked, and keeps it across a lock', async () => {
    const d = device('presence')
    const service = d.open()
    await service.create('master-password')
    service.saveHost(null, { label: 'box', address: '10.0.0.1', port: 22, username: 'root', tags: [], keyId: null })

    d.state.remember = true
    await service.applyRememberDevice()
    expect(d.hasKey()).toBe(true)

    service.lock()
    await service.flush()
    expect(d.hasKey()).toBe(true) // the fingerprint check guards it, so a lock keeps it
    expect(await service.phase()).toBe('locked')
    expect(await service.canUnlockWithDevice()).toBe(true)

    // A restart never opens the vault on its own.
    const restarted = d.open()
    await restarted.tryDeviceUnlock()
    expect(await restarted.phase()).toBe('locked')

    await restarted.unlockWithDevice()
    expect(await restarted.phase()).toBe('unlocked')
    expect(restarted.snapshot().hosts.map((h) => h.label)).toEqual(['box'])
  })

  it('does not prompt again to store a key that is already stored', async () => {
    const d = device('presence')
    const service = d.open()
    d.state.remember = true
    await service.create('master-password')
    await settle()
    expect(d.log.filter((e) => e === 'save')).toHaveLength(1)

    service.lock()
    await service.unlock('master-password')
    await settle()
    expect(d.log.filter((e) => e === 'save')).toHaveLength(1)
  })

  it('stays locked when the fingerprint prompt is cancelled', async () => {
    const d = device('presence')
    const service = d.open()
    d.state.remember = true
    await service.create('master-password')
    await settle()
    service.lock()

    d.state.cancelNext = true
    await expect(service.unlockWithDevice()).rejects.toThrow('Cancelled')
    expect(await service.phase()).toBe('locked')
    expect(d.hasKey()).toBe(true) // a cancel must not throw the key away
    await service.unlock('master-password')
    expect(await service.phase()).toBe('unlocked')
  })

  it('is not offered when the setting is off, and turning it off removes the key', async () => {
    const d = device('presence')
    const service = d.open()
    d.state.remember = true
    await service.create('master-password')
    await settle()
    d.state.remember = false
    await service.applyRememberDevice()
    expect(d.hasKey()).toBe(false)
    service.lock()
    expect(await service.canUnlockWithDevice()).toBe(false)
    await expect(service.unlockWithDevice()).rejects.toThrow(/master password/)
  })

  it('refuses a stored key that belongs to a different vault key', async () => {
    const d = device('presence')
    const first = d.open()
    d.state.remember = true
    await first.create('master-password')
    await settle()
    first.lock()
    await first.flush()

    // The same device key store, but the vault on disk is a different one.
    const other = device('presence')
    const stranger = other.open()
    await stranger.create('other-password')
    stranger.lock()
    await stranger.flush()
    other.state.remember = true
    // Plant the first vault's key in the second device's store.
    const planted = d.open()
    await planted.unlock('master-password')
    const service = other.open()
    Object.assign(
      (service as unknown as { platform: Platform }).platform.deviceKey,
      { load: async () => new Uint8Array(32).fill(9), has: async () => true },
    )
    await expect(service.unlockWithDevice()).rejects.toThrow(/setting up again/)
    expect(await service.phase()).toBe('locked')
  })
})

describe('device key used silently at launch (desktop)', () => {
  it('opens at launch, and a lock forgets the key', async () => {
    const d = device('silent')
    const service = d.open()
    d.state.remember = true
    await service.create('master-password')
    await settle()
    expect(d.hasKey()).toBe(true)
    service.lock({ forget: false }) // quitting
    await service.flush()

    const relaunched = d.open()
    await relaunched.tryDeviceUnlock()
    expect(await relaunched.phase()).toBe('unlocked')
    expect(await relaunched.canUnlockWithDevice()).toBe(false) // that is the phone's flow

    relaunched.lock() // a lock the user asked for
    await settle()
    expect(d.hasKey()).toBe(false)
    const again = d.open()
    await again.tryDeviceUnlock()
    expect(await again.phase()).toBe('locked')
  })
})

describe('command history', () => {
  it('keeps commands per host, newest last, without repeats, and survives a restart', async () => {
    const d = device('none')
    const service = d.open()
    await service.create('master-password')
    service.recordCommands('host:a', ['ls -la', 'cd /srv', '  ', 'ls -la'])
    service.recordCommands('host:b', ['uptime'])
    expect(service.commandHistory('host:a')).toEqual(['cd /srv', 'ls -la'])
    expect(service.commandHistory('host:b')).toEqual(['uptime'])
    expect(service.commandHistory('host:none')).toEqual([])
    await settle()
    const again = d.open()
    await again.unlock('master-password')
    expect(again.commandHistory('host:a')).toEqual(['cd /srv', 'ls -la'])
    // Kept in the vault: the file on disk holds no command in plain text.
    expect(d.file()).not.toContain('cd /srv')
    expect(d.file()).not.toContain('host:a')
    again.clearCommandHistory()
    expect(again.commandHistory('host:a')).toEqual([])
  })

  it('keeps the latest 500 and ignores very long lines', async () => {
    const service = device('none').open()
    await service.create('master-password')
    service.recordCommands('local:bash', Array.from({ length: 600 }, (_, i) => `echo ${i}`))
    service.recordCommands('local:bash', ['x'.repeat(1001)])
    const history = service.commandHistory('local:bash')
    expect(history).toHaveLength(500)
    expect(history[0]).toBe('echo 100')
    expect(history.at(-1)).toBe('echo 599')
  })
})

describe('importing from OpenSSH files', () => {
  const ed = (fill: number) => {
    const name = new TextEncoder().encode('ssh-ed25519')
    const out = new Uint8Array(4 + name.length + 4 + 32)
    new DataView(out.buffer).setUint32(0, name.length)
    out.set(name, 4)
    new DataView(out.buffer).setUint32(4 + name.length, 32)
    out.fill(fill, 8 + name.length)
    return btoa(String.fromCharCode(...out))
  }

  it('previews, then imports the chosen hosts and new known host keys, never replacing a trusted key', async () => {
    const service = device('none').open()
    await service.create('master-password')
    service.saveHost(null, { label: 'mine', address: 'db.internal', port: 22, username: 'ops', tags: [], keyId: null })
    service.trustHostKey(
      { host: 'db.internal', port: 22, keyType: 'ssh-ed25519', publicKey: ed(9), fingerprint: 'SHA256:x' },
      false,
    )
    const preview = service.scanSshImport({
      source: 'test',
      config:
        'Host web\n  HostName web.example.com\n  User deploy\nHost db\n  HostName db.internal\n  User ops\n' +
        'Host other\n  HostName other.example.com\n  ProxyJump web\nHost far\n  HostName far.example.com\n  ProxyJump a@b:2,c',
      knownHosts: `web.example.com ssh-ed25519 ${ed(1)}\ndb.internal ssh-ed25519 ${ed(2)}\n|1|x=|y= ssh-ed25519 ${ed(3)}`,
    })
    expect(preview.hosts.map((h) => [h.alias, h.exists])).toEqual([
      ['web', false],
      ['db', true],
      ['other', false],
      ['far', false],
    ])
    expect(preview.knownHosts).toEqual({ add: 1, already: 0, conflicting: 1, skipped: 1 })
    // "other" jumps through "web" from the same config; "far" names hops this cannot follow.
    expect(preview.notes.join(' ')).toMatch(/ProxyJump .*connect directly: far\./)

    const result = await service.applySshImport(['web', 'db', 'other'], true)
    expect(result).toEqual({ hosts: 2, knownHosts: 1, keys: 0, keysNeedingPassphrase: [] })
    const hosts = service.snapshot().hosts
    expect(hosts.map((h) => h.label).sort()).toEqual(['mine', 'other', 'web'])
    expect(hosts.find((h) => h.label === 'other')?.jumpHostId).toBe(hosts.find((h) => h.label === 'web')?.id)
    expect(service.knownHostsFor('db.internal', 22).map((k) => k.data.publicKey)).toEqual([ed(9)])
    expect(service.knownHostsFor('web.example.com', 22)).toHaveLength(1)
    await expect(service.applySshImport(['web'], true)).rejects.toThrow('Scan for hosts first')
  })
})

describe('jump hosts and port forwards', () => {
  const host = (label: string, jumpHostId: string | null = null) => ({
    label,
    address: `${label}.example.com`,
    port: 22,
    username: 'me',
    tags: [],
    keyId: null,
    jumpHostId,
  })

  it('a host can go through another, but never round in a loop', async () => {
    const service = device('none').open()
    await service.create('master-password')
    const gw = service.saveHost(null, host('gw'))
    const inner = service.saveHost(null, host('inner', gw))
    expect(service.host(inner)?.data.jumpHostId).toBe(gw)
    expect(() => service.saveHost(gw, host('gw', inner))).toThrow('cannot be reached through itself')
    expect(() => service.saveHost(gw, host('gw', gw))).toThrow('cannot be reached through itself')
    expect(() => service.saveHost(null, host('x', 'missing'))).toThrow('Jump host not found')
    // Leaving jumpHostId out keeps it; null removes it.
    const { jumpHostId: _keep, ...withoutJump } = host('inner')
    service.saveHost(inner, withoutJump)
    expect(service.host(inner)?.data.jumpHostId).toBe(gw)
    service.saveHost(inner, host('inner', null))
    expect(service.host(inner)?.data.jumpHostId).toBeUndefined()
  })

  it('saves forwards, and deleting their host removes them and detaches hosts that jumped through it', async () => {
    const service = device('none').open()
    await service.create('master-password')
    const gw = service.saveHost(null, host('gw'))
    const inner = service.saveHost(null, host('inner', gw))
    const local = service.saveForward(null, {
      label: '',
      hostId: gw,
      kind: 'local',
      bindHost: '',
      bindPort: 8080,
      destHost: 'intranet',
      destPort: 80,
    })
    service.saveForward(null, { label: 'socks', hostId: gw, kind: 'dynamic', bindHost: '', bindPort: 1080 })
    const forwards = service.snapshot().forwards
    expect(forwards.find((f) => f.id === local)).toMatchObject({ label: '8080 → intranet:80', bindHost: '127.0.0.1' })
    expect(forwards.find((f) => f.kind === 'dynamic')).not.toHaveProperty('destHost')
    expect(() =>
      service.saveForward(null, { label: '', hostId: gw, kind: 'local', bindHost: '', bindPort: 70000, destHost: 'x', destPort: 1 }),
    ).toThrow('Listening port must be 1-65535')
    expect(() => service.saveForward(null, { label: '', hostId: 'nope', kind: 'dynamic', bindHost: '', bindPort: 1 })).toThrow(
      'Choose a host',
    )
    service.deleteItem(gw)
    expect(service.snapshot().forwards).toEqual([])
    expect(service.host(inner)?.data.jumpHostId).toBeUndefined()
  })
})

describe('identities and groups', () => {
  const hostInput = { label: '', port: 22, username: 'own', tags: [], keyId: null }

  it('a host logs in with its identity, and keeps the login when the identity is deleted', async () => {
    const d = device('none')
    const s = d.open()
    await s.create('master-password')
    const identity = s.saveIdentity(null, { label: 'Ops', username: 'deploy', keyId: null, password: 'shared-pw' })
    const a = s.saveHost(null, { ...hostInput, address: 'a.test', identityId: identity, password: 'own-pw' })
    const b = s.saveHost(null, { ...hostInput, address: 'b.test' })

    expect(s.host(a)?.data).toMatchObject({ username: 'deploy', password: 'shared-pw' })
    expect(s.host(b)?.data).toMatchObject({ username: 'own' })
    expect(s.snapshot().hosts.find((h) => h.id === a)?.identityId).toBe(identity)
    expect(s.snapshot().identities).toMatchObject([{ id: identity, label: 'Ops', username: 'deploy', hasPassword: true }])

    // A change to the identity reaches every host that uses it.
    s.saveIdentity(identity, { label: 'Ops', username: 'deploy2', keyId: null })
    expect(s.host(a)?.data).toMatchObject({ username: 'deploy2', password: 'shared-pw' })

    s.deleteItem(identity)
    expect(s.host(a)?.data).toMatchObject({ username: 'deploy2', password: 'shared-pw' })
    expect(s.host(a)?.data.identityId).toBeUndefined()
    expect(() => s.saveHost(null, { ...hostInput, address: 'c.test', identityId: identity })).toThrow('Identity not found')
  })

  it('deleting a key removes it from identities too', async () => {
    const d = device('none')
    const s = d.open()
    await s.create('master-password')
    const key = (s as unknown as { v: { put(t: string, d: unknown): { id: string } } }).v.put('key', {
      label: 'k', privateKey: 'x', publicKey: 'ssh-ed25519 AAAA', keyType: 'ssh-ed25519',
    }).id
    const identity = s.saveIdentity(null, { label: '', username: 'u', keyId: key })
    expect(s.snapshot().identities[0]).toMatchObject({ label: 'u', keyId: key })
    s.deleteItem(key)
    expect(s.snapshot().identities[0]?.keyId).toBeUndefined()
    expect(s.snapshot().identities[0]?.id).toBe(identity)
  })

  it('groups hosts by name, and renames or removes a group across its hosts', async () => {
    const d = device('none')
    const s = d.open()
    await s.create('master-password')
    const a = s.saveHost(null, { ...hostInput, address: 'a.test', group: ' Production ' })
    const b = s.saveHost(null, { ...hostInput, address: 'b.test', group: 'Production' })
    const c = s.saveHost(null, { ...hostInput, address: 'c.test' })
    // Editing without mentioning the group keeps it.
    s.saveHost(a, { ...hostInput, address: 'a.test', label: 'renamed' })
    const groupOf = (id: string) => s.snapshot().hosts.find((h) => h.id === id)?.group
    expect([groupOf(a), groupOf(b), groupOf(c)]).toEqual(['Production', 'Production', undefined])
    s.renameGroup('Production', 'Prod')
    expect([groupOf(a), groupOf(b)]).toEqual(['Prod', 'Prod'])
    s.renameGroup('Prod', '')
    expect([groupOf(a), groupOf(b)]).toEqual([undefined, undefined])
  })
})

describe('export and import', () => {
  const vaultWithStuff = async () => {
    const d = device('none')
    const s = d.open()
    await s.create('master-password')
    const v = (s as unknown as { v: { put(t: string, d: unknown): { id: string } } }).v
    const key = v.put('key', { label: 'k', privateKey: 'PRIVATE', publicKey: 'ssh-ed25519 AAAAkey', keyType: 'ssh-ed25519' }).id
    const identity = s.saveIdentity(null, { label: 'Ops', username: 'deploy', keyId: key, password: 'id-pw' })
    const bastion = s.saveHost(null, { label: 'bastion', address: 'bastion.test', port: 22, username: 'b', tags: [], keyId: key })
    const inner = s.saveHost(null, {
      label: 'inner', address: '10.0.0.5', port: 2222, username: 'i', tags: ['x'], keyId: null,
      jumpHostId: bastion, identityId: identity, group: 'Prod', password: 'pw',
    })
    s.saveForward(null, { label: 'db', hostId: inner, kind: 'local', bindHost: '127.0.0.1', bindPort: 5432, destHost: 'db', destPort: 5432 })
    s.saveSnippet(null, { label: 'up', script: 'uptime' })
    s.trustHostKey({ host: 'bastion.test', port: 22, keyType: 'ssh-ed25519', publicKey: 'AAAAhost', fingerprint: 'SHA256:x' }, false)
    s.recordCommands('host:x', ['ls'])
    return s
  }

  it('round-trips everything but command history, with references intact', async () => {
    const a = await vaultWithStuff()
    const { text, count } = await a.exportVault('export-password')
    expect(count).toBe(7)
    expect(text).not.toContain('PRIVATE')
    expect(text).not.toContain('bastion')

    const d = device('none')
    const b = d.open()
    await b.create('other-master')
    await expect(b.importVault(text, 'wrong-password')).rejects.toThrow('Incorrect password for this export file')
    await expect(b.importVault('{"hello":1}', 'export-password')).rejects.toThrow('not a termterm export')
    expect(await b.importVault(text, 'export-password')).toEqual({ added: 7, existing: 0, skipped: 0 })

    const snap = b.snapshot()
    const inner = snap.hosts.find((h) => h.label === 'inner')!
    const bastion = snap.hosts.find((h) => h.label === 'bastion')!
    expect(inner).toMatchObject({ jumpHostId: bastion.id, identityId: snap.identities[0]!.id, group: 'Prod', tags: ['x'] })
    expect(bastion.keyId).toBe(snap.keys[0]!.id)
    expect(snap.identities[0]).toMatchObject({ keyId: snap.keys[0]!.id, hasPassword: true })
    expect(snap.forwards[0]).toMatchObject({ hostId: inner.id, bindPort: 5432 })
    expect(b.host(inner.id)?.data).toMatchObject({ username: 'deploy', password: 'id-pw' })
    expect(b.key(snap.keys[0]!.id)?.data.privateKey).toBe('PRIVATE')
    expect(snap.knownHosts).toHaveLength(1)
    expect(snap.snippets).toHaveLength(1)
    expect(b.commandHistory('host:x')).toEqual([])

    // Importing the same file again adds nothing.
    expect(await b.importVault(text, 'export-password')).toEqual({ added: 0, existing: 7, skipped: 0 })
    expect(b.snapshot().hosts).toHaveLength(2)
  })

  it('needs an export password of at least 8 characters', async () => {
    const a = await vaultWithStuff()
    await expect(a.exportVault('short')).rejects.toThrow('at least 8')
  })
})

describe('importing hosts that share an address', () => {
  it('keeps them apart when their labels differ', async () => {
    const d = device('none')
    const a = d.open()
    await a.create('master-password')
    for (const label of ['one', 'two']) a.saveHost(null, { label, address: 'same.test', port: 22, username: '', tags: [], keyId: null })
    const { text } = await a.exportVault('export-password')
    const b = device('none').open()
    await b.create('master-password')
    b.saveHost(null, { label: 'one', address: 'same.test', port: 22, username: '', tags: [], keyId: null })
    expect(await b.importVault(text, 'export-password')).toEqual({ added: 1, existing: 1, skipped: 0 })
    expect(b.snapshot().hosts.map((h) => h.label)).toEqual(['one', 'two'])
  })
})

describe('per-host session settings', () => {
  const base = { label: 'h', address: 'h.test', port: 22, username: 'u', tags: [], keyId: null }

  it('keeps keep-alive, startup snippet, environment and colour, and checks them', async () => {
    const s = device('none').open()
    await s.create('master-password')
    const snippet = s.saveSnippet(null, { label: 'up', script: 'uptime' })
    const id = s.saveHost(null, { ...base, keepAlive: 60, startupSnippetId: snippet, env: { LANG: 'C.UTF-8', ' ': 'x' }, color: 'red' })
    expect(s.snapshot().hosts[0]).toMatchObject({ keepAlive: 60, startupSnippetId: snippet, env: { LANG: 'C.UTF-8' }, color: 'red' })
    expect(s.host(id)?.data).toMatchObject({ keepAlive: 60, env: { LANG: 'C.UTF-8' } })

    // Saving without them keeps them; null puts them back to the default.
    s.saveHost(id, { ...base, label: 'renamed' })
    expect(s.snapshot().hosts[0]).toMatchObject({ keepAlive: 60, color: 'red' })
    s.saveHost(id, { ...base, keepAlive: 0, color: null, env: {} })
    expect(s.snapshot().hosts[0]).toMatchObject({ keepAlive: 0 })
    expect(s.snapshot().hosts[0]?.color).toBeUndefined()
    expect(s.snapshot().hosts[0]?.env).toBeUndefined()
    s.saveHost(id, { ...base, keepAlive: null })
    expect(s.snapshot().hosts[0]?.keepAlive).toBeUndefined()

    expect(() => s.saveHost(id, { ...base, keepAlive: -1 })).toThrow('Keep-alive')
    expect(() => s.saveHost(id, { ...base, keepAlive: 1.5 })).toThrow('Keep-alive')
    expect(() => s.saveHost(id, { ...base, env: { '1BAD': 'x' } })).toThrow('not a valid environment variable name')
    expect(() => s.saveHost(id, { ...base, env: { OK: 'a\nb' } })).toThrow('line break')
    expect(() => s.saveHost(id, { ...base, color: 'chartreuse' })).toThrow('Unknown colour')
    expect(() => s.saveHost(id, { ...base, startupSnippetId: 'nope' })).toThrow('Snippet not found')

    // Deleting the snippet takes it off the host.
    s.deleteItem(snippet)
    expect(s.snapshot().hosts[0]?.startupSnippetId).toBeUndefined()
  })

  it('travels through export and import, the snippet link included', async () => {
    const a = device('none').open()
    await a.create('master-password')
    const snippet = a.saveSnippet(null, { label: 'up', script: 'uptime' })
    a.saveHost(null, { ...base, keepAlive: 30, startupSnippetId: snippet, env: { A: '1' }, color: 'blue' })
    const { text } = await a.exportVault('export-password')
    const b = device('none').open()
    await b.create('master-password')
    await b.importVault(text, 'export-password')
    const host = b.snapshot().hosts[0]!
    expect(host).toMatchObject({ keepAlive: 30, env: { A: '1' }, color: 'blue' })
    expect(host.startupSnippetId).toBe(b.snapshot().snippets[0]!.id)
  })
})

describe('forwards that start by themselves', () => {
  it('keeps the auto-start choice, and carries it through export and import', async () => {
    const a = device('none').open()
    await a.create('master-password')
    const host = a.saveHost(null, { label: 'h', address: 'h.test', port: 22, username: 'u', tags: [], keyId: null })
    const base = { label: '', hostId: host, kind: 'local' as const, bindHost: '', bindPort: 8080, destHost: 'db', destPort: 5432 }
    const id = a.saveForward(null, { ...base, autoStart: true })
    expect(a.snapshot().forwards[0]).toMatchObject({ id, autoStart: true })
    a.saveForward(id, { ...base, autoStart: false })
    expect(a.snapshot().forwards[0]?.autoStart).toBeUndefined()
    a.saveForward(id, { ...base, autoStart: true })
    const { text } = await a.exportVault('export-password')
    const b = device('none').open()
    await b.create('master-password')
    await b.importVault(text, 'export-password')
    expect(b.snapshot().forwards[0]).toMatchObject({ autoStart: true, bindPort: 8080 })
  })
})

describe('locking and unlocking straight after a change', () => {
  it('reopens with the change, even when storage is slow to write', async () => {
    let file: string | null = null
    const platform: Platform = {
      // Each write lands 50 ms after it is asked for, like a slow disk.
      storage: { read: async () => file, write: (data) => new Promise((r) => setTimeout(() => r(void (file = data)), 50)) },
      deviceKey: { available: async () => false, has: async () => false, save: async () => {}, load: async () => null, clear: () => {} },
      keys: { generate: () => Promise.reject(new Error('unused')), import: () => Promise.reject(new Error('unused')) },
      deviceName: () => 'slow disk',
      rememberDevice: () => false,
    }
    const s = new VaultService(platform, () => undefined, () => undefined)
    await s.create('master-password')
    await s.flush()
    const id = s.saveHost(null, { label: 'before', address: 'h.test', port: 22, username: 'u', tags: [], keyId: null })
    await s.flush()
    s.saveHost(id, { label: 'after', address: 'h.test', port: 22, username: 'u', tags: [], keyId: null })
    await Promise.resolve() // the change's save is queued, not yet written
    s.lock()
    await s.unlock('master-password')
    expect(s.snapshot().hosts[0]?.label).toBe('after')
  })
})

describe('proxies, agent forwarding and certificates', () => {
  const base = { label: 'h', address: 'h.test', port: 22, username: 'u', tags: [], keyId: null }

  it('keeps a host proxy (its password hidden from views) and agent forwarding, and checks them', async () => {
    const s = device('none').open()
    await s.create('master-password')
    const id = s.saveHost(null, { ...base, proxy: { kind: 'socks5', host: 'proxy.test', port: 1080, username: 'p', password: 'secret' }, agentForward: true })
    expect(s.snapshot().hosts[0]).toMatchObject({ proxy: { kind: 'socks5', host: 'proxy.test', port: 1080, username: 'p', hasPassword: true }, agentForward: true })
    expect(JSON.stringify(s.snapshot())).not.toContain('secret')
    expect(s.host(id)?.data.proxy).toEqual({ kind: 'socks5', host: 'proxy.test', port: 1080, username: 'p', password: 'secret' })

    // Saving the proxy again without a password keeps it; null removes it.
    s.saveHost(id, { ...base, proxy: { kind: 'http', host: 'proxy.test', port: 3128, username: 'p' } })
    expect(s.host(id)?.data.proxy).toEqual({ kind: 'http', host: 'proxy.test', port: 3128, username: 'p', password: 'secret' })
    expect(s.host(id)?.data.agentForward).toBe(true)
    s.saveHost(id, { ...base, proxy: { kind: 'http', host: 'proxy.test', port: 3128, username: 'p', password: null }, agentForward: false })
    expect(s.host(id)?.data.proxy?.password).toBeUndefined()
    expect(s.host(id)?.data.agentForward).toBeUndefined()
    s.saveHost(id, { ...base, proxy: null })
    expect(s.host(id)?.data.proxy).toBeUndefined()

    expect(() => s.saveHost(id, { ...base, proxy: { kind: 'socks4' as 'socks5', host: 'p', port: 1 } })).toThrow('Unknown kind of proxy')
    expect(() => s.saveHost(id, { ...base, proxy: { kind: 'http', host: ' ', port: 1 } })).toThrow('Proxy address')
    expect(() => s.saveHost(id, { ...base, proxy: { kind: 'http', host: 'p', port: 70000 } })).toThrow('Proxy port')
    expect(() => s.saveHost(id, { ...base, proxy: { kind: 'http', host: 'p', port: 8080, password: 'x' } })).toThrow('needs a username')
  })

  it('adds a certificate only to the key it certifies, and carries everything through export', async () => {
    let file: string | null = null
    const platform: Platform = {
      storage: { read: async () => file, write: async (data) => void (file = data) },
      deviceKey: { available: async () => false, has: async () => false, save: async () => {}, load: async () => null, clear: () => {} },
      keys: {
        generate: () => Promise.reject(new Error('unused')),
        import: async (label, privateKey) => ({ label, privateKey, publicKey: privateKey === 'other' ? 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPWYg72XTvOPpdfiwnYajxtD7rySL0XKzimh2Q1iq2R9 other' : 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH772/pAofexhCu9u+ORbNuQfo8pdQraNaAiSi7B/ahy user', keyType: 'ssh-ed25519' }),
      },
      deviceName: () => 'test',
      rememberDevice: () => false,
    }
    const s = new VaultService(platform, () => undefined, () => undefined)
    await s.create('master-password')
    const key = await s.importKey({ label: 'mine', privateKey: 'mine' })
    const other = await s.importKey({ label: 'other', privateKey: 'other' })
    const CERT = 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIJ4Zd/kGU6u8/HCHV4I4uDZlJKfPODZmVwIfqvYFblstAAAAIH772/pAofexhCu9u+ORbNuQfo8pdQraNaAiSi7B/ahyAAAAAAAAAAAAAAABAAAADWFsaWNlQGV4YW1wbGUAAAATAAAABWFsaWNlAAAABmRlcGxveQAAAAAAAAAA//////////8AAAAAAAAAggAAABVwZXJtaXQtWDExLWZvcndhcmRpbmcAAAAAAAAAF3Blcm1pdC1hZ2VudC1mb3J3YXJkaW5nAAAAAAAAABZwZXJtaXQtcG9ydC1mb3J3YXJkaW5nAAAAAAAAAApwZXJtaXQtcHR5AAAAAAAAAA5wZXJtaXQtdXNlci1yYwAAAAAAAAAAAAAAMwAAAAtzc2gtZWQyNTUxOQAAACBjmcglEj1Qq6WmUmTiTtTfWiSQWvCr3vTFWCDqzVb5WgAAAFMAAAALc3NoLWVkMjU1MTkAAABAMUxNi/BffS4PAwaBqE3rNw9EPlwyzyWysCZNEm5s/LOenpTUI9pgS460odFk1bOUgqgNxj5GIS6DxkCCaLA1DA== user'
    expect(() => s.setKeyCertificate(other, CERT)).toThrow('different key')
    expect(() => s.setKeyCertificate(key, 'ssh-ed25519 AAAA')).toThrow('not an OpenSSH certificate')
    s.setKeyCertificate(key, `  ${CERT}\n`)
    expect(s.snapshot().keys.find((k) => k.id === key)?.certificate).toBe(CERT)
    expect(s.key(key)?.data.certificate).toBe(CERT)

    s.saveHost(null, { ...base, keyId: key, proxy: { kind: 'socks5', host: 'proxy.test', port: 1080 }, agentForward: true })
    const { text } = await s.exportVault('export-password')
    const b = device('none').open()
    await b.create('master-password')
    await b.importVault(text, 'export-password')
    expect(b.snapshot().keys.find((k) => k.label === 'mine')?.certificate).toBe(CERT)
    expect(b.snapshot().hosts[0]).toMatchObject({ proxy: { kind: 'socks5', host: 'proxy.test', port: 1080, hasPassword: false }, agentForward: true })

    s.setKeyCertificate(key, null)
    expect(s.key(key)?.data.certificate).toBeUndefined()
  })
})

describe('several vaults on a device', () => {
  /** A device whose storage also keeps named files (other vaults, their list). */
  function multiDevice() {
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
      deviceName: () => 'test',
      rememberDevice: () => false,
    }
    const open = () => new VaultService(platform, () => undefined, () => undefined)
    return { files, open }
  }
  const host = (label: string) => ({ label, address: `${label}.test`, port: 22, username: 'u', tags: [], keyId: null })
  const opened = async (s: VaultService) => {
    for (let i = 0; i < 50 && s.snapshot().vaults.length === 1; i++) await new Promise((r) => setTimeout(r, 5))
  }

  it('keeps each vault to itself, and shows one at a time', async () => {
    const { open } = multiDevice()
    const s = open()
    await s.create('master-password')
    expect(s.snapshot()).toMatchObject({ vaults: [{ name: 'Personal', personal: true }], activeVaultId: 'personal', multiVault: true })
    s.saveHost(null, host('home'))
    const work = s.addVault('Work')
    expect(s.snapshot().activeVaultId).toBe('personal') // adding does not switch
    s.switchVault(work)
    expect(s.snapshot().hosts).toEqual([])
    const workHost = s.saveHost(null, host('office'))
    s.saveSnippet(null, { label: 'up', script: 'uptime' })
    expect(s.snapshot().hosts.map((h) => h.label)).toEqual(['office'])
    s.switchVault('personal')
    expect(s.snapshot().hosts.map((h) => h.label)).toEqual(['home'])
    expect(s.snapshot().snippets).toEqual([])
    expect(s.host(workHost)).toBeUndefined() // not from another vault
    expect(() => s.addVault('work')).toThrow('already a vault called')
    expect(() => s.addVault(' ')).toThrow('Vault name is required')
  })

  it('refuses links to another vault, so nothing can be borrowed across', async () => {
    const { open } = multiDevice()
    const s = open()
    await s.create('master-password')
    const personalHost = s.saveHost(null, host('home'))
    const personalSnippet = s.saveSnippet(null, { label: 'up', script: 'uptime' })
    s.switchVault(s.addVault('Work'))
    expect(() => s.saveHost(null, { ...host('x'), jumpHostId: personalHost })).toThrow('Jump host not found')
    expect(() => s.saveHost(null, { ...host('x'), startupSnippetId: personalSnippet })).toThrow('Snippet not found')
    expect(() => s.saveForward(null, { hostId: personalHost, kind: 'dynamic', bindPort: 1080 })).toThrow('Choose a host')
  })

  it('reopens every vault after a lock, showing the one shown last; the Personal file stays as older versions read it', async () => {
    const { files, open } = multiDevice()
    const s = open()
    await s.create('master-password')
    s.saveHost(null, host('home'))
    const work = s.addVault('Work stuff')
    s.switchVault(work)
    s.saveHost(null, host('office'))
    await s.flush()
    s.lock()
    await s.flush()

    // The Personal vault's file is the old format, with only its own item.
    const personal = JSON.parse(files.get('vault')!)
    expect(personal.format).toBe(1)
    expect(Object.keys(personal.items)).toHaveLength(1)
    // The list of vaults gives nothing away.
    expect(files.get('vaults')).not.toContain('Work stuff')
    expect(files.has(`vault-${work}`)).toBe(true)

    const again = open()
    await again.unlock('master-password')
    await opened(again)
    expect(again.snapshot().vaults.map((v) => v.name)).toEqual(['Personal', 'Work stuff'])
    expect(again.snapshot().activeVaultId).toBe(work)
    expect(again.snapshot().hosts.map((h) => h.label)).toEqual(['office'])
  })

  it('still opens the other vaults after a master password change', async () => {
    const { open } = multiDevice()
    const s = open()
    await s.create('master-password')
    const work = s.addVault('Work')
    s.switchVault(work)
    s.saveHost(null, host('office'))
    await s.changePassword('master-password', 'a new password')
    await s.flush()
    s.lock()
    const again = open()
    await again.unlock('a new password')
    await opened(again)
    expect(again.snapshot().hosts.map((h) => h.label)).toEqual(['office'])
  })

  it('renames vaults, and deletes all but the Personal one, files and all', async () => {
    const { files, open } = multiDevice()
    const s = open()
    await s.create('master-password')
    const work = s.addVault('Work')
    s.renameVault(work, 'Clients')
    s.renameVault('personal', 'Mine')
    expect(s.snapshot().vaults.map((v) => v.name)).toEqual(['Mine', 'Clients'])
    expect(() => s.renameVault(work, 'mine')).toThrow('already a vault called')
    s.switchVault(work)
    await expect(s.deleteVault('personal')).rejects.toThrow('cannot be deleted')
    await s.deleteVault(work)
    await s.flush()
    expect(s.snapshot().vaults.map((v) => v.id)).toEqual(['personal'])
    expect(s.snapshot().activeVaultId).toBe('personal')
    expect(files.has(`vault-${work}`)).toBe(false)
    expect(() => s.switchVault(work)).toThrow('Vault not found')
  })

  it('a connection keeps to the vault it was made from, whichever is shown later', async () => {
    const { open } = multiDevice()
    const s = open()
    await s.create('master-password')
    const work = s.addVault('Work')
    s.switchVault(work)
    const office = s.saveHost(null, host('office'))
    const scope = s.scope()
    expect(scope.vaultId).toBe(work)
    s.switchVault('personal')
    expect(scope.host(office)?.data.label).toBe('office')
    scope.trustHostKey({ host: 'office.test', port: 22, keyType: 'ssh-ed25519', publicKey: 'AAAA', fingerprint: 'SHA256:x' }, false)
    expect(s.snapshot().knownHosts).toEqual([]) // known to the Work vault, not Personal
    s.switchVault(work)
    expect(s.snapshot().knownHosts.map((k) => k.host)).toEqual(['office.test'])
    await s.deleteVault(work)
    expect(() => scope.host(office)).toThrow('no longer on this device')
  })

  it('a device without named files keeps one vault', async () => {
    const s = device('none').open()
    await s.create('master-password')
    expect(s.snapshot().multiVault).toBe(false)
    expect(() => s.addVault('Work')).toThrow('keeps one vault only')
  })
})
