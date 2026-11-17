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
  /** Suggest commands from this host's history and from snippets while typing. */
  suggestions: boolean
  /** A TERMINAL_THEMES id. */
  theme: string
  /** A font name, or null for the default list. */
  fontFamily: string | null
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
const SUGGEST_KEY = 'termterm.commandSuggestions'
const THEME_KEY = 'termterm.terminalTheme'
const FONT_FAMILY_KEY = 'termterm.terminalFont'

function storedText(key: string): string | null {
  try {
    const raw = localStorage.getItem(key)
    return raw && raw.length <= 100 ? raw : null
  } catch {
    return null
  }
}
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
    suggestions: stored(SUGGEST_KEY, 0, 1) !== 0,
    theme: storedText(THEME_KEY) ?? 'midnight',
    fontFamily: storedText(FONT_FAMILY_KEY),
  }
}

export function setTerminalPrefs(patch: Partial<TerminalPrefs>): TerminalPrefs {
  try {
    if (patch.fontSize !== undefined) {
      if (patch.fontSize === null) localStorage.removeItem(FONT_KEY)
      else localStorage.setItem(FONT_KEY, String(Math.min(FONT_MAX, Math.max(FONT_MIN, patch.fontSize))))
    }
    if (patch.lineHeight !== undefined) localStorage.setItem(LINE_KEY, String(patch.lineHeight))
    if (patch.suggestions !== undefined) localStorage.setItem(SUGGEST_KEY, patch.suggestions ? '1' : '0')
    if (patch.theme !== undefined) localStorage.setItem(THEME_KEY, patch.theme)
    if (patch.fontFamily !== undefined) {
      if (patch.fontFamily === null || !patch.fontFamily.trim()) localStorage.removeItem(FONT_FAMILY_KEY)
      else localStorage.setItem(FONT_FAMILY_KEY, patch.fontFamily.trim().slice(0, 100))
    }
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
