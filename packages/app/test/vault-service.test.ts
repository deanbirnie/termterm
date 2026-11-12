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
  return { open, state, log, hasKey: () => stored !== null }
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
