import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HelloCancelled,
  HelloKeyMissing,
  HelloKeyStore,
  type HelloSigner,
} from '../src/main/hello-key-store.ts'
import { encodeCommand, parseResult } from '../src/main/powershell.ts'

/** Stands in for Windows Hello: a key that signs deterministically, as Hello's RSA keys do. */
function fakeHello() {
  let secret: Buffer | null = null
  const calls: string[] = []
  const next: { cancel?: boolean; missing?: boolean } = {}
  const signer: HelloSigner = {
    supported: async () => true,
    create: async () => {
      calls.push('create')
      secret = randomBytes(32)
    },
    sign: async (challenge) => {
      calls.push('sign')
      if (next.cancel) {
        next.cancel = false
        throw new HelloCancelled()
      }
      if (next.missing || !secret) throw new HelloKeyMissing()
      return createHmac('sha256', secret).update(challenge).digest()
    },
    remove: async () => {
      calls.push('remove')
      secret = null
    },
  }
  return {
    signer,
    calls,
    next,
    replaceKey: () => (secret = randomBytes(32)),
  }
}

const file = () => join(mkdtempSync(join(tmpdir(), 'termterm-hello-')), 'hello-key.json')
const vaultKey = () => new Uint8Array(randomBytes(32))

describe('vault key behind Windows Hello', () => {
  it('stores the key so only a Hello signature releases it', async () => {
    const hello = fakeHello()
    const path = file()
    const store = new HelloKeyStore(path, hello.signer)
    const key = vaultKey()

    expect(store.userPresence).toBe(true)
    expect(store.has()).toBe(false)
    await store.save(key)
    expect(hello.calls).toEqual(['create', 'sign'])
    expect(store.has()).toBe(true)

    // Nothing on disk gives the key away.
    const onDisk = readFileSync(path, 'utf8')
    expect(onDisk).not.toContain(Buffer.from(key).toString('base64'))
    expect(onDisk).not.toContain(Buffer.from(key).toString('hex'))

    expect(await store.load()).toEqual(key)
    expect(hello.calls).toEqual(['create', 'sign', 'sign'])
  })

  it('keeps the stored key when the prompt is cancelled', async () => {
    const hello = fakeHello()
    const store = new HelloKeyStore(file(), hello.signer)
    const key = vaultKey()
    await store.save(key)

    hello.next.cancel = true
    await expect(store.load()).rejects.toThrow('Cancelled')
    expect(store.has()).toBe(true)
    expect(await store.load()).toEqual(key)
  })

  it('asks to be set up again when the Hello key was removed or replaced', async () => {
    const missing = fakeHello()
    const store = new HelloKeyStore(file(), missing.signer)
    await store.save(vaultKey())
    missing.next.missing = true
    await expect(store.load()).rejects.toThrow(/setting up again/)
    expect(store.has()).toBe(false)

    const replaced = fakeHello()
    const other = new HelloKeyStore(file(), replaced.signer)
    await other.save(vaultKey())
    replaced.replaceKey() // e.g. Windows Hello was reset and set up anew
    await expect(other.load()).rejects.toThrow(/setting up again/)
    expect(other.has()).toBe(false)
  })

  it('refuses a stored file that was tampered with', async () => {
    const hello = fakeHello()
    const path = file()
    const store = new HelloKeyStore(path, hello.signer)
    await store.save(vaultKey())
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    stored.data = Buffer.from(randomBytes(32)).toString('base64')
    writeFileSync(path, JSON.stringify(stored))
    await expect(store.load()).rejects.toThrow(/setting up again/)

    writeFileSync(path, 'not json')
    await expect(store.load()).rejects.toThrow(/setting up again/)
  })

  it('removes both the file and the Hello key when cleared', async () => {
    const hello = fakeHello()
    const path = file()
    const store = new HelloKeyStore(path, hello.signer)
    await store.save(vaultKey())
    store.clear()
    await new Promise((r) => setTimeout(r, 10))
    expect(existsSync(path)).toBe(false)
    expect(hello.calls.at(-1)).toBe('remove')
    expect(await store.load()).toBeNull()
  })

  it('reports Hello as unavailable when asking Windows fails', async () => {
    const store = new HelloKeyStore(file(), {
      ...fakeHello().signer,
      supported: async () => {
        throw new Error('no PowerShell')
      },
    })
    expect(await store.available()).toBe(false)
  })
})

describe('PowerShell runner', () => {
  it('passes arguments safely in an encoded command', () => {
    const encoded = encodeCommand('param($Action, $Challenge) $Action', {
      Action: 'sign',
      Challenge: "it's; Remove-Item C:\\ -Recurse",
    })
    const command = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(command).toContain("-Action 'sign'")
    // A quote in a value is doubled, so it cannot end the string early.
    expect(command).toContain("-Challenge 'it''s; Remove-Item C:\\ -Recurse'")
  })

  it('reads the last line of output as the result', () => {
    expect(parseResult('noise\r\n{"ok":true,"supported":true}\r\n')).toEqual({ ok: true, supported: true })
    expect(parseResult('{"ok":false,"status":"UserCanceled"}')).toEqual({ ok: false, status: 'UserCanceled' })
    expect(parseResult('')).toMatchObject({ ok: false, status: 'Error' })
    expect(parseResult('something went wrong')).toMatchObject({
      ok: false,
      status: 'Error',
      message: 'something went wrong',
    })
  })
})
