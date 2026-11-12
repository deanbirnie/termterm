/**
 * Which local shells this computer has, for the "Terminal" button.
 *
 * Pure: the file system and environment are passed in, so the Windows rules
 * can be tested on any machine.
 */
import { basename } from 'node:path'

export interface ShellChoice {
  /** Stable id, saved as the user's default. */
  id: string
  name: string
  file: string
  args: string[]
}

export interface ShellEnvironment {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  exists(path: string): boolean
  /** The contents of /etc/shells, or null where there is none. */
  etcShells: string | null
}

/** Shells worth offering from /etc/shells; others there (tmux, rbash, nologin) are not interactive shells. */
const UNIX_SHELLS: Record<string, string> = {
  zsh: 'zsh',
  bash: 'Bash',
  fish: 'fish',
  nu: 'Nushell',
  pwsh: 'PowerShell',
  ksh: 'KornShell',
  tcsh: 'tcsh',
  dash: 'dash',
  sh: 'sh',
}

function windowsShells({ env, exists }: ShellEnvironment): ShellChoice[] {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const shells: ShellChoice[] = []
  const add = (id: string, name: string, candidates: string[], args: string[] = []) => {
    const file = candidates.find((path) => exists(path))
    if (file) shells.push({ id, name, file, args })
  }
  add('pwsh', 'PowerShell', [`${programFiles}\\PowerShell\\7\\pwsh.exe`, `${programFiles}\\PowerShell\\7-preview\\pwsh.exe`], ['-NoLogo'])
  add('powershell', 'Windows PowerShell', [`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`], ['-NoLogo'])
  add('cmd', 'Command Prompt', [env.ComSpec ?? '', `${root}\\System32\\cmd.exe`].filter(Boolean))
  add('wsl', 'WSL', [`${root}\\System32\\wsl.exe`])
  add('git-bash', 'Git Bash', [`${programFiles}\\Git\\bin\\bash.exe`], ['--login', '-i'])
  return shells
}

function unixShells({ platform, env, exists, etcShells }: ShellEnvironment): ShellChoice[] {
  const listed = (etcShells ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
  const user = env.SHELL
  const shells: ShellChoice[] = []
  const seen = new Set<string>()
  // The user's own shell first, then the rest of /etc/shells in order.
  for (const file of [user, ...listed]) {
    if (!file || !exists(file)) continue
    const command = basename(file)
    const name = UNIX_SHELLS[command]
    if (!name || seen.has(command)) continue // the same shell in /bin and /usr/bin
    seen.add(command)
    // macOS terminals start login shells; Linux ones start interactive shells.
    shells.push({ id: command, name, file, args: platform === 'darwin' ? ['-l'] : [] })
  }
  if (shells.length === 0 && exists('/bin/sh')) shells.push({ id: 'sh', name: 'sh', file: '/bin/sh', args: [] })
  return shells
}

/** The shells on this computer, the system's usual default first. */
export function detectShells(environment: ShellEnvironment): ShellChoice[] {
  return environment.platform === 'win32' ? windowsShells(environment) : unixShells(environment)
}

/** The shell to open: the user's saved choice if it still exists, otherwise the first. */
export function pickShell(shells: ShellChoice[], preferred: string | undefined): ShellChoice | undefined {
  return shells.find((shell) => shell.id === preferred) ?? shells[0]
}
