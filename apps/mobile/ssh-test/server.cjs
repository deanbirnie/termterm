// Throwaway SSH server: password "pw-ok", keyboard-interactive answer "kbd-ok",
// and any public key listed in the file given as argv[2].
const { Server, utils } = require('ssh2')
const fs = require('fs')
function hostKey() { for (;;) { const k = utils.generateKeyPairSync('ed25519').private; if (!(utils.parseKey(k) instanceof Error)) return k } }
const server = new Server({ hostKeys: [hostKey()] }, (client) => {
  client.on('authentication', (ctx) => {
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
    client.on('session', (accept) => {
      const s = accept(); let size = ''
      s.on('pty', (a, r, info) => { size = `${info.cols}x${info.rows}`; a() })
      s.on('window-change', (a, r, info) => { size = `${info.cols}x${info.rows}`; a && a() })
      s.on('shell', (a) => { const st = a(); st.write(`welcome ${size}\r\n$ `); let line = ''
        st.on('data', (c) => { for (const ch of c.toString()) { if (ch === '\r') { st.write(`\r\nran:${line} size:${size}\r\n$ `); if (line === 'exit') st.end(); line = '' } else { line += ch } } }) })
    })
  }).on('error', () => {})
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
