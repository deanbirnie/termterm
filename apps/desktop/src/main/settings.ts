import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings } from '@termterm/app'

const DEFAULTS: Settings = { autoLockMinutes: 15, rememberDevice: false, autoCheckUpdates: true }

/** Device-local preferences. Nothing secret lives here, so it is plain JSON outside the vault. */
export class SettingsStore {
  private current: Settings

  constructor(private readonly path: string) {
    let stored: unknown = {}
    try {
      stored = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // missing or unreadable: fall back to defaults
    }
    this.current = this.clean(stored)
  }

  get(): Settings {
    return { ...this.current }
  }

  /** Applies a partial change; fields not mentioned keep their saved value. */
  save(input: unknown): Settings {
    this.current = this.clean({ ...this.current, ...(input as object) })
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.current, null, 2))
    return this.get()
  }

  private clean(input: unknown): Settings {
    const raw = input as Partial<Settings> | null
    const minutes = Number(raw?.autoLockMinutes)
    return {
      rememberDevice: raw?.rememberDevice === true,
      defaultShell:
        typeof raw?.defaultShell === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.defaultShell)
          ? raw.defaultShell
          : undefined,
      autoCheckUpdates: raw?.autoCheckUpdates !== false,
      autoLockMinutes:
        Number.isFinite(minutes) && minutes >= 0 && minutes <= 24 * 60
          ? Math.floor(minutes)
          : DEFAULTS.autoLockMinutes,
    }
  }
}
