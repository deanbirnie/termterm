// End-to-end smoke test: drives the built app against a throwaway SSH server
// and sync server, covering vault creation, sync to a second device, host key
// trust, and a live terminal session.
//
//   npm run e2e            (Linux without a display: xvfb-run -a npm run e2e)
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')
const { Server, utils } = require('ssh2')
const { createApp } = await import('../../server/src/app.ts')

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const shots = process.env.E2E_SHOTS ?? join(appDir, 'test-results')
mkdirSync(shots, { recursive: true })
const tmp = mkdtempSync(join(tmpdir(), 'termterm-e2e-'))
const MASTER = 'correct horse battery'
const NEW_MASTER = 'staple gun orchestra'
const SSH_PASSWORD = 'ssh-secret-pw'

// ---- fixtures ---------------------------------------------------------------
// ssh2 sometimes generates an Ed25519 key it cannot parse; retry until valid.
function hostKey() {
  for (;;) {
    const key = utils.generateKeyPairSync('ed25519').private
    if (!(utils.parseKey(key) instanceof Error)) return key
  }
}
const logins = []
let authorizedKey = null // public key line the server accepts, set once the app generates one
const sshServer = new Server({ hostKeys: [hostKey()] }, (client) => {
  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === SSH_PASSWORD) {
        logins.push('password')
        return ctx.accept()
      }
      if (ctx.method === 'publickey' && ctx.username === 'tester' && authorizedKey) {
        const allowed = utils.parseKey(authorizedKey)
        const matches = ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH())
        if (matches && (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) {
          if (ctx.signature) logins.push('publickey')
          return ctx.accept()
        }
      }
      ctx.reject(['publickey', 'password'])
    })
    .on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (accept) => accept())
        session.on('window-change', (accept) => accept?.())
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('Welcome to the test box\r\n$ ')
          let line = ''
          stream.on('data', (chunk) => {
            for (const ch of chunk.toString()) {
              if (ch === '\r') {
                stream.write(`\r\nyou ran: ${line}\r\n$ `)
                line = ''
              } else {
                line += ch
                stream.write(ch)
              }
            }
          })
        })
      })
    })
    .on('error', () => {})
})
await new Promise((r) => sshServer.listen(0, '127.0.0.1', r))
const sshPort = sshServer.address().port

const sync = createApp({ dbPath: ':memory:' })
await new Promise((r) => sync.server.listen(0, '127.0.0.1', r))
const syncUrl = `http://127.0.0.1:${sync.server.address().port}`

