// Takes the desktop screenshots used in the README (docs/screenshots/).
// Everything shown is made up: a demo vault, documentation-range addresses,
// and a stand-in SSH server with canned output.
//
//   npm run build -w @termterm/desktop
//   xvfb-run -a node apps/desktop/e2e/screenshots.mjs
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')
const { Server, utils } = require('ssh2')

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(appDir, '../../docs/screenshots')
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'termterm-shots-'))
const PASSWORD = 'demo master password'

// ---- a stand-in server ---------------------------------------------------------
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', blue: '\x1b[34m', cyan: '\x1b[36m', yellow: '\x1b[33m' }
const machines = {
  deploy: { name: 'web-01', ip: '203.0.113.10' },
  ubuntu: { name: 'staging', ip: '198.51.100.5' },
}
const prompt = (user) => `${c.bold}${c.green}${user}@${machines[user].name}${c.reset}:${c.bold}${c.blue}~${c.reset}$ `
const motd = (user) =>
  [
    `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)`,
    ``,
    `  System load:  0.08               Processes:             142`,
    `  Usage of /:   37.2% of 77.37GB   Users logged in:       0`,
    `  Memory usage: 31%                IPv4 address for eth0: ${machines[user].ip}`,
    ``,
    `Last login: Wed Nov 12 08:14:03 2026 from 192.0.2.44`,
    ``,
  ].join('\r\n')
const commands = {
  uptime: ` 09:42:17 up 23 days,  4:51,  1 user,  load average: 0.08, 0.12, 0.09`,
  'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"': [
    `${c.bold}NAMES          STATUS          PORTS${c.reset}`,
    `app            Up 6 days       127.0.0.1:3000->3000/tcp`,
    `worker         Up 6 days`,
    `caddy          Up 23 days      0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp`,
    `redis          Up 23 days      6379/tcp`,
  ].join('\r\n'),
  'df -h /': [`Filesystem      Size  Used Avail Use% Mounted on`, `/dev/sda1        78G   29G   49G  38% /`].join('\r\n'),
  'git log --oneline -3': [
    `${c.yellow}4f1c2ab${c.reset} Release 2.4.1`,
    `${c.yellow}9e07d13${c.reset} Cache rendered pages for anonymous users`,
    `${c.yellow}b3a6f50${c.reset} Fix timezone in the weekly report`,
  ].join('\r\n'),
}
function hostKey() {
  for (;;) {
    const key = utils.generateKeyPairSync('ed25519').private
    if (!(utils.parseKey(key) instanceof Error)) return key
  }
}
const sshServer = new Server({ hostKeys: [hostKey()] }, (client) => {
  let user = 'deploy'
  client
    .on('authentication', (ctx) => {
      user = machines[ctx.username] ? ctx.username : 'deploy'
      ctx.method === 'password' ? ctx.accept() : ctx.reject(['password'])
    })
    .on('ready', () =>
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (a) => a())
        session.on('window-change', (a) => a?.())
        session.on('shell', (a) => {
          const stream = a()
          stream.write(motd(user) + prompt(user))
          let line = ''
          stream.on('data', (chunk) => {
            for (const ch of chunk.toString()) {
              if (ch !== '\r') {
                line += ch
                stream.write(ch)
                continue
              }
              const reply = commands[line.trim()]
              stream.write('\r\n' + (reply ? reply + '\r\n' : '') + prompt(user))
              line = ''
            }
          })
        })
      }),
    )
    .on('error', () => {})
})
await new Promise((r) => sshServer.listen(0, '127.0.0.1', r))
const port = sshServer.address().port

// ---- the app -----------------------------------------------------------------
const app = await electron.launch({
  executablePath: require('electron'),
  args: [appDir, '--no-sandbox', '--password-store=basic', '--force-device-scale-factor=2'],
  env: { ...process.env, TERMTERM_DATA_DIR: data, TERMTERM_INSECURE_KEYSTORE: '1', TERMTERM_FAKE_HELLO: '1' },
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
const shot = (name) => page.screenshot({ path: join(out, name) })
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true })

