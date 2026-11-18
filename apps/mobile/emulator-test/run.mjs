// The Android app itself, on an emulator: the real APK, its native SSH code
// and its WebView, against the throwaway SSH server from ../ssh-test.
//
//   node apps/mobile/emulator-test/run.mjs path/to/app-debug.apk
//
// Needs adb and one running emulator (CI starts it; see build.yml). The
// emulator reaches this machine's SSH server through `adb reverse`, and this
// machine reaches the phone's forwarded port through `adb forward`. The
// WebView is driven over its debugging socket (debug builds have it on).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _android as android } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const apk = resolve(process.argv[2] ?? '')
// Debug builds are installed as their own app, beside a release build (build.gradle).
const PKG = 'dev.termterm.app.debug'
const ACTIVITY = 'dev.termterm.app.MainActivity'
const MASTER = 'emulator master pw'
const SSH_PORT_ON_PHONE = 2222
const FORWARD_PORT = 18080
const shots = join(here, '..', 'test-results')
mkdirSync(shots, { recursive: true })

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 120_000 }).trim()
const step = (what) => console.log(`  ✓ ${what}`)

// ---- this machine: the SSH server, its files, and somewhere to forward to ----
const work = mkdtempSync(join(tmpdir(), 'termterm-emu-'))
const home = join(work, 'files/home/dean')
mkdirSync(join(home, 'docs'), { recursive: true })
writeFileSync(join(home, 'notes.txt'), 'remote notes\n')
chmodSync(join(home, 'notes.txt'), 0o644)
const server = spawn('node', [join(here, '../ssh-test/server.cjs'), join(work, 'authorized'), join(work, 'files')], {
  cwd: join(here, '../ssh-test'),
  stdio: ['ignore', 'pipe', 'inherit'],
})
const sshPort = await new Promise((ok, fail) => {
  server.stdout.once('data', (d) => ok(Number(String(d).trim())))
  server.once('exit', (code) => fail(new Error(`SSH test server exited (${code})`)))
})
const echo = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`))).listen(0, '127.0.0.1')
await new Promise((ok) => echo.once('listening', ok))
const echoPort = echo.address().port

let device
let page
try {
  // ---- the phone ----
  adb('wait-for-device')
  adb('install', '-r', '-g', apk)
  adb('reverse', `tcp:${SSH_PORT_ON_PHONE}`, `tcp:${sshPort}`)
  adb('shell', 'am', 'force-stop', PKG)
  // am start reports a missing app or activity in its output, not its exit code.
  const started = adb('shell', 'am', 'start', '-W', '-n', `${PKG}/${ACTIVITY}`)
  assert.doesNotMatch(started, /Error|does not exist/, started)
  ;[device] = await android.devices()
  assert.ok(device, 'no Android device found')
  const webView = await device.webView({ pkg: PKG }, { timeout: 60_000 })
  page = await webView.page()
  page.setDefaultTimeout(30_000)
  // An update card appears whenever a newer release exists; it is not what this tests.
  const dismissUpdate = async () => {
    const notNow = page.getByRole('button', { name: 'Not now' })
    if (await notNow.count()) await notNow.click()
  }
  const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true })

  await page.getByLabel('Master password', { exact: true }).fill(MASTER)
  await page.getByLabel('Confirm master password').fill(MASTER)
  await page.getByRole('button', { name: 'Create vault' }).click()
  await page.getByText('No hosts yet').waitFor()
  await dismissUpdate()
  step('the installed app starts and creates a vault')

  // ---- a terminal over the app's own SSH ----
  await page.getByRole('button', { name: 'New host' }).click()
  await page.getByLabel('Address').fill('127.0.0.1')
  await page.getByLabel('Label').fill('Test box')
  await page.getByLabel('Username').fill('dean')
  await page.getByLabel('Port').fill(String(SSH_PORT_ON_PHONE))
  await page.getByLabel('Password', { exact: true }).fill('pw-ok')
  await page.getByRole('button', { name: 'Save host' }).click()
  await page.getByText('A password is saved.').waitFor()
  await page.getByRole('button', { name: 'Connect', exact: true }).last().click()
  await page.getByRole('dialog', { name: 'Trust this host?' }).waitFor()
  await page.getByRole('button', { name: 'Trust and connect' }).click()
  const term = page.locator('.pane:not([hidden]) .xterm-rows')
  await term.getByText(/welcome \d+x\d+/).waitFor()
  await page.locator('.pane:not([hidden]) .xterm').click()
  await page.keyboard.type('echo from-the-phone')
  await page.keyboard.press('Enter')
  await term.getByText('ran:echo from-the-phone').waitFor()
  await page.screenshot({ path: join(shots, 'emulator-terminal.png') })
  step('a terminal logs in with the saved password and runs a command')

  // ---- a port forward on the phone ----
  await page.getByRole('button', { name: 'Vault', exact: true }).click()
  await nav('Forwarding').click()
  await page.getByRole('button', { name: 'New port forward' }).click()
  const panel = page.getByRole('complementary', { name: 'Port forward' })
  await panel.getByLabel('Through host').selectOption({ label: 'Test box' })
  await panel.getByLabel('Kind').selectOption('local')
  await panel.getByLabel('Listening port').fill(String(FORWARD_PORT))
  await panel.getByLabel('Destination host').fill('127.0.0.1')
  await panel.getByLabel('Destination port').fill(String(echoPort))
  await panel.getByRole('button', { name: 'Save' }).click()
  await panel.getByRole('button', { name: 'Close' }).click()
  const label = `${FORWARD_PORT} → 127.0.0.1:${echoPort}`
  await page.getByRole('button', { name: `Start ${label}` }).click()
  await page.getByText(/^Running · 0 connections$/).waitFor()
  adb('forward', `tcp:${FORWARD_PORT}`, `tcp:${FORWARD_PORT}`)
  const reply = await new Promise((ok) => {
    const sock = net.connect(FORWARD_PORT, '127.0.0.1', () => sock.write('ping'))
    let got = ''
    sock.on('data', (d) => {
      got += d
      if (got.includes('echo:ping')) sock.end()
    })
    sock.on('close', () => ok(got))
    sock.on('error', (e) => ok(`error: ${e.message}`))
    setTimeout(() => sock.destroy(), 15_000)
  })
  assert.match(reply, /echo:ping/)
  await page.getByRole('button', { name: `Stop ${label}` }).click()
  await page.getByRole('button', { name: `Start ${label}` }).waitFor()
  step('a local port forward on the phone carries traffic through the server')

  // ---- files: browse, permissions, edit in place ----
  await nav('Hosts').click()
  await page.locator('.card', { hasText: 'Test box' }).click()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const files = page.getByRole('region', { name: 'Server' })
  const row = (name) => files.getByRole('option', { name, exact: true })
  await row('notes.txt').waitFor()
  await row('docs').waitFor()
  await row('notes.txt').click()
  await files.getByRole('button', { name: 'Permissions' }).click()
  const perms = page.getByRole('dialog', { name: 'Permissions of notes.txt' })
  assert.equal(await perms.getByLabel('As a number (like chmod)').inputValue(), '644')
  await perms.getByLabel('As a number (like chmod)').fill('600')
  await perms.getByRole('button', { name: 'Apply' }).click()
  await perms.waitFor({ state: 'detached' })
  assert.equal(statSync(join(home, 'notes.txt')).mode & 0o777, 0o600)
  await files.getByRole('button', { name: 'Edit' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit notes.txt' })
  const text = editor.getByLabel('File text')
  await text.waitFor()
  assert.equal(await text.inputValue(), 'remote notes\n')
  await text.fill('edited on the phone\n')
  await page.screenshot({ path: join(shots, 'emulator-editor.png') })
  await editor.getByRole('button', { name: 'Save' }).click()
  await editor.getByText('Saved', { exact: true }).waitFor()
  assert.equal(readFileSync(join(home, 'notes.txt'), 'utf8'), 'edited on the phone\n')
  assert.equal(statSync(join(home, 'notes.txt')).mode & 0o777, 0o600)
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  await row('docs').click()
  await row('docs').waitFor({ state: 'detached' })
  step('files: a folder listing, permissions changed, a file edited in place')

  console.log('\nEmulator test passed')
} catch (e) {
  if (page) await page.screenshot({ path: join(shots, 'emulator-failure.png') }).catch(() => {})
  try {
    writeFileSync(join(shots, 'emulator-logcat.txt'), adb('logcat', '-d', '-t', '2000'))
  } catch {}
  throw e
} finally {
  await device?.close().catch(() => {})
  server.kill()
  echo.close()
}