async function launch(name) {
  const dataDir = join(tmp, name)
  const app = await electron.launch({
    executablePath: require('electron'),
    // The basic password store stands in for a real OS keyring, which CI lacks.
    args: [appDir, '--no-sandbox', '--password-store=basic'],
    env: { ...process.env, TERMTERM_DATA_DIR: dataDir, TERMTERM_INSECURE_KEYSTORE: '1' },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => { throw e })
  await page.setViewportSize({ width: 1180, height: 760 })
  return { app, page, dataDir }
}
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) })
async function assertCount(locator, n) {
  for (let i = 0; i < 100 && (await locator.count()) !== n; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(await locator.count(), n)
}
const step = (msg) => console.log(`  ✓ ${msg}`)

try {
  // ---- device A: create vault, add data, set up sync, connect ------------------
  const a = await launch('device-a')
  await a.page.getByLabel('Master password', { exact: true }).fill(MASTER)
  await a.page.getByLabel('Confirm master password').fill(MASTER)
  await shot(a.page, '01-create-vault')
  await a.page.getByRole('button', { name: 'Create vault' }).click()
  await a.page.getByText('No hosts yet').waitFor()
  step('vault created')

  await a.page.getByRole('navigation').getByRole('button', { name: 'Keychain', exact: true }).click()
  await a.page.getByRole('button', { name: 'Generate key' }).click()
  await a.page.getByLabel('Label').fill('deploy key')
  await a.page.getByRole('button', { name: 'Generate', exact: true }).click()
  await a.page.getByText('SHA256:').waitFor()
  authorizedKey = await a.page.getByLabel('Public key').inputValue()
  assert.match(authorizedKey, /^ssh-ed25519 AAAA/)
  await shot(a.page, '02-keychain')
  step('key generated')

  await a.page.getByRole('navigation').getByRole('button', { name: 'Snippets', exact: true }).click()
  await a.page.getByRole('button', { name: 'New snippet' }).click()
  await a.page.getByLabel('Label').fill('uptime')
  await a.page.getByLabel('Script').fill('uptime')
  await a.page.getByRole('button', { name: 'Save', exact: true }).click()

  await a.page.getByRole('navigation').getByRole('button', { name: 'Hosts', exact: true }).click()
  await a.page.getByRole('button', { name: 'New host' }).click()
  await a.page.getByLabel('Address').fill('127.0.0.1')
  await a.page.getByLabel('Label').fill('Test box')
  await a.page.getByLabel('Tags').fill('vps, e2e')
  await a.page.getByLabel('Username').fill('tester')
  await a.page.getByLabel('Port').fill(String(sshPort))
  await a.page.getByLabel('Password', { exact: true }).fill(SSH_PASSWORD)
  await a.page.getByRole('button', { name: 'Save host' }).click()
  await a.page.getByText('A password is saved.').waitFor()
  await shot(a.page, '03-hosts')
  step('host saved')

  const vaultFile = readFileSync(join(a.dataDir, 'vault.json'), 'utf8')
  for (const secret of [SSH_PASSWORD, MASTER, 'Test box', 'tester', 'PRIVATE KEY']) {
    assert.ok(!vaultFile.includes(secret), `vault file leaks "${secret}"`)
  }
  step('vault file contains no plaintext')

  await a.page.getByRole('navigation').getByRole('button', { name: 'Sync', exact: true }).click()
  await a.page.getByLabel('Sync server').fill(syncUrl)
  await a.page.getByLabel('Username').fill('dean')
  await a.page.getByLabel('Master password').fill('not the password')
  await a.page.getByRole('button', { name: 'Create account and sync' }).click()
  await a.page.getByText('Incorrect master password').waitFor()
  await a.page.getByLabel('Master password').fill(MASTER)
  await a.page.getByRole('button', { name: 'Create account and sync' }).click()
  await a.page.getByText('Up to date').waitFor()
  await shot(a.page, '04-sync')
  step('sync account created and vault uploaded')

  await a.page.getByRole('navigation').getByRole('button', { name: 'Hosts', exact: true }).click()
  await a.page.getByRole('button', { name: 'Connect', exact: true }).last().click()
  await a.page.getByRole('dialog', { name: 'Trust this host?' }).waitFor()
  await shot(a.page, '05-trust-host')
  await a.page.getByRole('button', { name: 'Trust and connect' }).click()
  const termA = a.page.locator('.pane:not([hidden]) .xterm-rows')
  await termA.getByText('Welcome to the test box').waitFor()
  await a.page.keyboard.type('echo hello')
  await a.page.keyboard.press('Enter')
  await termA.getByText('you ran: echo hello').waitFor()
  await a.page.getByRole('button', { name: 'Run snippet' }).click()
  await a.page.getByRole('button', { name: 'uptime' }).click()
  await termA.getByText('you ran: uptime').waitFor()
  await shot(a.page, '06-terminal')
  step('terminal session works (stored password, host key trusted, snippet run)')

  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.locator('.card', { hasText: 'Test box' }).click()
  await a.page.getByLabel('Key', { exact: true }).selectOption({ label: 'deploy key' })
  await a.page.getByRole('button', { name: 'Save and connect' }).click()
  await termA.getByText('Welcome to the test box').waitFor()
  assert.equal(logins.at(-1), 'publickey')
  assert.equal(await a.page.getByRole('dialog').count(), 0)
  step('second tab logged in with the vault key, no trust prompt this time')

  // ---- device B: sign in, everything arrives, no trust prompt --------------------
  const b = await launch('device-b')
  await b.page.getByRole('tab', { name: 'I already have one' }).click()
  await b.page.getByLabel('Sync server').fill(syncUrl)
  await b.page.getByLabel('Username').fill('dean')
  await b.page.getByLabel('Master password').fill('wrong password')
  await b.page.getByRole('button', { name: 'Sign in' }).click()
  await b.page.getByText('Incorrect username or master password').waitFor()
  await b.page.getByLabel('Master password').fill(MASTER)
  await b.page.getByRole('button', { name: 'Sign in' }).click()
  await b.page.getByText('Test box').waitFor()
  step('second device signed in and received the host')

  await b.page.getByRole('navigation').getByRole('button', { name: 'Keychain', exact: true }).click()
  await b.page.getByText('deploy key').waitFor()
  await b.page.getByRole('navigation').getByRole('button', { name: 'Known Hosts', exact: true }).click()
  await b.page.getByText('ssh-ed25519').waitFor()
  await b.page.getByRole('navigation').getByRole('button', { name: 'Hosts', exact: true }).click()
  await b.page.locator('.card', { hasText: 'Test box' }).dblclick()
  const termB = b.page.locator('.pane:not([hidden]) .xterm-rows')
  await termB.getByText('Welcome to the test box').waitFor()
  assert.equal(await b.page.getByRole('dialog').count(), 0)
  assert.equal(logins.at(-1), 'publickey')
  assert.equal(logins.filter((l) => l === 'publickey').length, 2)
  await shot(b.page, '07-device-b-terminal')
  step('second device logged in with the synced private key and known host, no prompt')

  // ---- an edit on B reaches A ---------------------------------------------------
  await b.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await b.page.locator('.card', { hasText: 'Test box' }).click()
  await b.page.getByLabel('Label').fill('Renamed on B')
  await b.page.getByRole('button', { name: 'Save changes' }).click()
  await b.page.getByRole('navigation').getByRole('button', { name: 'Sync', exact: true }).click()
  await b.page.getByText('Up to date').waitFor()
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.getByRole('navigation').getByRole('button', { name: 'Sync', exact: true }).click()
  await a.page.getByRole('button', { name: 'Sync now' }).click()
  await a.page.getByRole('navigation').getByRole('button', { name: 'Hosts', exact: true }).click()
  await a.page.locator('.card', { hasText: 'Renamed on B' }).waitFor()
  step('edit on device B synced back to device A')

  // ---- device list and remote sign-out -----------------------------------------------
  const nav = (page, name) => page.getByRole('navigation').getByRole('button', { name, exact: true })
  await nav(a.page, 'Sync').click()
  await a.page.getByText('This device', { exact: true }).waitFor()
  await assertCount(a.page.locator('.devices li'), 2)
  await shot(a.page, '08-devices')
  await a.page.getByRole('button', { name: /^Sign out/ }).click()
  await a.page.getByRole('button', { name: 'Confirm sign out' }).click()
  await assertCount(a.page.locator('.devices li'), 1)
  await nav(b.page, 'Sync').click()
  await b.page.getByRole('button', { name: 'Sync now' }).click()
  await b.page.getByRole('button', { name: 'Sign in again' }).waitFor()
  await b.page.getByLabel('Master password').fill(MASTER)
  await b.page.getByRole('button', { name: 'Sign in again' }).click()
  await b.page.getByText('Up to date').waitFor()
  await nav(b.page, 'Hosts').click()
  step('device A signed device B out remotely; B signed back in')

  // ---- master password change on A propagates to B ---------------------------------
  await nav(a.page, 'Settings').click()
  await a.page.getByLabel('Current master password').fill('not it at all')
  await a.page.getByLabel('New master password', { exact: true }).fill(NEW_MASTER)
  await a.page.getByLabel('Confirm new master password').fill(NEW_MASTER)
  await a.page.getByRole('button', { name: 'Change master password' }).click()
  await a.page.getByText('Incorrect master password').waitFor()
  await a.page.getByLabel('Current master password').fill(MASTER)
  await a.page.getByRole('button', { name: 'Change master password' }).click()
  await a.page.getByText('Master password changed.').waitFor()
  await shot(a.page, '09-settings')
  await nav(a.page, 'Sync').click()
  await a.page.getByRole('button', { name: 'Sync now' }).click()
  await a.page.getByText('Up to date').waitFor()
  step('master password changed on device A, which stays signed in')

  await nav(b.page, 'Sync').click()
  await b.page.getByRole('button', { name: 'Sync now' }).click()
  await b.page.getByRole('button', { name: 'Sign in again' }).waitFor()
  await b.page.getByLabel('Master password').fill(MASTER)
  await b.page.getByRole('button', { name: 'Sign in again' }).click()
  await b.page.getByText('Incorrect username or master password').waitFor()
  await b.page.getByLabel('Master password').fill(NEW_MASTER)
  await b.page.getByRole('button', { name: 'Sign in again' }).click()
  await b.page.getByText('Up to date').waitFor()
  await b.page.getByRole('button', { name: 'Lock vault' }).click()
  await b.page.getByText('1 open session is still running').waitFor()
  await b.page.getByLabel('Master password').fill(MASTER)
  await b.page.getByRole('button', { name: 'Unlock' }).click()
  await b.page.getByText('Incorrect master password').waitFor()
  await b.page.getByLabel('Master password').fill(NEW_MASTER)
  await b.page.getByRole('button', { name: 'Unlock' }).click()
  await b.page.locator('.card', { hasText: 'Renamed on B' }).waitFor()
  step('device B was signed out, re-authenticated and now unlocks with the new password')

  // ---- locking keeps sessions alive ------------------------------------------------
  await b.page.getByRole('tab', { name: /Test box/ }).click()
  await b.page.keyboard.type('still here')
  await b.page.keyboard.press('Enter')
  await termB.getByText('you ran: still here').waitFor()
  step('session opened before the lock is still usable after unlocking')
  await b.app.close()

  await a.page.getByRole('button', { name: 'Lock vault' }).click()
  await a.page.getByText('Vault locked').waitFor()
  await shot(a.page, '10-locked')
  await a.page.getByLabel('Master password').fill(NEW_MASTER)
  await a.page.getByRole('button', { name: 'Unlock' }).click()
  await a.page.locator('.card', { hasText: 'Renamed on B' }).waitFor()

  // ---- a changed host key is refused --------------------------------------------
  sshServer.close()
  const impostor = new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => { logins.push('impostor'); ctx.reject() }).on('error', () => {})
  })
  await new Promise((r) => impostor.listen(sshPort, '127.0.0.1', r))
  await a.page.locator('.card', { hasText: 'Renamed on B' }).dblclick()
  await a.page.getByRole('dialog', { name: 'Host key has changed' }).waitFor()
  await shot(a.page, '11-host-key-changed')
  await a.page.getByRole('button', { name: 'Disconnect' }).click()
  await a.page.getByText('Disconnected: Host key mismatch').waitFor()
  assert.ok(!logins.includes('impostor'), 'credentials were offered to an untrusted host')
  step('changed host key refused before any credentials were sent')

  // ---- open unlocked from the OS credential store; a lock forgets it ---------------
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await nav(a.page, 'Settings').click()
  await a.page.getByLabel('Open unlocked on this device').check()
  // Wait for the key to reach the credential store before quitting.
  for (let i = 0; i < 100 && !existsSync(join(a.dataDir, 'device-key.bin')); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  await a.app.close()
  const keyFile = readFileSync(join(a.dataDir, 'device-key.bin'))
  assert.ok(keyFile.length > 0)

  const a2 = await launch('device-a')
  await a2.page.locator('.card', { hasText: 'Renamed on B' }).waitFor()
  assert.equal(await a2.page.getByText('Vault locked').count(), 0)
  step('relaunch opened the vault from the OS credential store, no password asked')
  await a2.page.getByRole('button', { name: 'Lock vault' }).click()
  await a2.page.getByText('Vault locked').waitFor()
  await a2.app.close()
  assert.ok(!existsSync(join(a.dataDir, 'device-key.bin')), 'lock left the device key behind')

  const a3 = await launch('device-a')
  await a3.page.getByText('Vault locked').waitFor()
  await a3.page.getByLabel('Master password').fill(NEW_MASTER)
  await a3.page.getByRole('button', { name: 'Unlock' }).click()
  await a3.page.locator('.card', { hasText: 'Renamed on B' }).waitFor()
  await a3.app.close()
  assert.ok(existsSync(join(a.dataDir, 'device-key.bin')), 'unlock did not re-store the device key')
  step('locking forgot the stored key: the next launch needed the master password')

  impostor.close()
  console.log('\nE2E smoke test passed')
} finally {
  sync.server.close()
  sshServer.close()
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(0)
