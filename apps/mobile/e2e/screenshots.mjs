// Takes the phone screenshots used in the README (docs/screenshots/), from the
// app's interface in a phone-sized browser. Everything shown is made up.
//
// A browser lacks the installed app's native parts (SSH, fingerprint unlock),
// so this presents them as the installed app would: the capabilities it
// reports, and a stand-in session with canned output for the terminal shot.
//
//   npm run build -w @termterm/mobile
//   CHROME_PATH=/path/to/chrome node apps/mobile/e2e/screenshots.mjs
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(appDir, '../../docs/screenshots')
mkdirSync(out, { recursive: true })

const web = await preview({ root: appDir, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage()
const shot = (name) => page.screenshot({ path: join(out, name) })
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true })

await page.addInitScript(() => {
  const encoder = new TextEncoder()
  const listeners = { data: new Set(), status: new Set() }
  const send = (id, text) => listeners.data.forEach((cb) => cb(id, encoder.encode(text)))
  const prompt = '\x1b[1;32mdeploy@web-01\x1b[0m:\x1b[1;34m~\x1b[0m$ '
  const replies = {
    'uptime -p': 'up 23 days, 4 hours, 51 minutes',
    ls: '\x1b[1;34mapp\x1b[0m  \x1b[1;34mbackups\x1b[0m  \x1b[1;32mdeploy.sh\x1b[0m  \x1b[1;34mlogs\x1b[0m',
    'systemctl is-active caddy': '\x1b[32mactive\x1b[0m',
    'df -h /':
      'Filesystem  Size  Used Avail Use%\r\n/dev/sda1    78G   29G   49G  38%',
  }
  const lines = {}
  let real
  Object.defineProperty(window, 'termterm', {
    configurable: true,
    get: () => real,
    set(api) {
      real = {
        ...api,
        appInfo: async () => ({
          ...(await api.appInfo()),
          packaged: true,
          capabilities: { ssh: true, keys: true, biometricUnlock: true },
        }),
        deviceUnlockAvailable: async () => true,
        onSshData: (cb) => (listeners.data.add(cb), () => listeners.data.delete(cb)),
        onSshStatus: (cb) => (listeners.status.add(cb), () => listeners.status.delete(cb)),
        sshConnect: async (id) => {
          lines[id] = ''
          setTimeout(() => {
            listeners.status.forEach((cb) => cb(id, { state: 'connected' }))
            send(
              id,
              'Welcome to Ubuntu 24.04.1 LTS\r\n\r\n  System load: 0.08\r\n  Memory usage: 31%\r\n\r\nLast login: Wed Nov 12 08:14:03 2026\r\n' +
                prompt,
            )
          }, 50)
        },
        sshWrite: (id, data) => {
          for (const ch of data) {
            if (ch !== '\r') {
              lines[id] += ch
              send(id, ch)
              continue
            }
            const reply = replies[lines[id].trim()]
            send(id, '\r\n' + (reply ? reply + '\r\n' : '') + prompt)
            lines[id] = ''
          }
        },
        sshResize: () => undefined,
        sshClose: () => undefined,
      }
    },
  })
})

try {
  await page.goto(`http://127.0.0.1:${web.httpServer.address().port}/`)
  await page.getByLabel('Master password', { exact: true }).waitFor()
  await page.evaluate(async () => {
    const api = window.termterm
    await api.createVault('demo master password')
    const hosts = [
      ['web-01', '203.0.113.10', 'deploy', ['production', 'web']],
      ['web-02', '203.0.113.11', 'deploy', ['production', 'web']],
      ['db-primary', '203.0.113.20', 'postgres', ['production', 'database']],
      ['staging', '198.51.100.5', 'ubuntu', ['staging']],
      ['build-runner', '198.51.100.40', 'runner', ['ci']],
      ['homelab-nas', '192.168.1.20', 'admin', ['homelab']],
      ['pi-hole', '192.168.1.2', 'pi', ['homelab']],
    ]
    for (const [label, address, username, tags] of hosts) {
      await api.saveHost(null, {
        label,
        address,
        port: 22,
        username,
        tags,
        keyId: null,
        password: label === 'web-01' ? 'demo' : undefined,
      })
    }
  })
  await page.locator('.card', { hasText: 'pi-hole' }).waitFor()
  await shot('mobile-hosts.png')

  await page.locator('.card', { hasText: 'web-01' }).click()
  await page.getByText('Host details').waitFor()
  await page.getByText('A password is saved.').waitFor()
  await shot('mobile-host.png')

  // A terminal session, with the extra key row phones get.
  await page.locator('.panel-foot').getByRole('button', { name: 'Connect' }).click()
  const rows = page.locator('.pane:not([hidden]) .xterm-rows')
  await rows.getByText('Last login').waitFor()
  await page.locator('.pane:not([hidden]) .xterm-helper-textarea').focus()
  for (const [cmd, expect] of [
    ['uptime -p', 'up 23 days'],
    ['ls', 'deploy.sh'],
    ['systemctl is-active caddy', /^active$/],
    ['df -h /', '/dev/sda1'],
  ]) {
    await page.keyboard.type(cmd)
    await page.keyboard.press('Enter')
    await rows.getByText(expect).first().waitFor()
  }
  await page.getByRole('toolbar', { name: 'Extra keys' }).waitFor()
  await shot('mobile-terminal.png')
  await page.getByRole('button', { name: 'Vault', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click() // the host panel covers the screen

  await nav('Settings').click()
  await page.getByText('Unlock with fingerprint or face').waitFor()
  await shot('mobile-settings.png')
  console.log(`Saved phone screenshots to ${out}`)
} finally {
  await browser.close()
  await new Promise((r) => web.httpServer.close(r))
}
process.exit(0)
