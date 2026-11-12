import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { SessionStatus } from '@termterm/app'
import { detectShells, pickShell, type ShellChoice } from './local-shells.ts'

export interface LocalTerminalEvents {
  data(sessionId: string, data: Uint8Array): void
  status(sessionId: string, status: SessionStatus): void
}

/** Variables of this app's own that the user's shell has no use for. */
const PRIVATE_ENV = /^(ELECTRON_|TERMTERM_|CHROME_|VITE_)/

export function availableShells(): ShellChoice[] {
  let etcShells: string | null = null
  try {
    etcShells = readFileSync('/etc/shells', 'utf8')
  } catch {
    // Windows, or no list: fine
  }
  return detectShells({ platform: process.platform, env: process.env, exists: existsSync, etcShells })
}

/**
 * Shells running on this computer, in a pseudo-terminal so programs behave as
 * they do in any terminal window. Reports through the same events as SSH
 * sessions, so the interface treats both alike.
 */
export class LocalTerminals {
  private sessions = new Map<string, IPty>()
  private shells: ShellChoice[] | undefined

  constructor(private readonly events: LocalTerminalEvents) {}

  list(): ShellChoice[] {
    this.shells ??= availableShells()
    return this.shells
  }

  async start(sessionId: string, shellId: string | undefined, cols: number, rows: number): Promise<void> {
    this.close(sessionId)
    const shell = pickShell(this.list(), shellId)
    if (!shell) throw new Error('No shell was found on this computer')

    // Loaded on first use: a native module, only needed once a local terminal is opened.
    const { spawn } = await import('node-pty')
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PRIVATE_ENV.test(key)) env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'

    this.events.status(sessionId, { state: 'connecting' })
    let pty: IPty
    try {
      pty = spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd: homedir(), env })
    } catch (e) {
      this.events.status(sessionId, { state: 'closed', error: `Could not start ${shell.name}: ${(e as Error).message}` })
      return
    }
    this.sessions.set(sessionId, pty)
    this.events.status(sessionId, { state: 'connected' })
    pty.onData((data) => this.events.data(sessionId, Buffer.from(data, 'utf8')))
    pty.onExit(() => {
      // Only report the end of a session the interface did not close itself.
      if (this.sessions.get(sessionId) !== pty) return
      this.sessions.delete(sessionId)
      this.events.status(sessionId, { state: 'closed' })
    })
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    try {
      this.sessions.get(sessionId)?.resize(cols, rows)
    } catch {
      // the shell has just exited
    }
  }

  close(sessionId: string): void {
    const pty = this.sessions.get(sessionId)
    if (!pty) return
    this.sessions.delete(sessionId)
    try {
      pty.kill()
    } catch {
      // already gone
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
