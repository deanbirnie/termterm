/**
 * A stand-in for Windows Hello, for automated tests on machines without it.
 *
 * It "signs" with a secret kept in a file, so it releases the vault key with
 * no check at all. index.ts only uses it when running from source (never in a
 * packaged app) and TERMTERM_FAKE_HELLO=1 is set. If a file named
 * fake-hello-cancel exists next to it, the next request is cancelled, as if
 * the user dismissed the prompt.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HelloCancelled, HelloKeyMissing, type HelloSigner } from './hello-key-store.ts'

export function fakeHelloSigner(dir: string): HelloSigner {
  const secretFile = join(dir, 'fake-hello-secret')
  const cancelFile = join(dir, 'fake-hello-cancel')
  const cancelled = () => {
    if (!existsSync(cancelFile)) return false
    rmSync(cancelFile)
    return true
  }
  return {
    supported: async () => true,
    async create() {
      if (cancelled()) throw new HelloCancelled()
      mkdirSync(dir, { recursive: true })
      writeFileSync(secretFile, randomBytes(32))
    },
    async sign(challenge) {
      if (cancelled()) throw new HelloCancelled()
      if (!existsSync(secretFile)) throw new HelloKeyMissing()
      return createHmac('sha256', readFileSync(secretFile)).update(challenge).digest()
    },
    async remove() {
      rmSync(secretFile, { force: true })
    },
  }
}
