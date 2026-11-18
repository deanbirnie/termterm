// A real OpenSSH server, for what the JVM test checks against it:
//
//   node openssh.cjs <work dir>     (sshd and ssh-keygen must be installed)
//
// sshd trusts a throwaway CA and nothing else, so only certificates log in.
// Beside it, a SOCKS5 and an HTTP proxy, each wanting "proxy-user" /
// "proxy-pass". Writes <work dir>/openssh.properties (port, user, socksPort,
// httpPort) once everything listens, then runs until killed. The keys are
// files beside it: ed, ed.pub, ed-cert.pub, and the same for rsa and ec.
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const dir = process.argv[2]
const sshd = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find((p) => fs.existsSync(p))
if (!sshd) { console.error('sshd not found'); process.exit(1) }
const user = os.userInfo().username
const keygen = (...args) => execFileSync('ssh-keygen', ['-q', ...args], { cwd: dir })

keygen('-t', 'ed25519', '-N', '', '-f', 'ca', '-C', 'test CA')
keygen('-t', 'ed25519', '-N', '', '-f', 'host_key')
for (const [name, type] of [['ed', 'ed25519'], ['rsa', 'rsa'], ['ec', 'ecdsa']]) {
  keygen('-t', type, ...(type === 'rsa' ? ['-b', '2048'] : []), '-N', '', '-f', name, '-C', name)
  keygen('-s', 'ca', '-I', `${name}-cert`, '-n', user, '-V', 'always:forever', `${name}.pub`)
}

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)))

;(async () => {
  const probe = net.createServer()
  const port = await listen(probe)
  await new Promise((r) => probe.close(r))
  if (process.getuid && process.getuid() === 0) fs.mkdirSync('/run/sshd', { recursive: true })
  fs.writeFileSync(path.join(dir, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${path.join(dir, 'host_key')}`, `PidFile ${path.join(dir, 'sshd.pid')}`,
    'AuthorizedKeysFile /dev/null', `TrustedUserCAKeys ${path.join(dir, 'ca.pub')}`, 'PubkeyAuthentication yes',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'PermitRootLogin yes',
    'AllowAgentForwarding yes', 'AllowTcpForwarding yes', '',
  ].join('\n'))
  const server = spawn(sshd, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'inherit'] })
  process.on('SIGTERM', () => { server.kill(); process.exit(0) })

  const socks = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 2]))
      c.once('data', (auth) => {
        const u = auth.subarray(2, 2 + auth[1]).toString()
        const p = auth.subarray(3 + auth[1], 3 + auth[1] + auth[2 + auth[1]]).toString()
        if (u !== 'proxy-user' || p !== 'proxy-pass') return c.end(Buffer.from([1, 1]))
        c.write(Buffer.from([1, 0]))
        c.once('data', (req) => {
          let host, at
          if (req[3] === 3) { host = req.subarray(5, 5 + req[4]).toString(); at = 5 + req[4] } else { host = Array.from(req.subarray(4, 8)).join('.'); at = 8 }
          const out = net.connect(req.readUInt16BE(at), host, () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(out).pipe(c) })
          out.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])))
        })
      })
    })
    c.on('error', () => {})
  })
  const http = net.createServer((c) => {
    let head = ''
    const onData = (d) => {
      head += d.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      c.off('data', onData)
      const [, host, to] = /^CONNECT ([^:\s]+):(\d+) /.exec(head) || []
      const auth = (/Proxy-Authorization: Basic (\S+)/i.exec(head) || [])[1]
      if (Buffer.from(auth || '', 'base64').toString() !== 'proxy-user:proxy-pass') return c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      const out = net.connect(Number(to), host, () => { c.write('HTTP/1.1 200 Connection established\r\n\r\n'); c.pipe(out).pipe(c) })
    }
    c.on('data', onData)
    c.on('error', () => {})
  })
  const socksPort = await listen(socks)
  const httpPort = await listen(http)
  for (let i = 0; i < 50; i++) {
    const up = await new Promise((ok) => net.connect(port, '127.0.0.1').on('connect', function () { this.destroy(); ok(true) }).on('error', () => ok(false)))
    if (up) break
    await new Promise((r) => setTimeout(r, 100))
  }
  fs.writeFileSync(path.join(dir, 'openssh.properties'), `port=${port}\nuser=${user}\nsocksPort=${socksPort}\nhttpPort=${httpPort}\n`)
})()
