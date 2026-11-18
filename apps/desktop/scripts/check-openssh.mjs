// Checks the desktop's certificate login, agent forwarding and proxies
// against a real OpenSSH server (sshd and ssh-keygen must be installed):
//
//   node --experimental-strip-types apps/desktop/scripts/check-openssh.mjs
//
// sshd runs as the current user on a free port, trusting a throwaway CA and
// nothing else, so only certificates log in. The proxies are small ones
// written here, each needing a username and password.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { certificateKey, useCertificates, VaultAgent } from '../src/main/ssh-auth.ts'
import { connectThroughProxy } from '../src/main/proxy.ts'

const { Client } = ssh2
const sshd = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find(existsSync)
if (!sshd) {
  console.error('sshd not found: install openssh-server')
  process.exit(1)
}
const step = (what) => console.log(`  ✓ ${what}`)
const dir = mkdtempSync(join(tmpdir(), 'termterm-openssh-'))
const keygen = (...args) => execFileSync('ssh-keygen', ['-q', ...args], { cwd: dir })
const user = userInfo().username
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) }) })

// ---- a CA, keys and certificates ----
keygen('-t', 'ed25519', '-N', '', '-f', 'ca', '-C', 'test CA')
keygen('-t', 'ed25519', '-N', '', '-f', 'host_key')
for (const [name, type] of [['ed', 'ed25519'], ['rsa', 'rsa'], ['ec', 'ecdsa']]) {
  keygen('-t', type, ...(type === 'rsa' ? ['-b', '2048'] : []), '-N', '', '-f', name, '-C', name)
  keygen('-s', 'ca', '-I', `${name}-cert`, '-n', user, '-V', 'always:forever', `${name}.pub`)
}
keygen('-t', 'ed25519', '-N', '', '-f', 'plain', '-C', 'plain') // no certificate: refused here
const read = (f) => readFileSync(join(dir, f), 'utf8')

// ---- sshd ----
const port = await freePort()
if (process.getuid?.() === 0) mkdirSync('/run/sshd', { recursive: true })
writeFileSync(join(dir, 'sshd_config'), `Port ${port}
ListenAddress 127.0.0.1
HostKey ${join(dir, 'host_key')}
PidFile ${join(dir, 'sshd.pid')}
AuthorizedKeysFile /dev/null
TrustedUserCAKeys ${join(dir, 'ca.pub')}
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PermitRootLogin yes
AllowAgentForwarding yes
AllowTcpForwarding yes
`)
const server = spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] })
let serverLog = ''
server.stderr.on('data', (d) => (serverLog += d))
for (let i = 0; i < 50; i++) {
  if (await new Promise((ok) => connect(port, '127.0.0.1').on('connect', function () { this.destroy(); ok(true) }).on('error', () => ok(false)))) break
  await new Promise((r) => setTimeout(r, 100))
}

// ---- proxies, each wanting "proxy-user" / "proxy-pass" ----
const proxied = []
const socks = createServer((c) => {
  c.once('data', () => {
    c.write(Buffer.from([5, 2])) // username and password, please
    c.once('data', (auth) => {
      const u = auth.subarray(2, 2 + auth[1]).toString()
      const p = auth.subarray(3 + auth[1], 3 + auth[1] + auth[2 + auth[1]]).toString()
      if (u !== 'proxy-user' || p !== 'proxy-pass') return c.end(Buffer.from([1, 1]))
      c.write(Buffer.from([1, 0]))
      c.once('data', (req) => {
        const host = req.subarray(5, 5 + req[4]).toString()
        const to = req.readUInt16BE(5 + req[4])
        proxied.push(`socks ${host}:${to}`)
        const out = connect(to, host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          c.pipe(out).pipe(c)
        }).on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])))
      })
    })
  })
}).listen(0, '127.0.0.1')
const http = createServer((c) => {
  let head = ''
  const onData = (d) => {
    head += d.toString('latin1')
    if (!head.includes('\r\n\r\n')) return
    c.off('data', onData)
    const [, host, to] = /^CONNECT ([^:\s]+):(\d+) /.exec(head) ?? []
    const auth = /Proxy-Authorization: Basic (\S+)/i.exec(head)?.[1]
    if (Buffer.from(auth ?? '', 'base64').toString() !== 'proxy-user:proxy-pass') return c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    proxied.push(`http ${host}:${to}`)
    const out = connect(Number(to), host, () => {
      c.write('HTTP/1.1 200 Connection established\r\n\r\n')
      c.pipe(out).pipe(c)
    })
  }
  c.on('data', onData)
}).listen(0, '127.0.0.1')
await new Promise((r) => setTimeout(r, 100))

