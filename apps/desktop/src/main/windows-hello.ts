/** Windows Hello through the system's PowerShell (see windows-hello.ps1). */
import { HelloCancelled, HelloKeyMissing, type HelloSigner } from './hello-key-store.ts'
import { runPowerShell, type ScriptResult } from './powershell.ts'
import script from './windows-hello.ps1?raw'

const QUICK = 30_000
/** Long enough for someone to find their finger or type a PIN. */
const PROMPT = 120_000

function check(result: ScriptResult): asserts result is Extract<ScriptResult, { ok: true }> {
  if (result.ok) return
  switch (result.status) {
    case 'UserCanceled':
    case 'UserPrefersPassword':
      throw new HelloCancelled()
    case 'NotFound':
      throw new HelloKeyMissing()
    case 'SecurityDeviceLocked':
      throw new Error('Windows Hello is locked after too many attempts. Use your master password.')
    case 'Timeout':
      throw new Error('Windows Hello did not respond. Use your master password.')
    default:
      throw new Error(
        `Windows Hello failed${result.message ? `: ${result.message}` : ''}. Use your master password.`,
      )
  }
}

export const windowsHelloSigner: HelloSigner = {
  async supported() {
    if (process.platform !== 'win32') return false
    const result = await runPowerShell(script, { Action: 'supported' }, QUICK)
    return result.ok && result.supported === true
  },
  async create() {
    check(await runPowerShell(script, { Action: 'create' }, PROMPT))
  },
  async sign(challenge) {
    const result = await runPowerShell(
      script,
      { Action: 'sign', Challenge: challenge.toString('base64') },
      PROMPT,
    )
    check(result)
    if (!result.signature) throw new Error('Windows Hello returned no signature')
    return Buffer.from(result.signature, 'base64')
  },
  async remove() {
    await runPowerShell(script, { Action: 'delete' }, QUICK)
  },
}
