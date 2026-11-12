import { describe, expect, it } from 'vitest'
import { detectShells, pickShell, type ShellEnvironment } from '../src/main/local-shells.ts'

const windows = (files: string[], env: Record<string, string> = {}): ShellEnvironment => ({
  platform: 'win32',
  env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: 'C:\\Windows\\System32\\cmd.exe', ...env },
  exists: (path) => files.includes(path),
  etcShells: null,
})

describe('local shells on Windows', () => {
  it('offers what is installed, PowerShell 7 first', () => {
    const shells = detectShells(
      windows([
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\System32\\cmd.exe',
        'C:\\Windows\\System32\\wsl.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
      ]),
    )
    expect(shells.map((s) => s.name)).toEqual(['PowerShell', 'Windows PowerShell', 'Command Prompt', 'WSL', 'Git Bash'])
    expect(shells.find((s) => s.id === 'git-bash')?.args).toEqual(['--login', '-i'])
  })

  it('falls back to Windows PowerShell and leaves out what is missing', () => {
    const shells = detectShells(
      windows(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\cmd.exe']),
    )
    expect(shells.map((s) => s.id)).toEqual(['powershell', 'cmd'])
    expect(pickShell(shells, undefined)?.id).toBe('powershell')
    expect(pickShell(shells, 'cmd')?.id).toBe('cmd')
    expect(pickShell(shells, 'pwsh')?.id).toBe('powershell') // a saved choice that was uninstalled
  })
})

describe('local shells on macOS and Linux', () => {
  const unix = (platform: NodeJS.Platform, shell: string, etcShells: string, files: string[]): ShellEnvironment => ({
    platform,
    env: { SHELL: shell },
    exists: (path) => files.includes(path),
    etcShells,
  })

  it('puts the user shell first, skips non-shells and duplicates', () => {
    const shells = detectShells(
      unix(
        'linux',
        '/usr/bin/zsh',
        '# comment\n/bin/sh\n/usr/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/rbash\n/usr/bin/tmux\n/usr/bin/zsh\n',
        ['/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/rbash', '/usr/bin/tmux', '/usr/bin/zsh'],
      ),
    )
    expect(shells.map((s) => s.name)).toEqual(['zsh', 'sh', 'Bash'])
    expect(shells.every((s) => s.args.length === 0)).toBe(true)
  })

  it('starts login shells on macOS', () => {
    const shells = detectShells(unix('darwin', '/bin/zsh', '/bin/zsh\n/bin/bash\n', ['/bin/zsh', '/bin/bash']))
    expect(shells.map((s) => s.id)).toEqual(['zsh', 'bash'])
    expect(shells[0]?.args).toEqual(['-l'])
  })

  it('still offers sh when nothing is listed', () => {
    expect(detectShells(unix('linux', '', '', ['/bin/sh'])).map((s) => s.id)).toEqual(['sh'])
  })
})
