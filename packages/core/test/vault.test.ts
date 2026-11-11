import { describe, expect, it } from 'vitest'
import {
  DecryptError,
  Vault,
  WrongPasswordError,
  deriveKeys,
  newKdfParams,
  open,
  seal,
  validateKdfParams,
  type HostData,
} from '../src/index.ts'

const host = (label: string): HostData => ({
  label,
  address: '10.0.0.1',
  port: 22,
  username: 'root',
  tags: [],
  password: 'hunter2',
})

describe('crypto', () => {
  it('derives distinct, deterministic wrap and auth keys', async () => {
    const kdf = newKdfParams()
    const a = await deriveKeys('correct horse', kdf)
    const b = await deriveKeys('correct horse', kdf)
    const c = await deriveKeys('wrong horse', kdf)
    expect(a.wrapKey).toEqual(b.wrapKey)
    expect(a.authKey).toEqual(b.authKey)
    expect(a.wrapKey).not.toEqual(a.authKey)
    expect(a.wrapKey).not.toEqual(c.wrapKey)
  })

  it('rejects tampering and context swaps', () => {
    const key = new Uint8Array(32).fill(7)
    const box = seal(key, new TextEncoder().encode('secret'), 'ctx-a')
    expect(new TextDecoder().decode(open(key, box, 'ctx-a'))).toBe('secret')
    expect(() => open(key, box, 'ctx-b')).toThrow(DecryptError)
    const raw = Buffer.from(box, 'base64')
    raw[raw.length - 1]! ^= 1
    expect(() => open(key, raw.toString('base64'), 'ctx-a')).toThrow(DecryptError)
    expect(() => open(new Uint8Array(32), box, 'ctx-a')).toThrow(DecryptError)
  })

  it('refuses weak KDF parameters', () => {
    const kdf = newKdfParams()
    expect(() => validateKdfParams({ ...kdf, m: 8 })).toThrow()
    expect(() => validateKdfParams({ ...kdf, t: 1 })).toThrow()
    expect(() => validateKdfParams({ ...kdf, alg: 'pbkdf2' })).toThrow()
  })
})

describe('vault', () => {
  it('round-trips items through the encrypted file', async () => {
    const vault = await Vault.create('pw')
    const item = vault.put('host', host('web'))
    const file = vault.toFile()

    const onDisk = JSON.stringify(file)
    expect(onDisk).not.toContain('hunter2')
    expect(onDisk).not.toContain('10.0.0.1')
    expect(onDisk).not.toContain('web')

    const reopened = await Vault.unlock(JSON.parse(onDisk), 'pw')
    expect(reopened.get<HostData>(item.id)?.data).toEqual(host('web'))
    await expect(Vault.unlock(file, 'nope')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('updates and deletes', async () => {
    const vault = await Vault.create('pw')
    const a = vault.put('host', host('a'))
    const updated = vault.put('host', host('a2'), a.id)
    expect(updated.updatedAt).toBeGreaterThan(a.updatedAt)
    expect(vault.list('host')).toHaveLength(1)
    vault.delete(a.id)
    expect(vault.list()).toHaveLength(0)
    expect(Object.keys(vault.toFile().items)).toHaveLength(0)
  })

  it('detects a blob moved to another item id', async () => {
    const vault = await Vault.create('pw')
    const a = vault.put('host', host('a'))
    const file = vault.toFile()
    file.items['other-id'] = file.items[a.id]!
    await expect(Vault.unlock(file, 'pw')).rejects.toBeInstanceOf(DecryptError)
  })
})
