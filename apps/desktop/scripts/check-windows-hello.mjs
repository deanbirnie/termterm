// Runs windows-hello.ps1 the way the app does, on a real Windows machine, for
// the actions that need no person present: "is Hello set up?", and signing and
// deleting when no key exists. This proves the Windows Runtime calls load and
// answer; the prompt itself can only be tried by hand.
//
//   node apps/desktop/scripts/check-windows-hello.mjs     (Windows only; used by CI)
import { readFileSync } from 'node:fs'
import { runPowerShell } from '../src/main/powershell.ts'

const script = readFileSync(new URL('../src/main/windows-hello.ps1', import.meta.url), 'utf8')
let failed = false
const report = (name, result, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(result)}`)
  if (!ok) failed = true
}

const supported = await runPowerShell(script, { Action: 'supported' }, 60_000)
report('supported', supported, supported.ok === true && typeof supported.supported === 'boolean')

const name = `termterm-ci-check-${process.pid}`
const sign = await runPowerShell(
  script,
  { Action: 'sign', Challenge: Buffer.alloc(32, 7).toString('base64'), Name: name },
  60_000,
)
// No key by that name exists, so Windows must say so (and must not prompt).
report('sign without a key', sign, sign.ok === false && !['Error', 'Timeout'].includes(sign.status))

// Signing hands the challenge to Windows and the signature back as Windows
// Runtime buffers; these must survive the trip intact (a real signature cannot
// be made here, so the same conversions are run on a sample).
const sample = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
const buffers = await runPowerShell(
  script,
  { Action: 'buffers', Challenge: sample.toString('base64') },
  60_000,
)
report(
  'buffer conversions',
  { ok: buffers.ok, length: buffers.length, status: buffers.status, message: buffers.message },
  buffers.ok === true && buffers.length === 256 && buffers.signature === sample.toString('base64'),
)

const remove = await runPowerShell(script, { Action: 'delete', Name: name }, 60_000)
report('delete', remove, remove.ok === true)

process.exit(failed ? 1 : 0)
