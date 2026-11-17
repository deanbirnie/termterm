/**
 * Terminal colour themes and fonts to choose from (Settings → Terminal).
 * A theme sets the 16 ANSI colours programs use, plus the background, text,
 * cursor and selection. Each is a per-device choice, like the text size.
 */
import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  id: string
  name: string
  theme: ITheme
}

export const TERMINAL_THEMES: TerminalTheme[] = [
  {
    id: 'midnight',
    name: 'Midnight (default)',
    theme: {
      background: '#0d1117', foreground: '#d6deeb', cursor: '#5eead4', selectionBackground: '#2b4a66',
      black: '#1b2230', red: '#f47067', green: '#6bd68a', yellow: '#e3b341', blue: '#6cb6ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#c9d1d9',
      brightBlack: '#6e7681', brightRed: '#ff938a', brightGreen: '#8ddb8c', brightYellow: '#f0c674', brightBlue: '#96d0ff', brightMagenta: '#e2c5ff', brightCyan: '#76e3ea', brightWhite: '#f0f6fc',
    },
  },
  {
    id: 'daylight',
    name: 'Daylight',
    theme: {
      background: '#fbfbf8', foreground: '#24292f', cursor: '#0f766e', selectionBackground: '#b6d7f5',
      black: '#24292f', red: '#c62828', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#0e7c86', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#e5534b', brightGreen: '#2da44e', brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized dark',
    theme: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized light',
    theme: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox dark',
    theme: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'high-contrast',
    name: 'High contrast',
    theme: {
      background: '#000000', foreground: '#ffffff', cursor: '#ffff00', selectionBackground: '#1f5fbf',
      black: '#000000', red: '#ff5c5c', green: '#3cff3c', yellow: '#ffff3c', blue: '#5c9cff', magenta: '#ff5cff', cyan: '#3cffff', white: '#e0e0e0',
      brightBlack: '#a0a0a0', brightRed: '#ff8a8a', brightGreen: '#8aff8a', brightYellow: '#ffff8a', brightBlue: '#8abaff', brightMagenta: '#ff8aff', brightCyan: '#8affff', brightWhite: '#ffffff',
    },
  },
]

export const DEFAULT_THEME = 'midnight'
export const themeById = (id: string | null | undefined): TerminalTheme =>
  TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0]!

/** Used when the chosen font is not installed, and when none is chosen. */
export const FALLBACK_FONTS = '"Cascadia Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace'

/** Common monospaced fonts. Only installed ones take effect; the rest fall back. */
export const FONT_CHOICES = [
  'Cascadia Mono',
  'Cascadia Code',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'Consolas',
  'Menlo',
  'SF Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Roboto Mono',
]

/** The CSS font-family for a chosen font name (null: the default list). */
export function fontStack(font: string | null | undefined): string {
  const name = font?.trim().replace(/["\\]/g, '')
  return name ? `"${name}", ${FALLBACK_FONTS}` : FALLBACK_FONTS
}
