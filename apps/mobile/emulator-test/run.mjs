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
  env: { ...process.env, SSH_TEST_LOG: '1' },
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
  // The on-screen keyboard shifts the WebView's visual viewport, which throws
  // Playwright's click positions off; a person taps elsewhere to close it first.
  const closeKeyboard = async () => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.waitForTimeout(1000)
  }
  // Nothing may make the page wider than the screen: what is past the edge cannot be tapped.
  const fitsScreen = async (where) => {
    const [page_, screen] = await page.evaluate(() => [innerWidth, Math.round(visualViewport.width * visualViewport.scale)])
    assert.ok(page_ <= screen + 1, `${where}: the page is ${page_}px wide on a ${screen}px screen`)
  }
  const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true })

  await page.getByLabel('Master password', { exact: true }).fill(MASTER)
  await page.getByLabel('Confirm master password').fill(MASTER)
  await page.getByRole('button', { name: 'Create vault' }).click()
  await page.getByText('No hosts yet').waitFor()
  await dismissUpdate()
  await fitsScreen('Hosts')
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
  // Typing goes to xterm's hidden text box, which must have the focus.
  const input = page.locator('.pane:not([hidden]) .xterm-helper-textarea')
  await page.locator('.pane:not([hidden]) .xterm').click()
  await input.focus()
  const active = await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`)
  assert.match(active, /xterm-helper-textarea/, `the terminal did not take the focus (${active} has it)`)
  // What reaches the page and what goes to the native side, to say where typing stops if it does.
  await page.evaluate(() => {
    const seen = (window.__seen = { events: {}, native: [] })
    const box = document.querySelector('.pane:not([hidden]) .xterm-helper-textarea')
    for (const type of ['keydown', 'keypress', 'beforeinput', 'input', 'compositionend']) {
      box?.addEventListener(type, () => (seen.events[type] = (seen.events[type] ?? 0) + 1), true)
    }
    const cap = window.Capacitor
    const nativePromise = cap?.nativePromise?.bind(cap)
    if (nativePromise) {
      cap.nativePromise = (plugin, method, options) => {
        const n = seen.native.push(`${plugin}.${method}`) - 1
        return nativePromise(plugin, method, options).then(
          (v) => ((seen.native[n] += ' ok'), v),
          (e) => ((seen.native[n] += ` rejected: ${e?.message ?? e}`), Promise.reject(e)),
        )
      }
    }
  })
  // A phone's keyboard hands over text as input (as an IME commits it), and Enter as a key.
  await page.keyboard.insertText('echo from-the-phone')
  await page.keyboard.press('Enter')
  try {
    await term.getByText('ran:echo from-the-phone').waitFor({ timeout: 15_000 })
  } catch (e) {
    const shown = await term.innerText().catch(() => '?')
    const seen = await page.evaluate(() => JSON.stringify(window.__seen))
    throw new Error(`typed text did not reach the server. Seen: ${seen}. Terminal shows:\n${shown}`, { cause: e })
  }
  await page.screenshot({ path: join(shots, 'emulator-terminal.png') })
  await fitsScreen('Terminal')
  step('a terminal logs in with the saved password and runs a command')

  // ---- a port forward on the phone ----
  await page.getByRole('button', { name: 'Vault', exact: true }).click()
  // On a phone the host's details cover the page (and its navigation) until closed.
  const details = page.getByRole('complementary', { name: 'Host details' })
  if (await details.count()) await details.getByRole('button', { name: 'Close' }).click()
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
  await fitsScreen('Files')
  // Call after call (each a new native call, the pattern that once closed the channel).
  for (let i = 0; i < 15; i++) {
    await files.getByRole('button', { name: 'Refresh' }).click()
    await page.waitForTimeout(300)
    await row('notes.txt').waitFor({ timeout: 10_000 })
  }
  assert.equal(await files.getByRole('alert').count(), 0, 'an error showed while refreshing')
  await row('notes.txt').click()
  await files.getByRole('button', { name: 'Permissions' }).click()
  const perms = page.getByRole('dialog', { name: 'Permissions of notes.txt' })
  assert.equal(await perms.getByLabel('As a number (like chmod)').inputValue(), '644')
  await perms.getByLabel('As a number (like chmod)').fill('600')
  await closeKeyboard()
  try {
    await perms.getByRole('button', { name: 'Apply' }).click({ timeout: 10_000 })
  } catch (e) {
    // Where everything is, to tell a layout fault from a click-position one.
    const geometry = await page.evaluate(() => {
      const r = (el) => el && JSON.stringify(el.getBoundingClientRect())
      const button = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Apply')
      const box = button?.getBoundingClientRect()
      const at = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return {
        inner: [innerWidth, innerHeight],
        visual: window.visualViewport && [visualViewport.width, visualViewport.height, visualViewport.offsetTop, visualViewport.scale],
        dpr: devicePixelRatio,
        backdrop: r(document.querySelector('.modal-backdrop')),
        modal: r(document.querySelector('.modal')),
        modalScroll: document.querySelector('.modal') && [document.querySelector('.modal').scrollTop, document.querySelector('.modal').scrollHeight],
        button: r(button),
        atButtonCentre: at && `${at.tagName}.${at.className}`,
      }
    })
    throw new Error(`Apply could not be pressed: ${JSON.stringify(geometry)}`, { cause: e })
  }
  await perms.waitFor({ state: 'detached' })
  assert.equal(statSync(join(home, 'notes.txt')).mode & 0o777, 0o600)
  await files.getByRole('button', { name: 'Edit' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit notes.txt' })
  const text = editor.getByLabel('File text')
  await text.waitFor()
  assert.equal(await text.inputValue(), 'remote notes\n')
  // fill() selects all and types over it, but in Android's WebView the
  // selection can snap to the first word: set the text as an edit would.
  await text.evaluate((el, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, 'edited on the phone\n')
  assert.equal(await text.inputValue(), 'edited on the phone\n')
  await page.screenshot({ path: join(shots, 'emulator-editor.png') })
  await closeKeyboard()
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
    const log = adb('logcat', '-d', '-t', '3000')
    writeFileSync(join(shots, 'emulator-logcat.txt'), log)
    // The artifact is not always to hand: the lines that matter go in the job log too.
    let pid = ''
    try {
      pid = adb('shell', 'pidof', PKG)
    } catch {}
    console.error(`\nApp process now: ${pid || 'not running'}`)
    // The app's own tags only: system lines that merely name the package drown them out.
    console.error(adb('logcat', '-d', '-v', 'brief', '-s', 'termterm:V', 'AndroidRuntime:E', 'Capacitor:V', 'Capacitor/Plugin:V', 'Capacitor/Console:V', 'chromium:W', 'JSch:V').split('\n').slice(-150).join('\n'))
  } catch {}
  throw e
} finally {
  await device?.close().catch(() => {})
  server.kill()
  echo.close()
}
