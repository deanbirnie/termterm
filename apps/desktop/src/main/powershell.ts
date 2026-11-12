/**
 * Running a PowerShell script from the main process. Kept free of Electron
 * and of anything that only exists on Windows, so it can be tested anywhere.
 */
import { spawn } from 'node:child_process'

export type ScriptResult =
  | { ok: true; supported?: boolean; signature?: string }
  | { ok: false; status: string; message?: string }

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

/**
 * The script and its arguments as a base64 UTF-16 command for
 * `powershell -EncodedCommand`. Nothing is written to disk, and quoting
 * cannot be broken by what the arguments contain.
 */
export function encodeCommand(script: string, args: Record<string, string>): string {
  const params = Object.entries(args)
    .map(([name, value]) => `-${name} ${quote(value)}`)
    .join(' ')
  return Buffer.from(`& {\n${script}\n} ${params}`, 'utf16le').toString('base64')
}

/** The script reports one line of JSON; anything else is an error. */
export function parseResult(stdout: string): ScriptResult {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return { ok: false, status: 'Error', message: 'No response from Windows' }
  try {
    const result = JSON.parse(line) as ScriptResult
    if (typeof result?.ok === 'boolean') return result
  } catch {
    // fall through
  }
  return { ok: false, status: 'Error', message: line.slice(0, 300) }
}

/** The system's own Windows PowerShell, by full path so nothing on PATH can stand in for it. */
export function powershellPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

export function runPowerShell(
  script: string,
  args: Record<string, string>,
  timeoutMs: number,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const done = (result: ScriptResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodeCommand(script, args),
      ],
      { windowsHide: true },
    )
    const timer = setTimeout(() => {
      child.kill()
      done({ ok: false, status: 'Timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
    child.on('error', (e) => done({ ok: false, status: 'Error', message: e.message }))
    child.on('close', () => {
      const result = parseResult(out)
      if (!result.ok && result.status === 'Error' && !out.trim() && err.trim()) {
        result.message = err.trim().slice(0, 300)
      }
      done(result)
    })
  })
}