// ---- logging in ----
/** Logs in with `key` (over `sock` if given), runs `command`, returns its output. */
function run(key, command, { sock, agent } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () =>
        client.exec(command, agent ? { agentForward: true } : {}, (err, stream) => {
          if (err) return reject(err)
          let out = ''
          stream.on('data', (d) => (out += d)).stderr.on('data', (d) => (out += d))
          stream.on('close', () => {
            client.end()
            resolve(out.trim())
          })
        }),
      )
      .on('error', reject)
      .connect({
        host: '127.0.0.1',
        port,
        username: user,
        ...(sock ? { sock } : {}),
        ...(agent ? { agent } : {}),
        hostVerifier: () => true,
        authHandler: [{ type: 'publickey', username: user, key }],
      })
    useCertificates(client)
  })
}

try {
  for (const name of ['ed', 'rsa', 'ec']) {
    const key = certificateKey(read(name), undefined, read(`${name}-cert.pub`))
    assert.equal(await run(key, 'echo in-as-$USER'), `in-as-${user}`)
  }
  assert.match(serverLog, /Accepted publickey .* ED25519-CERT/)
  assert.match(serverLog, /Accepted publickey .* RSA-CERT/)
  assert.match(serverLog, /Accepted publickey .* ECDSA-CERT/)
  step('ed25519, RSA and ECDSA certificates log in to OpenSSH (which trusts only the CA)')

  assert.throws(() => certificateKey(read('plain'), undefined, read('ed-cert.pub')), /different key/)
  step('a certificate for another key is refused before connecting')

  const agent = new VaultAgent([
    { label: 'ed', privateKey: read('ed'), certificate: read('ed-cert.pub') },
    { label: 'rsa', privateKey: read('rsa'), certificate: read('rsa-cert.pub') },
    { label: 'ec', privateKey: read('ec') },
  ])
  const login = certificateKey(read('ed'), undefined, read('ed-cert.pub'))
  const listed = await run(login, 'ssh-add -L', { agent })
  for (const line of [read('ed.pub'), read('ed-cert.pub'), read('rsa.pub'), read('rsa-cert.pub'), read('ec.pub')]) {
    assert.ok(listed.includes(line.split(' ')[1]), `the forwarded agent lists ${line.split(' ')[0]}`)
  }
  step('the forwarded agent lists the vault keys and certificates (ssh-add -L on the server)')

  // From the server, ssh onward with nothing but the forwarded agent: the
  // server only accepts certificates, so the certificate must sign properly.
  const onward = `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=no -p ${port} ${user}@127.0.0.1 echo onward-ok`
  assert.match(await run(login, onward, { agent }), /onward-ok/)
  step('ssh on the server logs in onward with a certificate through the forwarded agent')

  const rsaOnly = new VaultAgent([{ label: 'rsa', privateKey: read('rsa'), certificate: read('rsa-cert.pub') }])
  assert.match(await run(login, onward, { agent: rsaOnly }), /onward-ok/)
  step('an RSA certificate signs with SHA-2 through the forwarded agent')

  const via = (kind, password = 'proxy-pass') =>
    connectThroughProxy({ kind, host: '127.0.0.1', port: (kind === 'http' ? http : socks).address().port, username: 'proxy-user', password }, '127.0.0.1', port)
  assert.equal(await run(login, 'echo via-socks', { sock: await via('socks5') }), 'via-socks')
  assert.equal(await run(login, 'echo via-http', { sock: await via('http') }), 'via-http')
  assert.deepEqual(proxied, [`socks 127.0.0.1:${port}`, `http 127.0.0.1:${port}`])
  step('logs in through a SOCKS5 and an HTTP proxy, each with a username and password')

  await assert.rejects(via('socks5', 'wrong'), /refused the username or password/)
  await assert.rejects(via('http', 'wrong'), /refused the username or password/)
  await assert.rejects(
    connectThroughProxy({ kind: 'socks5', host: '127.0.0.1', port: await freePort() }, '127.0.0.1', port),
    /connection refused/,
  )
  step('a wrong proxy password, or no proxy there, is reported plainly')
  console.log('\nOpenSSH check passed')
} catch (e) {
  console.error(e)
  console.error(`\nsshd said:\n${serverLog}`)
  process.exitCode = 1
} finally {
  server.kill()
  socks.close()
  http.close()
}