try {
  await page.getByLabel('Master password', { exact: true }).waitFor()
  // Seed the demo vault through the same API the interface uses.
  await page.evaluate(
    async ({ PASSWORD, port }) => {
      const api = window.termterm
      await api.createVault(PASSWORD)
      const deploy = await api.generateKey('deploy key', 'ed25519')
      const homelab = await api.generateKey('homelab', 'ed25519')
      await api.generateKey('legacy-rsa', 'rsa')
      const hosts = [
        { label: 'web-01', address: '127.0.0.1', port, username: 'deploy', tags: ['production', 'web'], keyId: deploy, password: 'x' },
        { label: 'web-02', address: '203.0.113.11', port: 22, username: 'deploy', tags: ['production', 'web'], keyId: deploy },
        { label: 'db-primary', address: '203.0.113.20', port: 22, username: 'postgres', tags: ['production', 'database'], keyId: deploy },
        { label: 'staging', address: '127.0.0.1', port, username: 'ubuntu', tags: ['staging'], keyId: null, password: 'x' },
        { label: 'build-runner', address: '198.51.100.40', port: 22, username: 'runner', tags: ['ci'], keyId: null },
        { label: 'homelab-nas', address: '192.168.1.20', port: 22, username: 'admin', tags: ['homelab'], keyId: homelab },
        { label: 'pi-hole', address: '192.168.1.2', port: 22, username: 'pi', tags: ['homelab'], keyId: homelab },
      ]
      for (const h of hosts) await api.saveHost(null, h)
      await api.saveSnippet(null, { label: 'Disk usage', script: 'df -h /' })
      await api.saveSnippet(null, { label: 'Running containers', script: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"' })
      await api.saveSnippet(null, { label: 'Recent deploys', script: 'git log --oneline -3' })
    },
    { PASSWORD, port },
  )
  await page.locator('.card', { hasText: 'pi-hole' }).waitFor()

  // Hosts, with one open in the details panel.
  await page.locator('.card', { hasText: 'db-primary' }).click()
  await page.getByText('Host details').waitFor()
  await shot('desktop-hosts.png')

  // A terminal session (plus a second tab).
  const open = async (label) => {
    await page.getByRole('button', { name: 'Vault', exact: true }).click()
    await nav('Hosts').click()
    await page.locator('.card', { hasText: label }).dblclick()
    const trust = page.getByRole('button', { name: 'Trust and connect' })
    await trust.waitFor({ timeout: 5000 }).then(() => trust.click(), () => undefined)
    await page.locator('.pane:not([hidden]) .xterm-rows').getByText('Last login').waitFor()
  }
  await open('staging')
  await open('web-01')
  const run = async (cmd, expect) => {
    await page.keyboard.type(cmd)
    await page.keyboard.press('Enter')
    await page.locator('.pane:not([hidden]) .xterm-rows').getByText(expect).waitFor()
  }
  await run('uptime', 'load average')
  await run('docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', 'caddy')
  await run('git log --oneline -3', 'Release 2.4.1')
  await page.getByRole('button', { name: 'Run snippet' }).click()
  await page.getByRole('button', { name: 'Disk usage' }).waitFor()
  await shot('desktop-terminal.png')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Run snippet' }).click()

  // Keychain.
  await page.getByRole('button', { name: 'Vault', exact: true }).click()
  await nav('Keychain').click()
  await page.locator('.card', { hasText: 'deploy key' }).click()
  await page.getByText('SHA256:').waitFor()
  await shot('desktop-keychain.png')

  // The lock screen with Windows Hello turned on (a stand-in Hello).
  await page.evaluate(() => window.termterm.saveSettings({ rememberDevice: true }))
  await page.getByRole('button', { name: 'Lock vault' }).click()
  await page.getByText('Choose how to unlock.').waitFor()
  await shot('desktop-lock.png')
  console.log(`Saved desktop screenshots to ${out}`)
} finally {
  await app.close()
  sshServer.close()
  rmSync(data, { recursive: true, force: true })
}
process.exit(0)
