/**
 * Makes compatibility fixtures with an earlier release's own code, so tests can
 * check that today's app and server still read what that release wrote.
 *
 *   apps/server/test/compat/make-fixtures.sh <tag>   (calls this)
 *
 * Writes, into fixtures/<tag>/:
 *   vault-local.json   a vault that never synced
 *   vault-synced.json  a vault synced to an account on that release's server
 *   server.sqlite      that server's database, with the account
 *   expected.json      the password and what each vault should contain
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'

const [srcDir, outDir, tag] = process.argv.slice(2)
if (!srcDir || !outDir || !tag) throw new Error('usage: make-fixture.ts <source dir> <out dir> <tag>')
const core = await import(resolve(srcDir, 'packages/core/src/index.ts'))
const { createApp } = await import(resolve(srcDir, 'apps/server/src/app.ts'))

const [major, minor] = tag.replace(/^v/, '').split('.').map(Number)
const atLeast = (maj: number, min: number) => major! > maj || (major === maj && minor! >= min)
const password = `fixture ${tag} password`

/** The same content in both vaults, using only what this release knew about. */
function fill(vault: any) {
  const key = vault.put('key', {
    label: 'fixture key',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixtureFixtureFixtureFixture fixture',
    keyType: 'ssh-ed25519',
  })
  const bastion = vault.put('host', { label: 'bastion', address: 'bastion.example', port: 22, username: 'ops', tags: ['edge'], keyId: key.id })
  const web = vault.put('host', {
    label: 'web', address: '10.0.0.5', port: 2222, username: 'deploy', tags: [], password: 'web-pw',
    ...(atLeast(0, 8) ? { jumpHostId: bastion.id } : {}),
  })
  vault.put('snippet', { label: 'uptime', script: 'uptime' })
  vault.put('knownHost', { host: 'bastion.example', port: 22, keyType: 'ssh-ed25519', publicKey: 'AAAAhostkey', fingerprint: 'SHA256:fixture' })
  if (atLeast(0, 8)) vault.put('forward', { label: 'db', hostId: web.id, kind: 'local', bindHost: '127.0.0.1', bindPort: 5432, destHost: 'db', destPort: 5432 })
  if (atLeast(0, 9)) {
    const identity = vault.put('identity', { label: 'Ops', username: 'ops', keyId: key.id })
    vault.put('host', { label: 'grouped', address: 'g.example', port: 22, username: '', tags: [], identityId: identity.id, group: 'Lab' }, undefined)
  }
  const gone = vault.put('host', { label: 'deleted', address: 'gone.example', port: 22, username: 'x', tags: [] })
  vault.delete(gone.id)
  return { deletedId: gone.id }
}

const describe = (vault: any) =>
  vault.list().map((i: any) => ({ id: i.id, type: i.type, data: i.data })).sort((a: any, b: any) => a.id.localeCompare(b.id))

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const local = await core.Vault.create(password)
const localInfo = fill(local)
writeFileSync(join(outDir, 'vault-local.json'), JSON.stringify(local.toFile(), null, 2))

const dbPath = join(outDir, 'work.db')
const app = createApp({ dbPath })
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
const synced = await core.Vault.create(password)
const syncedInfo = fill(synced)
const token = await new core.SyncApi(url).register('fixture', synced.kdf, await synced.authKeyFor(password), synced.wrappedVaultKey)
synced.setSync(url, 'fixture', token)
await core.syncVault(synced)
writeFileSync(join(outDir, 'vault-synced.json'), JSON.stringify(synced.toFile(), null, 2))
// Closing the server closes its database, which folds the write-ahead log in.
await new Promise<void>((r) => app.server.close(() => r()))
if (app.db.isOpen) app.db.close()
copyFileSync(dbPath, join(outDir, 'server.sqlite'))
for (const f of ['work.db', 'work.db-wal', 'work.db-shm']) rmSync(join(outDir, f), { force: true })

writeFileSync(
  join(outDir, 'expected.json'),
  JSON.stringify(
    {
      tag,
      password,
      username: 'fixture',
      local: { items: describe(local), deletedId: localInfo.deletedId },
      synced: { items: describe(synced), deletedId: syncedInfo.deletedId },
    },
    null,
    2,
  ) + '\n',
)
console.log(`${tag}: ${describe(local).length} items in each vault, written to ${outDir}`)
