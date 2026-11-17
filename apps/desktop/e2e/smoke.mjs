// End-to-end smoke test: drives the built app against a throwaway SSH server
// and sync server, covering vault creation, sync to a second device, host key
// trust, and a live terminal session.
//
//   npm run e2e            (Linux without a display: xvfb-run -a npm run e2e)
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import fs from 'node:fs'
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
// The test box's files over SFTP: a folder standing in for the server's disk.
const sftpRoot = join(mkdtempSync(join(tmpdir(), 'termterm-sftp-')))
mkdirSync(join(sftpRoot, 'home/tester/logs'), { recursive: true })
writeFileSync(join(sftpRoot, 'home/tester/notes.txt'), 'remote notes\n')
writeFileSync(join(sftpRoot, 'home/tester/logs/app.log'), 'started\n')
function serveSftp(sftp) {
  const { STATUS_CODE: S, flagsToString } = utils.sftp
  const remotePath = (p) => posix.normalize(p.startsWith('/') ? p : `/home/tester/${p}`)
  const onDisk = (p) => join(sftpRoot, remotePath(p))
  const handles = new Map()
  let nextHandle = 0
  const handle = (value) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(nextHandle)
    handles.set(nextHandle++, value)
    return b
  }
  const get = (h) => handles.get(h.readUInt32BE(0))
  const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 })
  const fail = (id, e) => sftp.status(id, e?.code === 'ENOENT' ? S.NO_SUCH_FILE : S.FAILURE, e?.message)
  const ok = (id, fn) => {
    try {
      fn()
      sftp.status(id, S.OK)
    } catch (e) {
      fail(id, e)
    }
  }
  sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: remotePath(p), longname: remotePath(p), attrs: {} }]))
  sftp.on('STAT', (id, p) => { try { sftp.attrs(id, attrs(fs.statSync(onDisk(p)))) } catch (e) { fail(id, e) } })
  sftp.on('LSTAT', (id, p) => { try { sftp.attrs(id, attrs(fs.lstatSync(onDisk(p)))) } catch (e) { fail(id, e) } })
  sftp.on('FSTAT', (id, h) => { try { sftp.attrs(id, attrs(fs.fstatSync(get(h).fd))) } catch (e) { fail(id, e) } })
  sftp.on('OPENDIR', (id, p) => { try { sftp.handle(id, handle({ dir: onDisk(p), names: fs.readdirSync(onDisk(p)) })) } catch (e) { fail(id, e) } })
  sftp.on('READDIR', (id, h) => {
    const d = get(h)
    if (!d || d.done) return sftp.status(id, S.EOF)
    d.done = true
    sftp.name(id, d.names.map((n) => ({ filename: n, longname: n, attrs: attrs(fs.lstatSync(join(d.dir, n))) })))
  })
  sftp.on('OPEN', (id, p, flags) => { try { sftp.handle(id, handle({ fd: fs.openSync(onDisk(p), flagsToString(flags)) })) } catch (e) { fail(id, e) } })
  sftp.on('READ', (id, h, offset, length) => {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(get(h).fd, buf, 0, length, offset)
    n ? sftp.data(id, buf.subarray(0, n)) : sftp.status(id, S.EOF)
  })
  sftp.on('WRITE', (id, h, offset, data) => ok(id, () => fs.writeSync(get(h).fd, data, 0, data.length, offset)))
  sftp.on('CLOSE', (id, h) => ok(id, () => {
    const v = get(h)
    if (v?.fd !== undefined) fs.closeSync(v.fd)
    handles.delete(h.readUInt32BE(0))
  }))
  sftp.on('MKDIR', (id, p) => ok(id, () => fs.mkdirSync(onDisk(p))))
  sftp.on('RMDIR', (id, p) => ok(id, () => fs.rmdirSync(onDisk(p))))
  sftp.on('REMOVE', (id, p) => ok(id, () => fs.unlinkSync(onDisk(p))))
  sftp.on('RENAME', (id, a, b) => ok(id, () => fs.renameSync(onDisk(a), onDisk(b))))
  sftp.on('SETSTAT', (id) => sftp.status(id, S.OK))
  sftp.on('FSETSTAT', (id) => sftp.status(id, S.OK))
}

const sshHostKey = hostKey()
const sshServer = new Server({ hostKeys: [sshHostKey] }, (client) => {
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
      // Like sshd: open TCP connections for the client (jump hosts, local and SOCKS forwards)...
      client.on('tcpip', (accept, reject, info) => {
        const socket = net.connect(info.destPort, info.destIP)
        socket.once('connect', () => {
          const channel = accept()
          socket.pipe(channel).pipe(socket)
        })
        socket.once('error', () => reject())
      })
      // ...and listen on the server for remote forwards.
      const listeners = []
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward') return reject?.()
        const listener = net.createServer((socket) => {
          client.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress, socket.remotePort, (err, channel) => {
            if (err) return socket.destroy()
            socket.pipe(channel).pipe(socket)
          })
        })
        listeners.push(listener)
        listener.listen(info.bindPort, info.bindAddr, () => accept?.(listener.address().port))
      })
      client.on('close', () => listeners.forEach((l) => l.close()))
      client.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (accept) => serveSftp(accept()))
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
                // Like a real server: exit reports a status; drop cuts the connection.
                if (line === 'exit') {
                  stream.exit(0)
                  stream.end()
                }
                if (line === 'drop') client.end()
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

