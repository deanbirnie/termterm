/**
 * How the terminal looks on this device: text size and the space between
 * rows. Kept in local storage (it is a per-device taste, not vault data) and
 * broadcast so terminals that are already open update at once.
 */

export interface TerminalPrefs {
  /** px, or null for the platform default (smaller on touch screens). */
  fontSize: number | null
  /** Row height as a multiple of the text height. 1 is rows touching. */
  lineHeight: number
}

export const FONT_MIN = 7
export const FONT_MAX = 24
/** Rows 40% taller than the text: easier to read and to tap than xterm's 1.0. */
export const DEFAULT_LINE_HEIGHT = 1.4
export const LINE_HEIGHTS = [
  { value: 1, label: 'Compact' },
  { value: 1.2, label: 'Normal' },
  { value: 1.4, label: 'Comfortable' },
  { value: 1.6, label: 'Spacious' },
]

const FONT_KEY = 'termterm.terminalFontSize'
const LINE_KEY = 'termterm.terminalLineHeight'
const EVENT = 'termterm:terminal-prefs'

function stored(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value >= min && value <= max ? value : null
  } catch {
    return null
  }
}

export function getTerminalPrefs(): TerminalPrefs {
  return {
    fontSize: stored(FONT_KEY, FONT_MIN, FONT_MAX),
    lineHeight: stored(LINE_KEY, 1, 2) ?? DEFAULT_LINE_HEIGHT,
  }
}

export function setTerminalPrefs(patch: Partial<TerminalPrefs>): TerminalPrefs {
  try {
    if (patch.fontSize !== undefined) {
      if (patch.fontSize === null) localStorage.removeItem(FONT_KEY)
      else localStorage.setItem(FONT_KEY, String(Math.min(FONT_MAX, Math.max(FONT_MIN, patch.fontSize))))
    }
    if (patch.lineHeight !== undefined) localStorage.setItem(LINE_KEY, String(patch.lineHeight))
  } catch {
    // Not remembered (storage unavailable), but still applied to open terminals below.
  }
  const prefs = { ...getTerminalPrefs(), ...patch }
  window.dispatchEvent(new CustomEvent<TerminalPrefs>(EVENT, { detail: prefs }))
  return prefs
}

export function onTerminalPrefs(cb: (prefs: TerminalPrefs) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<TerminalPrefs>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** The text size to use when the user has not chosen one. */
export const defaultFontSize = (touch: boolean) => (touch ? 11.5 : 13.5)
