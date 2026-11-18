// Throwaway SSH server: password "pw-ok", keyboard-interactive answer "kbd-ok",
// and any public key listed in the file given as argv[2].
const { Server, utils } = require('ssh2')
const fs = require('fs')
function hostKey() { for (;;) { const k = utils.generateKeyPairSync('ed25519').private; if (!(utils.parseKey(k) instanceof Error)) return k } }
const server = new Server({ hostKeys: [hostKey()] }, (client) => {
  client.on('authentication', (ctx) => {
    client.user = ctx.username
    if (ctx.username === 'kbd') {
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive'])
      return ctx.prompt([{ prompt: 'Code: ', echo: true }], 'Second factor', 'Enter the code', (answers) => answers[0] === 'kbd-ok' ? ctx.accept() : ctx.reject(['keyboard-interactive']))
    }
    if (ctx.method === 'password' && ctx.password === 'pw-ok') return ctx.accept()
    if (ctx.method === 'publickey' && fs.existsSync(process.argv[2])) {
      const allowed = utils.parseKey(fs.readFileSync(process.argv[2], 'utf8'))
      if (!(allowed instanceof Error) && ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH()) &&
          (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) return ctx.accept()
    }
    ctx.reject(['publickey', 'password'])
  }).on('ready', () => {
    // tcpip-forward, as for ssh -R: listen on the server, hand connections to the client.
    const listeners = []
    client.on('request', (accept, reject, name, info) => {
      if (name !== 'tcpip-forward') return reject && reject()
      const listener = require('net').createServer((sock) => {
        client.forwardOut(info.bindAddr, info.bindPort, sock.remoteAddress, sock.remotePort, (err, ch) => {
          if (err) return sock.destroy()
          sock.pipe(ch).pipe(sock)
        })
      })
      listeners.push(listener)
      listener.on('error', () => reject && reject())
      listener.listen(info.bindPort, info.bindAddr === 'localhost' ? '127.0.0.1' : info.bindAddr, () => accept && accept(listener.address().port))
    })
    client.on('close', () => listeners.forEach((l) => l.close()))
    // direct-tcpip, as a jump host does: open the connection asked for.
    client.on('tcpip', (accept, reject, info) => {
      const sock = require('net').connect(info.destPort, info.destIP)
      sock.once('connect', () => { const ch = accept(); sock.pipe(ch).pipe(sock) })
      sock.once('error', () => reject())
    })
    client.on('session', (accept) => {
      const s = accept(); let size = ''; const env = []
      s.on('sftp', (a) => serveSftp(a(), process.argv[3]))
      s.on('pty', (a, r, info) => { size = `${info.cols}x${info.rows}`; a && a() })
      s.on('env', (a, r, info) => { env.push(`${info.key}=${info.val}`); a && a() })
      // RFC 4254 says window-change asks for no reply; user "quiet" is a server that never sends one.
      s.on('window-change', (a, r, info) => { size = `${info.cols}x${info.rows}`; if (client.user !== 'quiet') a && a() })
      s.on('shell', (a) => { const st = a(); st.write(`welcome ${size}${env.length ? ' env:' + env.join(',') : ''}\r\n$ `); let line = ''
        st.on('data', (c) => { if (process.env.SSH_TEST_LOG) console.error(`shell input: ${JSON.stringify(c.toString())}`); for (const ch of c.toString()) { if (ch === '\r') { st.write(`\r\nran:${line} size:${size}\r\n$ `); if (line === 'exit') { st.exit(0); st.end() } if (line === 'drop') client.end(); line = '' } else { line += ch } } }) })
    })
  }).on('error', () => {})
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))

// A small SFTP server over a folder (argv[3]); the user's home is /home/dean.
function serveSftp(sftp, root) {
  const path = require('path')
  const { STATUS_CODE: S, flagsToString } = utils.sftp
  const remote = (p) => path.posix.normalize(p.startsWith('/') ? p : `/home/dean/${p}`)
  const disk = (p) => path.join(root, remote(p))
  const handles = new Map(); let next = 0
  const handle = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(next); handles.set(next++, v); return b }
  const get = (h) => handles.get(h.readUInt32BE(0))
  const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 })
  const fail = (id, e) => sftp.status(id, e && e.code === 'ENOENT' ? S.NO_SUCH_FILE : S.FAILURE, e && e.message)
  const ok = (id, fn) => { try { fn(); sftp.status(id, S.OK) } catch (e) { fail(id, e) } }
  sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: remote(p), longname: remote(p), attrs: {} }]))
  sftp.on('STAT', (id, p) => { try { sftp.attrs(id, attrs(fs.statSync(disk(p)))) } catch (e) { fail(id, e) } })
  sftp.on('LSTAT', (id, p) => { try { sftp.attrs(id, attrs(fs.lstatSync(disk(p)))) } catch (e) { fail(id, e) } })
  sftp.on('FSTAT', (id, h) => { try { sftp.attrs(id, attrs(fs.fstatSync(get(h).fd))) } catch (e) { fail(id, e) } })
  sftp.on('OPENDIR', (id, p) => { try { sftp.handle(id, handle({ dir: disk(p), names: fs.readdirSync(disk(p)) })) } catch (e) { fail(id, e) } })
  sftp.on('READDIR', (id, h) => {
    const d = get(h)
    if (!d || d.done) return sftp.status(id, S.EOF)
    d.done = true
    sftp.name(id, d.names.map((n) => ({ filename: n, longname: n, attrs: attrs(fs.lstatSync(path.join(d.dir, n))) })))
  })
  sftp.on('OPEN', (id, p, flags) => { try { sftp.handle(id, handle({ fd: fs.openSync(disk(p), flagsToString(flags)) })) } catch (e) { fail(id, e) } })
  sftp.on('READ', (id, h, offset, length) => {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(get(h).fd, buf, 0, length, offset)
    n ? sftp.data(id, buf.subarray(0, n)) : sftp.status(id, S.EOF)
  })
  sftp.on('WRITE', (id, h, offset, data) => ok(id, () => fs.writeSync(get(h).fd, data, 0, data.length, offset)))
  sftp.on('CLOSE', (id, h) => ok(id, () => { const v = get(h); if (v && v.fd !== undefined) fs.closeSync(v.fd); handles.delete(h.readUInt32BE(0)) }))
  sftp.on('MKDIR', (id, p) => ok(id, () => fs.mkdirSync(disk(p))))
  sftp.on('RMDIR', (id, p) => ok(id, () => fs.rmdirSync(disk(p))))
  sftp.on('REMOVE', (id, p) => ok(id, () => fs.unlinkSync(disk(p))))
  sftp.on('RENAME', (id, a, b) => ok(id, () => fs.renameSync(disk(a), disk(b))))
  sftp.on('SETSTAT', (id, p, a) => { try { if (a.mode !== undefined) fs.chmodSync(disk(p), a.mode & 0o7777); sftp.status(id, S.OK) } catch (e) { sftp.status(id, S.FAILURE, e.message) } })
  sftp.on('FSETSTAT', (id) => sftp.status(id, S.OK))
}