// A fake release feed: version 9.9.9 with a small stand-in "installer".
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import net from 'node:net'
const fakeInstaller = Buffer.from('not a real installer, just bytes to download and verify')
const feedFiles = {
  '/latest-linux.yml': [
    'version: 9.9.9',
    'files:',
    '  - url: termterm-9.9.9-x86_64.AppImage',
    `    sha512: ${createHash('sha512').update(fakeInstaller).digest('base64')}`,
    `    size: ${fakeInstaller.length}`,
    'path: termterm-9.9.9-x86_64.AppImage',
    `sha512: ${createHash('sha512').update(fakeInstaller).digest('base64')}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    '',
  ].join('\n'),
  '/termterm-9.9.9-x86_64.AppImage': fakeInstaller,
  // The GitHub releases list the "New update" card reads its changelog from.
  '/releases': JSON.stringify([
    {
      tag_name: 'v9.9.9',
      html_url: 'https://github.com/deanbirnie/termterm/releases/tag/v9.9.9',
      body: "**Desktop app**\n- Windows: run the installer\n\n## What's Changed\n* Panes can be swapped by @dean in https://github.com/x/pull/9\n\n**Full Changelog**: https://x",
    },
    { tag_name: 'v9.9.10-beta.1', prerelease: true, body: "## What's Changed\n* Not released yet" },
    {
      tag_name: 'v9.8.0',
      html_url: 'https://github.com/deanbirnie/termterm/releases/tag/v9.8.0',
      body: "## What's Changed\n* Faster sync by @dean in https://github.com/x/pull/8",
    },
  ]),
}
const feed = createServer((req, res) => {
  const body = feedFiles[new URL(req.url, 'http://x').pathname]
  if (!body) return res.writeHead(404).end()
  res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body)
})
await new Promise((r) => feed.listen(0, '127.0.0.1', r))
const feedUrl = `http://127.0.0.1:${feed.address().port}`

async function launch(name, extraEnv = {}) {
  const dataDir = join(tmp, name)
  const app = await electron.launch({
    executablePath: require('electron'),
    // The basic password store stands in for a real OS keyring, which CI lacks.
    args: [appDir, '--no-sandbox', '--password-store=basic'],
    env: { ...process.env, TERMTERM_DATA_DIR: dataDir, TERMTERM_INSECURE_KEYSTORE: '1', ...extraEnv },
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
  {
    const confirm = a.page.getByLabel('Confirm master password')
    await a.page.getByRole('button', { name: 'Show password' }).nth(1).click()
    assert.equal(await confirm.getAttribute('type'), 'text')
    assert.equal(await a.page.getByLabel('Master password', { exact: true }).getAttribute('type'), 'password')
    await a.page.getByRole('button', { name: 'Hide password' }).click()
    assert.equal(await confirm.getAttribute('type'), 'password')
    step('each password field can be shown on its own')
  }
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

  // Suggestions: what was typed before (and echoed) comes back while typing.
  const suggestions = a.page.getByRole('listbox', { name: 'Suggested commands' })
  await a.page.keyboard.type('ec')
  await suggestions.getByRole('option', { name: /echo hello/ }).waitFor()
  await shot(a.page, '06b-suggestions')
  await a.page.keyboard.press('ArrowRight')
  assert.equal(await suggestions.count(), 0)
  await a.page.keyboard.press('Enter')
  await assertCount(termA.getByText('you ran: echo hello'), 2)
  await a.page.keyboard.type('zz')
  assert.equal(await suggestions.count(), 0)
  await a.page.keyboard.press('Enter') // (the test server does not handle Backspace)
  await a.page.waitForTimeout(3500) // history is saved a few seconds after typing
  assert.ok(!readFileSync(join(a.dataDir, 'vault.json'), 'utf8').includes('echo hello'), 'history is encrypted')
  step('earlier commands are suggested while typing; → completes one; history is kept encrypted')

  await a.page.keyboard.press('Control+Shift+F')
  const searchBox = a.page.getByRole('textbox', { name: 'Search the terminal' })
  await searchBox.fill('you ran')
  await a.page.locator('.search-count', { hasText: / of / }).waitFor()
  assert.match(await a.page.locator('.search-count').innerText(), /^\d+ of [3-9]$/)
  await searchBox.fill('nowhere-to-be-found')
  await a.page.locator('.search-count', { hasText: 'No matches' }).waitFor()
  await searchBox.press('Escape')
  assert.equal(await searchBox.count(), 0)
  step('Ctrl+Shift+F searches the scrollback and counts matches')

  // The server cuts the connection: the session comes back by itself.
  await a.page.keyboard.type('drop')
  await a.page.keyboard.press('Enter')
  await a.page.getByText(/Connection lost\. Reconnecting in [01]s \(attempt 1 of 6\)/).waitFor()
  await shot(a.page, '06c-reconnecting')
  await termA.getByText('[reconnected]').waitFor({ timeout: 15_000 })
  await a.page.keyboard.type('echo back again')
  await a.page.keyboard.press('Enter')
  await termA.getByText('you ran: echo back again').waitFor()
  step('a dropped connection reconnected by itself')

  // Leaving the shell is not a dropped connection: no reconnect, until asked.
  await a.page.keyboard.type('exit')
  await a.page.keyboard.press('Enter')
  await a.page.getByText('Session ended').waitFor()
  await a.page.waitForTimeout(2000)
  assert.equal(await a.page.getByText(/Reconnecting/).count(), 0)
  await a.page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await assertCount(termA.getByText('Welcome to the test box'), 3)
  step('exiting the shell ends the session without reconnecting; Reconnect brings it back')

  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.locator('.card', { hasText: 'Test box' }).click()
  await a.page.getByLabel('Key', { exact: true }).selectOption({ label: 'deploy key' })
  await a.page.getByRole('button', { name: 'Save and connect' }).click()
  await termA.getByText('Welcome to the test box').waitFor()
  assert.equal(logins.at(-1), 'publickey')
  assert.equal(await a.page.getByRole('dialog').count(), 0)
  step('second tab logged in with the vault key, no trust prompt this time')

  // ---- port forwarding through the test box -----------------------------------------
  {
    const page = a.page
    const loginsBefore = logins.length // each forward logs in on its own; later checks count only sessions
    const freePort = () =>
      new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
          const { port } = probe.address()
          probe.close(() => resolve(port))
        })
      })
    const echo = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)))
    await new Promise((r) => echo.listen(0, '127.0.0.1', r))
    const echoPort = echo.address().port
    /** Connects to a port, optionally does a SOCKS5 CONNECT first, sends "ping", returns the reply. */
    const ping = (port, socksTo) =>
      new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1')
        let got = Buffer.alloc(0)
        let stage = socksTo ? 'greeting' : 'open'
        sock.on('connect', () => (socksTo ? sock.write(Buffer.from([5, 1, 0])) : sock.write('ping')))
        sock.on('data', (d) => {
          got = Buffer.concat([got, d])
          if (stage === 'greeting' && got.length >= 2) {
            const name = Buffer.from(socksTo.host)
            sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([socksTo.port >> 8, socksTo.port & 255])]))
            got = got.subarray(2)
            stage = 'request'
          }
          if (stage === 'request' && got.length >= 10) {
            got = got.subarray(10)
            stage = 'open'
            sock.write('ping')
          }
          if (stage === 'open' && got.toString().includes('echo:ping')) {
            sock.end()
            resolve(got.toString())
          }
        })
        sock.on('error', () => resolve('refused'))
        sock.on('close', () => resolve(got.toString() || 'closed'))
      })
    const [localPort, socksPort, remotePort] = [await freePort(), await freePort(), await freePort()]

    const addForward = async (kind, bindPort, dest) => {
      await page.getByRole('button', { name: 'New port forward' }).click()
      const panel = page.getByRole('complementary', { name: 'Port forward' })
      await panel.getByLabel('Through host').selectOption({ label: 'Test box' })
      await panel.getByLabel('Kind').selectOption(kind)
      await panel.getByLabel('Listening port').fill(String(bindPort))
      if (dest) {
        await panel.getByLabel('Destination host').fill('127.0.0.1')
        await panel.getByLabel('Destination port').fill(String(dest))
      }
      await panel.getByRole('button', { name: 'Save' }).click()
      await panel.getByRole('button', { name: 'Close' }).click()
    }
    await page.getByRole('button', { name: 'Vault', exact: true }).click()
    await page.getByRole('navigation').getByRole('button', { name: 'Forwarding', exact: true }).click()
    await addForward('local', localPort, echoPort)
    await addForward('dynamic', socksPort)
    await addForward('remote', remotePort, echoPort)
    const local = `${localPort} → 127.0.0.1:${echoPort}`
    const socks = `SOCKS on ${socksPort}`
    const remote = `${remotePort} → 127.0.0.1:${echoPort}`
    for (const label of [local, socks, remote]) {
      await page.getByRole('button', { name: `Start ${label}` }).click()
    }
    await assertCount(page.getByText(/^Running · 0 connections$/), 3)
    await shot(page, '11-forwarding')

    assert.match(await ping(localPort), /echo:ping/)
    assert.match(await ping(socksPort, { host: 'localhost', port: echoPort }), /echo:ping/)
    assert.match(await ping(remotePort), /echo:ping/) // the server's port, back to this computer
    step('local, SOCKS and remote port forwards carry traffic through the test box')

    // A connection held open shows in the count; stopping closes the port.
    const held = net.connect(localPort, '127.0.0.1')
    await page.locator('.forward-row', { hasText: local }).getByText('Running · 1 connection', { exact: true }).waitFor()
    held.destroy()
    await page.getByRole('button', { name: `Stop ${local}` }).click()
    await page.getByRole('button', { name: `Start ${local}` }).waitFor()
    assert.equal(await ping(localPort), 'refused')

    // Its port taken by something else: an error, not a silent failure.
    const squatter = net.createServer().listen(localPort, '127.0.0.1')
    await new Promise((r) => squatter.once('listening', r))
    await page.getByRole('button', { name: `Start ${local}` }).click()
    await page.getByText(`Port ${localPort} is already in use on this computer`).waitFor()
    squatter.close()
    for (const label of [socks, remote]) await page.getByRole('button', { name: `Stop ${label}` }).click()
    echo.close()
    logins.splice(loginsBefore)
    await page.getByRole('navigation').getByRole('button', { name: 'Hosts', exact: true }).click()
    step('forwards show their connections, stop cleanly, and report a port already in use')
  }

  // ---- browsing files over SFTP -------------------------------------------------------
  {
    const page = a.page
    const loginsBefore = logins.length // file browsing logs in on its own; later checks count only sessions
    const localDir = join(tmp, 'local-files')
    mkdirSync(join(localDir, 'bundle'), { recursive: true })
    writeFileSync(join(localDir, 'upload-me.txt'), 'from this computer\n')
    writeFileSync(join(localDir, 'bundle/inner.txt'), 'inside a folder\n')
    const remoteHome = join(sftpRoot, 'home/tester')

    await page.locator('.card', { hasText: 'Test box' }).click()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const server = page.getByRole('region', { name: 'Server' })
    const local = page.getByRole('region', { name: 'This computer' })
    const row = (pane, name) => pane.getByRole('option', { name, exact: true })
    await row(server, 'notes.txt').waitFor()
    await row(server, 'logs').waitFor()
    await local.getByLabel('Folder on this computer').fill(localDir)
    await local.getByLabel('Folder on this computer').press('Enter')
    await row(local, 'upload-me.txt').waitFor()
    await shot(page, '12-files')

    await row(local, 'upload-me.txt').click()
    await local.getByRole('button', { name: /Upload/ }).click()
    await row(server, 'upload-me.txt').waitFor()
    assert.equal(readFileSync(join(remoteHome, 'upload-me.txt'), 'utf8'), 'from this computer\n')
    await row(local, 'bundle').dragTo(server.getByRole('listbox', { name: 'Files' }))
    await row(server, 'bundle').waitFor()
    assert.equal(readFileSync(join(remoteHome, 'bundle/inner.txt'), 'utf8'), 'inside a folder\n')
    await row(server, 'notes.txt').click()
    await server.getByRole('button', { name: /Download/ }).click()
    await row(local, 'notes.txt').waitFor()
    assert.equal(readFileSync(join(localDir, 'notes.txt'), 'utf8'), 'remote notes\n')
    step('files upload (by button and by dragging a folder across) and download, contents intact')

    // Copying over something that is already there is refused, not overwritten.
    writeFileSync(join(localDir, 'upload-me.txt'), 'changed here\n')
    await row(local, 'upload-me.txt').click()
    await local.getByRole('button', { name: /Upload/ }).click()
    await page.getByRole('list', { name: 'Transfers' }).getByText('"upload-me.txt" is already there. Rename or delete it first.').waitFor()
    assert.equal(readFileSync(join(remoteHome, 'upload-me.txt'), 'utf8'), 'from this computer\n')

    // Folders: open and go back up; new folder, rename, delete.
    await row(server, 'logs').dblclick()
    await row(server, 'app.log').waitFor()
    await server.getByRole('button', { name: 'Up one folder' }).click()
    await row(server, 'notes.txt').waitFor()
    assert.equal(await server.getByLabel('Folder on the server').inputValue(), '/home/tester')
    await server.getByRole('button', { name: 'New folder' }).click()
    await page.getByRole('dialog', { name: 'New folder' }).getByLabel('Name').fill('made-here')
    await page.getByRole('dialog', { name: 'New folder' }).getByRole('button', { name: 'Create' }).click()
    await row(server, 'made-here').click()
    await server.getByRole('button', { name: 'Rename' }).click()
    await page.getByRole('dialog', { name: 'Rename made-here' }).getByLabel('Name').fill('renamed')
    await page.getByRole('dialog', { name: 'Rename made-here' }).getByRole('button', { name: 'Rename' }).click()
    await row(server, 'renamed').waitFor()
    assert.ok(existsSync(join(remoteHome, 'renamed')))
    await row(server, 'renamed').click()
    await server.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog', { name: 'Delete renamed?' }).getByRole('button', { name: 'Delete' }).click()
    await assertCount(row(server, 'renamed'), 0)
    assert.ok(!existsSync(join(remoteHome, 'renamed')))
    await page.getByRole('button', { name: 'Close Test box' }).last().click()

    // A terminal to a host opens its files too.
    await page.getByRole('tab', { name: /Test box/ }).first().click()
    await page.getByRole('button', { name: 'Browse files' }).click()
    await row(server, 'notes.txt').waitFor()
    await page.getByRole('button', { name: 'Close Test box' }).last().click()
    logins.splice(loginsBefore)
    step('folders open and go back up; new folder, rename and delete work; nothing is overwritten; a terminal opens its host\'s files')
  }

  // ---- a terminal on this computer -------------------------------------------------
  const activeRows = () => a.page.locator('.pane:not([hidden]) .xterm-rows')
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await a.page.waitForTimeout(800) // let the shell print its prompt
  await a.page.keyboard.type('echo local-$((6*7))')
  await a.page.keyboard.press('Enter')
  await activeRows().getByText('local-42').waitFor()
  step('the Terminal button opened a shell on this computer, which ran a command')

  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.getByRole('button', { name: 'Choose a shell' }).click()
  await a.page.getByRole('menuitem', { name: /Bash/ }).waitFor()
  await shot(a.page, '07-shell-menu')
  await a.page.getByRole('menuitem', { name: /^sh$/ }).click()
  await a.page.getByRole('tab', { name: /^sh/ }).waitFor()
  await a.page.waitForTimeout(500)
  await a.page.keyboard.type('echo sh-$((2+2)); exit')
  await a.page.keyboard.press('Enter')
  await a.page.getByText('Session ended').waitFor()
  await a.page.getByRole('button', { name: 'Restart' }).click()
  await a.page.waitForTimeout(500)
  await a.page.keyboard.type('echo again-$((3+3))')
  await a.page.keyboard.press('Enter')
  await activeRows().getByText('again-6').waitFor()
  step('the shell menu opened another shell; it can exit and be restarted')

  // The default shell is a setting; Ctrl+Shift+T opens it.
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click()
  await a.page.getByLabel('Terminal on this computer').selectOption('sh')
  await a.page.waitForTimeout(300)
  await a.page.keyboard.press('Control+Shift+T')
  await assertCount(a.page.getByRole('tab', { name: /^sh/ }), 2)
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click() // the shortcut switched to the new tab
  await a.page.getByLabel('Terminal on this computer').selectOption('')
  for (const name of ['sh', 'sh', 'Bash']) {
    await a.page.getByRole('button', { name: `Close ${name}` }).first().click()
  }
  await a.page.getByRole('navigation').getByRole('button', { name: 'Hosts', exact: true }).click()
  step('a chosen default shell opens with Ctrl+Shift+T')

  // ---- panes: split, move around, resize, zoom, close, move between tabs -----------
  {
    const page = a.page
    const shown = page.locator('.terminal-pane:not([hidden])')
    const run = async (command) => {
      await page.keyboard.type(command)
      await page.keyboard.press('Enter')
    }
    // In screen order: left to right, then top to bottom.
    const boxes = () =>
      shown.evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect().toJSON()).sort((p, q) => p.x - q.x || p.y - q.y),
      )
    const near = (x, y, msg) => assert.ok(Math.abs(x - y) <= 3, `${msg}: ${x} vs ${y}`)

    await page.getByRole('button', { name: 'Vault', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await page.waitForTimeout(800)
    await run('echo pane-$((40+2))-one')
    await shown.first().locator('.xterm-rows').getByText('pane-42-one').waitFor()

    await page.getByRole('button', { name: 'Split right' }).click()
    await assertCount(shown, 2)
    await page.waitForTimeout(800)
    await run('echo pane-$((40+2))-two') // the new pane has the keyboard
    await page.locator('.terminal-pane.focused .xterm-rows').getByText('pane-42-two').waitFor()
    let [left, right] = await boxes()
    near(right.x, left.x + left.width, 'side by side')
    near(left.width, right.width, 'equal widths')
    await shown.first().locator('.xterm-rows').getByText('pane-42-one').waitFor() // not restarted
    step('Split right opened a second shell beside the first, which kept running')

    await page.keyboard.press('Alt+Shift+Minus') // split the focused (right) pane down
    await assertCount(shown, 3)
    await page.getByLabel('3 panes').waitFor()
    const [, top, bottom] = await boxes()
    near(bottom.y, top.y + top.height, 'stacked')
    near(top.x, bottom.x, 'same column')
    await page.keyboard.press('Alt+ArrowLeft')
    await run('echo moved-$((40+2))-left')
    await shown.first().locator('.xterm-rows').getByText('moved-42-left').waitFor()
    step('Alt+Shift+- split a pane down; Alt+arrow keys move between panes')

    const divider = await page.locator('.divider-row').boundingBox()
    // A quarter of the way down: halfway is where the right column's own divider meets it.
    const grabY = divider.y + divider.height / 4
    await page.mouse.move(divider.x + divider.width / 2, grabY)
    await page.mouse.down()
    await page.mouse.move(divider.x + divider.width / 2 + 150, grabY, { steps: 5 })
    await page.mouse.up()
    ;[left] = await boxes()
    near(left.width, divider.x + divider.width / 2 + 150 - left.x, 'dragged divider')
    await page.locator('.divider-row').dblclick({ position: { x: 4, y: 40 } })
    ;[left, right] = await boxes()
    near(left.width, right.width, 'equal again')
    step('dividers resize panes; a double-click makes them equal')

    await page.keyboard.press('Alt+Shift+Z')
    await assertCount(shown, 1)
    await page.keyboard.press('Alt+Shift+Z')
    await assertCount(shown, 3)
    await page.keyboard.press('Control+Shift+W') // closes the focused (left) pane
    await assertCount(shown, 2)
    const [afterClose] = await boxes()
    near(afterClose.y, top.y, 'the right column now fills the tab')
    step('zoom shows one pane and back; Ctrl+Shift+W closes a pane')

    await page.getByRole('button', { name: /^Move .* to a new tab$/ }).first().click()
    await assertCount(page.getByRole('tab', { name: /^Bash/ }), 2)
    await assertCount(shown, 1)
    await page.waitForTimeout(500)
    await run('echo moved-$((40+2))-out')
    await shown.locator('.xterm-rows').getByText('moved-42-out').waitFor()
    step('a pane moved out into a tab of its own')

    // Drag the new tab back onto the right half of the other tab's terminal.
    const tabsList = page.getByRole('tab', { name: /^Bash/ })
    await tabsList.first().click()
    const source = await tabsList.nth(1).boundingBox()
    const target = await shown.first().boundingBox()
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2 + 10, { steps: 3 })
    await page.mouse.move(target.x + target.width - 20, target.y + target.height / 2, { steps: 10 })
    await page.locator('.drop-preview').waitFor()
    await shot(page, '08-pane-drop')
    await page.mouse.up()
    await assertCount(page.getByRole('tab', { name: /^Bash/ }), 1)
    await assertCount(shown, 2)
    ;[left, right] = await boxes()
    near(right.x, left.x + left.width, 'dropped on the right')
    await page.locator('.terminal-pane:not([hidden])').filter({ hasText: 'moved-42-out' }).waitFor()
    await shot(page, '09-panes')
    step('dragging a tab onto a terminal put it beside, still connected')

    await page.getByRole('button', { name: /^Close Bash$/ }).click()
    await assertCount(page.getByRole('tab', { name: /^Bash/ }), 0)
  }

  // ---- importing from ~/.ssh -------------------------------------------------------
  {
    const sshDir = join(tmp, 'dot-ssh')
    mkdirSync(sshDir)
    const usable = utils.generateKeyPairSync('ed25519')
    const locked = utils.generateKeyPairSync('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr', rounds: 16 })
    writeFileSync(join(sshDir, 'deploy_key'), usable.private)
    writeFileSync(join(sshDir, 'locked_key'), locked.private)
    writeFileSync(
      join(sshDir, 'config'),
      [
        'Host imported-box',
        '  HostName 127.0.0.1',
        `  Port ${sshPort}`,
        '  User tester',
        '  IdentityFile deploy_key',
        'Host behind-bastion',
        '  HostName 127.0.0.1',
        `  Port ${sshPort}`,
        '  User tester',
        '  IdentityFile deploy_key',
        '  ProxyJump imported-box',
        'Host locked-box',
        '  HostName 10.9.9.10',
        '  IdentityFile locked_key',
        'Host *',
        '  User fallback',
      ].join('\n'),
    )
    const serverKey = utils.parseKey(sshHostKey).getPublicSSH().toString('base64')
    writeFileSync(join(sshDir, 'known_hosts'), `[127.0.0.1]:${sshPort} ssh-ed25519 ${serverKey}\n|1|hashed=|x= ssh-ed25519 ${serverKey}\n`)

    const c = await launch('device-c', { TERMTERM_SSH_DIR: sshDir })
    await c.page.getByLabel('Master password', { exact: true }).fill(MASTER)
    await c.page.getByLabel('Confirm master password').fill(MASTER)
    await c.page.getByRole('button', { name: 'Create vault' }).click()
    await c.page.getByText('No hosts yet').waitFor()
    await c.page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = c.page.getByRole('dialog', { name: 'Import from SSH config' })
    const found = dialog.getByRole('list', { name: 'Hosts found' })
    await found.getByText('imported-box', { exact: true }).waitFor()
    assert.equal(await found.getByRole('checkbox').count(), 3)
    await assertCount(found.getByText(`tester@127.0.0.1:${sshPort} · key deploy_key`), 2)
    await found.getByText('fallback@10.9.9.10 · key locked_key').waitFor() // User from "Host *"
    assert.equal(await dialog.getByText(/ProxyJump/).count(), 0) // behind-bastion's jump host is in the config
    await dialog.getByText(/1 known_hosts entries are hashed/).waitFor()
    await shot(c.page, '10-import-preview')
    await dialog.getByRole('button', { name: 'Import 3 hosts' }).click()
    const done = c.page.getByRole('dialog', { name: 'Imported' })
    await done.getByText('3 hosts, 1 key and 1 known host key added to your vault.').waitFor()
    await done.getByText(/locked_key$/).waitFor()
    await done.getByRole('button', { name: 'Done' }).click()
    for (const label of ['imported-box', 'behind-bastion', 'locked-box']) {
      await c.page.locator('.card', { hasText: label }).waitFor()
    }
    step('Import read ~/.ssh: hosts (with Host * defaults), their key, and known_hosts; passphrase keys are listed')

    // The imported host logs in with the imported key, and its host key is already trusted.
    const before = authorizedKey
    authorizedKey = usable.public
    await c.page.locator('.card', { hasText: 'imported-box' }).click()
    await c.page.getByRole('button', { name: 'Connect', exact: true }).last().click()
    await c.page.locator('.pane:not([hidden]) .xterm-rows').getByText('Welcome to the test box').waitFor()
    assert.equal(await c.page.getByRole('dialog').count(), 0) // no "Trust this host?"
    assert.equal(logins.pop(), 'publickey') // (taken off: later checks count device A's and B's logins)

    // ProxyJump came across: behind-bastion goes through imported-box, logging in to each with the key.
    await c.page.getByRole('button', { name: 'Vault', exact: true }).click()
    await c.page.locator('.card', { hasText: 'behind-bastion' }).click()
    assert.equal(await c.page.getByLabel('Jump host').locator('option:checked').innerText(), 'imported-box')
    const loginsBefore = logins.length
    await c.page.getByRole('button', { name: 'Connect', exact: true }).last().click()
    await assertCount(c.page.getByRole('tab', { name: /behind-bastion/ }), 1)
    await c.page.locator('.pane:not([hidden]) .xterm-rows').getByText('Welcome to the test box').waitFor()
    assert.deepEqual(logins.splice(loginsBefore), ['publickey', 'publickey']) // the jump host, then the target
    assert.equal(await c.page.getByRole('dialog').count(), 0)
    authorizedKey = before

    // Importing again finds them already there.
    await c.page.getByRole('button', { name: 'Vault', exact: true }).click()
    await c.page.getByRole('button', { name: 'Import', exact: true }).click()
    await dialog.getByText(/already in your vault/).first().waitFor()
    assert.equal(await dialog.getByText(/already in your vault/).count(), 3)
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 0)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await c.app.close()
    step('the imported host connected with its key and no trust prompt; one behind a jump host connected through it; importing again adds nothing')
  }

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

  // ---- turning sync off is not a dead end: sign back in to the same account ----------
  const navB = (name) => b.page.getByRole('navigation').getByRole('button', { name, exact: true })
  await b.page.getByRole('button', { name: 'Turn off sync' }).click()
  await b.page.getByRole('button', { name: 'Stop syncing this device' }).click()
  await b.page.getByRole('tab', { name: 'Sign in to existing account' }).click()
  await b.page.getByLabel('Sync server').fill(syncUrl)
  await b.page.getByLabel('Username').fill('dean')
  await b.page.getByLabel('Master password').fill('definitely wrong')
  await b.page.getByRole('button', { name: 'Sign in and sync' }).click()
  await b.page.getByText('Incorrect username or master password').waitFor()
  await b.page.getByLabel('Master password').fill(MASTER)
  await b.page.getByRole('button', { name: 'Sign in and sync' }).click()
  await b.page.getByText('Up to date').waitFor()
  await navB('Hosts').click()
  await assertCount(b.page.locator('.card'), 1)
  await b.page.locator('.card', { hasText: 'Renamed on B' }).waitFor()
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.getByRole('navigation').getByRole('button', { name: 'Sync', exact: true }).click()
  await a.page.getByRole('button', { name: 'Sync now' }).click()
  await a.page.getByRole('navigation').getByRole('button', { name: 'Hosts', exact: true }).click()
  await assertCount(a.page.locator('.card'), 1)
  step('device B turned sync off and signed back in to the same account, no duplicates')

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
  // Row spacing: 40% by default, adjustable, and applied to sessions already open.
  const rowHeight = () =>
    a.page.evaluate(() => {
      const row = document.querySelector('.xterm-rows > div')
      return row ? parseFloat(getComputedStyle(row).height) : 0
    })
  assert.equal(await a.page.getByLabel('Line spacing').inputValue(), '1.4')
  await a.page.getByRole('tab', { name: /Test box/ }).first().click()
  const comfortable = await rowHeight()
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.getByLabel('Line spacing').selectOption('1')
  await a.page.getByRole('tab', { name: /Test box/ }).first().click()
  const compact = await rowHeight()
  assert.ok(comfortable > compact * 1.25, `rows did not tighten: ${comfortable} -> ${compact}`)
  await a.page.getByRole('button', { name: 'Vault', exact: true }).click()
  await a.page.getByLabel('Line spacing').selectOption('1.4')
  step(`terminal row spacing is adjustable (${comfortable}px default, ${compact}px compact)`)
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

  // ---- version display and the updater -------------------------------------------------
  const appVersion = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
  // (Device A opens unlocked from here on: the stored key was restored above.)
  // On Linux the updater replaces the AppImage it runs from, so give it one.
  const fakeAppImage = join(tmp, 'termterm-current.AppImage')
  writeFileSync(fakeAppImage, 'current version')
  const updateEnv = { TERMTERM_UPDATE_FEED: feedUrl, TERMTERM_RELEASES_API: `${feedUrl}/releases`, APPIMAGE: fakeAppImage }
  const u = await launch('device-a', updateEnv)
  await u.page.getByText(`v${appVersion}`, { exact: true }).waitFor()
  await nav(u.page, 'Settings').click()
  await u.page.getByText(`${appVersion} (development build)`).waitFor()
  assert.equal(
    await u.page.getByRole('link', { name: 'Release notes' }).getAttribute('href'),
    `https://github.com/deanbirnie/termterm/releases/tag/v${appVersion}`,
  )
  // The check runs by itself shortly after launch; the card lists every version since this one.
  const card = u.page.getByRole('dialog', { name: 'New update: version 9.9.9' })
  await card.waitFor({ timeout: 20_000 })
  await card.getByText('Panes can be swapped', { exact: true }).waitFor()
  await card.getByText('Faster sync', { exact: true }).waitFor()
  await card.getByRole('heading', { name: '9.8.0' }).waitFor()
  assert.equal(await card.getByText('Not released yet').count(), 0)
  await u.page.getByText('Version 9.9.9 is available.').waitFor()
  await shot(u.page, '12-update-available')
  await card.getByRole('button', { name: 'Update', exact: true }).click()
  await u.page.getByText('Version 9.9.9 is downloaded.').waitFor()
  await u.page.getByRole('banner').getByRole('button', { name: 'Restart to update' }).waitFor()
  assert.equal(await card.count(), 0)
  await u.app.close()
  step('after launch a New update card listed the changes since this version; Update downloaded it, ready to restart')

  const later = await launch('device-a', updateEnv)
  const again = later.page.getByRole('dialog', { name: 'New update: version 9.9.9' })
  await again.waitFor({ timeout: 20_000 })
  await again.getByRole('button', { name: 'Not now' }).click()
  assert.equal(await again.count(), 0)
  await later.page.getByRole('banner').getByRole('button', { name: 'Update to 9.9.9' }).waitFor()
  await later.app.close()
  const after = await launch('device-a', updateEnv)
  await after.page.getByRole('banner').getByRole('button', { name: 'Update to 9.9.9' }).waitFor({ timeout: 20_000 })
  assert.equal(await after.page.getByRole('dialog', { name: /New update/ }).count(), 0)
  await after.app.close()
  step('Not now hides the card for that version; the title bar still offers it')

  const noFeed = await launch('device-a')
  await nav(noFeed.page, 'Settings').click()
  await noFeed.page.getByText('Updates are only available in installed builds.').waitFor()
  assert.equal(await noFeed.page.getByRole('button', { name: 'Check for updates' }).count(), 0)
  await noFeed.app.close()
  step('a build run from source reports that it cannot update itself')

  // ---- Windows Hello: a choice of Hello or master password on the lock screen ------
  // (A stand-in for Windows Hello; the real one needs a Windows machine with it set up.)
  const fakeHello = { TERMTERM_FAKE_HELLO: '1' }
  const h = await launch('device-a', fakeHello)
  // Hello replaces "open unlocked": the silently usable key is gone, so this launch asks.
  await h.page.getByText('Vault locked').waitFor()
  assert.ok(!existsSync(join(a.dataDir, 'device-key.bin')), 'a silent key survived switching to Hello')
  await h.page.getByLabel('Master password').fill(NEW_MASTER)
  await h.page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await h.page.locator('.card', { hasText: 'Renamed on B' }).waitFor()
  for (let i = 0; i < 100 && !existsSync(join(a.dataDir, 'hello-key.json')); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(existsSync(join(a.dataDir, 'hello-key.json')), 'Windows Hello was not set up after unlocking')
  await nav(h.page, 'Settings').click()
  await h.page.getByText('Unlock with Windows Hello', { exact: true }).waitFor()

  await h.page.getByRole('button', { name: 'Lock vault' }).click()
  await h.page.getByText('Choose how to unlock.').waitFor()
  await assertCount(h.page.getByLabel('Master password'), 0) // nothing happens until the user picks
  await shot(h.page, '13-unlock-choice')
  await h.page.getByRole('button', { name: 'Unlock with Windows Hello' }).click()
  await h.page.getByRole('button', { name: 'Lock vault' }).waitFor()
  step('lock screen offers Windows Hello or the master password; Hello unlocked')

  await h.page.getByRole('button', { name: 'Lock vault' }).click()
  await h.page.getByRole('button', { name: 'Use master password' }).click()
  await h.page.getByLabel('Master password').fill(NEW_MASTER)
  await h.page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await h.page.getByRole('button', { name: 'Lock vault' }).waitFor()
  step('choosing the master password unlocks with it')

  await h.page.getByRole('button', { name: 'Lock vault' }).click()
  writeFileSync(join(a.dataDir, 'fake-hello-cancel'), '')
  await h.page.getByRole('button', { name: 'Unlock with Windows Hello' }).click()
  await h.page.getByRole('button', { name: 'Unlock with Windows Hello' }).waitFor()
  assert.equal(await h.page.getByText('Vault locked').count(), 1)
  assert.equal(await h.page.locator('.error').count(), 0) // a cancel is not an error
  await h.page.getByRole('button', { name: 'Use master password' }).click()
  await h.page.getByRole('button', { name: 'Use Windows Hello instead' }).click()
  await h.page.getByRole('button', { name: 'Lock vault' }).waitFor()
  step('a cancelled Hello prompt leaves both choices; Hello is offered from the password form too')

  // After two weeks without the master password, the lock screen asks for it first.
  await nav(h.page, 'Settings').click()
  await h.page.getByText('does not replace your master password').waitFor()
  await h.page.evaluate(() =>
    localStorage.setItem('termterm.lastPasswordUse', String(Date.now() - 15 * 24 * 60 * 60 * 1000)),
  )
  await h.page.getByRole('button', { name: 'Lock vault' }).click()
  await h.page.getByText('for over 14 days').waitFor()
  await shot(h.page, '14-password-reminder')
  await h.page.getByLabel('Master password').fill(NEW_MASTER)
  await h.page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await h.page.getByRole('button', { name: 'Lock vault' }).click()
  await h.page.getByText('Choose how to unlock.').waitFor() // using it reset the reminder
  await h.page.getByRole('button', { name: 'Unlock with Windows Hello' }).click()
  await h.page.getByRole('button', { name: 'Lock vault' }).waitFor()
  await h.app.close()
  step('Settings warns that Hello does not replace the password; a 14-day reminder asks for it')

  impostor.close()
  console.log('\nE2E smoke test passed')
} finally {
  sync.server.close()
  feed.close()
  sshServer.close()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(sftpRoot, { recursive: true, force: true })
}
process.exit(0)
