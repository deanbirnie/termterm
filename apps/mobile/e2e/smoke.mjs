// End-to-end smoke test for the mobile app's web layer, run in a phone-sized
// browser: create a vault, save a host, set up sync, then sign in from a
// second "device" (a separate browser profile) and see the data arrive.
//
// This covers everything except the Android shell itself: the shared
// interface at phone size, the vault and crypto running in a browser engine,
// storage through Capacitor, and cross-origin calls to the sync server.
//
//   npm run e2e -w @termterm/mobile
//   (set CHROME_PATH to use a specific Chromium instead of Playwright's own)
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')
const { createApp } = await import('../../server/src/app.ts')

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.E2E_SHOTS ?? join(appDir, 'test-results')
mkdirSync(shots, { recursive: true })
const MASTER = 'correct horse battery'

const sync = createApp({ dbPath: ':memory:' })
await new Promise((r) => sync.server.listen(0, '127.0.0.1', r))
const syncUrl = `http://127.0.0.1:${sync.server.address().port}`

const web = await preview({ root: appDir, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
const appUrl = `http://127.0.0.1:${web.httpServer.address().port}/`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const step = (msg) => console.log(`  ✓ ${msg}`)
const nav = (page, name) => page.getByRole('navigation').getByRole('button', { name, exact: true })

async function device() {
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    throw e
  })
  await page.goto(appUrl)
  return page
}

try {
  // ---- first device ---------------------------------------------------------------
  const a = await device()
  await a.getByLabel('Master password', { exact: true }).fill(MASTER)
  await a.getByLabel('Confirm master password').fill(MASTER)
  await a.getByRole('button', { name: 'Create vault' }).click()
  await a.getByText('No hosts yet').waitFor()
  step('vault created in the browser engine')

  // Nothing that needs SSH is offered yet.
  assert.equal(await a.getByRole('button', { name: 'Connect', exact: true }).count(), 0)

  await a.getByRole('button', { name: 'New host' }).click()
  await a.getByLabel('Address').fill('10.0.0.5')
  await a.getByLabel('Label').fill('Home server')
  await a.getByLabel('Username').fill('dean')
  await a.getByLabel('Password', { exact: true }).fill('host-secret-pw')
  await a.getByRole('button', { name: 'Save host' }).click()
  await a.getByText('A password is saved.').waitFor()
  await a.screenshot({ path: join(shots, '01-host.png') })
  await a.getByRole('button', { name: 'Close' }).click()
  await a.locator('.card', { hasText: 'Home server' }).waitFor()
  step('host saved')

  // The stored vault holds no plaintext.
  const stored = await a.evaluate(async () => {
    const dbs = await indexedDB.databases()
    const dump = []
    for (const { name } of dbs) {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open(name)
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      for (const store of db.objectStoreNames) {
        dump.push(
          await new Promise((res) => {
            const req = db.transaction(store).objectStore(store).getAll()
            req.onsuccess = () => res(JSON.stringify(req.result))
          }),
        )
      }
    }
    return dump.join('\n') + JSON.stringify({ ...localStorage })
  })
  assert.ok(stored.includes('wrappedVaultKey'), 'vault file was not found in storage')
  for (const secret of ['host-secret-pw', MASTER, 'Home server', '10.0.0.5']) {
    assert.ok(!stored.includes(secret), `stored vault leaks "${secret}"`)
  }
  step('stored vault contains no plaintext')

  await nav(a, 'Sync').click()
  await a.getByLabel('Sync server').fill(syncUrl)
  await a.getByLabel('Username').fill('dean')
  await a.getByLabel('Master password').fill(MASTER)
  await a.getByRole('button', { name: 'Create account and sync' }).click()
  await a.getByText('Up to date').waitFor()
  await a.screenshot({ path: join(shots, '02-sync.png') })
  step('sync account created across origins')

  // ---- survives a reload, locked --------------------------------------------------------
  await a.reload()
  await a.getByText('Vault locked').waitFor()
  await a.getByLabel('Master password').fill('wrong password')
  await a.getByRole('button', { name: 'Unlock' }).click()
  await a.getByText('Incorrect master password').waitFor()
  await a.getByLabel('Master password').fill(MASTER)
  await a.getByRole('button', { name: 'Unlock' }).click()
  await a.locator('.card', { hasText: 'Home server' }).waitFor()
  step('vault persisted across a restart and unlocks only with the right password')

  // ---- second device --------------------------------------------------------------------
  const b = await device()
  await b.getByRole('tab', { name: 'I already have one' }).click()
  await b.getByLabel('Sync server').fill(syncUrl)
  await b.getByLabel('Username').fill('dean')
  await b.getByLabel('Master password').fill(MASTER)
  await b.getByRole('button', { name: 'Sign in' }).click()
  await b.locator('.card', { hasText: 'Home server' }).waitFor()
  step('second device signed in and received the host')

  await b.locator('.card', { hasText: 'Home server' }).click()
  await b.getByLabel('Label').fill('Renamed on phone')
  await b.getByRole('button', { name: 'Save changes' }).click()
  await b.getByRole('button', { name: 'Close' }).click()
  await nav(b, 'Sync').click()
  await b.getByText('Up to date').waitFor()
  await nav(a, 'Sync').click()
  await a.getByRole('button', { name: 'Sync now' }).click()
  await nav(a, 'Hosts').click()
  await a.locator('.card', { hasText: 'Renamed on phone' }).waitFor()
  step('an edit on one device reached the other')

  await nav(a, 'Settings').click()
  await a.getByText('Install new versions of the mobile app from the releases page.').waitFor()
  await a.screenshot({ path: join(shots, '03-settings.png') })
  console.log('\nMobile E2E smoke test passed')
} finally {
  await browser.close()
  await new Promise((r) => web.httpServer.close(r))
  sync.server.close()
}
process.exit(0)
