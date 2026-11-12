// Starts every shell the app would offer on this computer, in a pseudo-terminal
// through node-pty exactly as the app does, and checks each one runs a command.
// Used by CI on Windows, where the shells and node-pty's prebuilt binaries differ
// from Linux.
//
//   node apps/desktop/scripts/check-local-shells.mjs
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { detectShells } from '../src/main/local-shells.ts'

const require = createRequire(import.meta.url)
const { spawn } = require('node-pty')

// What to type in each kind of shell to print a known word.
const probe = {
  pwsh: 'Write-Output ("termterm-" + (6*7)); exit',
  powershell: 'Write-Output ("termterm-" + (6*7)); exit',
  cmd: 'set /a 6*7 >nul & echo termterm-42 & exit',
}
const posix = 'echo termterm-$((6*7)); exit'

// The same detection the app runs (see availableShells in local-terminal.ts).
let etcShells = null
try {
  etcShells = readFileSync('/etc/shells', 'utf8')
} catch {}
const shells = detectShells({ platform: process.platform, env: process.env, exists: existsSync, etcShells })
console.log(`Found: ${shells.map((s) => `${s.name} (${s.file})`).join(', ')}`)
if (shells.length === 0) {
  console.log('FAIL no shells found')
  process.exit(1)
}

let failed = false
for (const shell of shells) {
  if (shell.id === 'wsl') {
    console.log('skip WSL: no Linux distribution is installed on CI machines')
    continue
  }
  const ok = await new Promise((resolve) => {
    let out = ''
    const pty = spawn(shell.file, shell.args, { name: 'xterm-256color', cols: 120, rows: 30, env: process.env })
    const timer = setTimeout(() => {
      pty.kill()
      resolve(false)
    }, 30_000)
    pty.onData((data) => {
      out += data
      if (out.includes('termterm-42')) {
        clearTimeout(timer)
        pty.kill()
        resolve(true)
      }
    })
    setTimeout(() => pty.write(`${probe[shell.id] ?? posix}\r`), 1500)
  })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${shell.name}`)
  if (!ok) failed = true
}
process.exit(failed ? 1 : 0)
