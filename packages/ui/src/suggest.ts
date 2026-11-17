/**
 * Command suggestions while typing in a terminal. The app sees only what is
 * typed, not the shell's own line editing, so `LineTracker` follows the
 * current line from keystrokes and gives up (until the next Enter) whenever
 * the shell might have changed it: Tab completion, arrow keys, history
 * recall. Suggestions are offered only while the line is known.
 */

export class LineTracker {
  /** What has been typed on the current line, when known. */
  line = ''
  /** False once the shell may have changed the line in ways not seen here. */
  known = true

  /**
   * Follows what the terminal sends to the shell. Returns the lines that were
   * entered (Enter pressed on a known line), in order.
   */
  input(data: string): string[] {
    const entered: string[] = []
    let i = 0
    while (i < data.length) {
      const ch = data[i]!
      if (ch === '\x1b') {
        // An escape sequence (arrows, Home, End, Alt+key): the cursor or the line may change.
        this.known = false
        i += escapeLength(data, i)
        continue
      }
      i++
      if (ch === '\r' || ch === '\n') {
        if (this.known && this.line.trim()) entered.push(this.line)
        this.reset()
      } else if (ch === '\x7f' || ch === '\b') {
        this.line = this.line.slice(0, -1)
      } else if (ch === '\x03' || ch === '\x15') {
        // Ctrl+C, Ctrl+U: the line is thrown away.
        this.reset()
      } else if (ch === '\x17') {
        // Ctrl+W: deletes the word before the cursor.
        this.line = this.line.replace(/\S*\s*$/, '')
      } else if (ch === '\x0c') {
        // Ctrl+L redraws the screen and keeps the line.
      } else if (ch < ' ') {
        // Tab, Ctrl+R, Ctrl+A and other editing keys: the line is no longer known.
        this.known = false
      } else {
        this.line += ch
      }
    }
    return entered
  }

  reset(): void {
    this.line = ''
    this.known = true
  }
}

/** How many characters an escape sequence starting at `i` takes. */
function escapeLength(data: string, i: number): number {
  const next = data[i + 1]
  if (next === '[' || next === 'O') {
    let j = i + 2
    while (j < data.length && !/[A-Za-z~]/.test(data[j]!)) j++
    return j - i + 1
  }
  return next === undefined ? 1 : 2
}

export interface Suggestion {
  /** The whole command. */
  text: string
  from: 'history' | 'snippet'
}

/**
 * Commands that start with what has been typed: from this host's history,
 * most recent first, then single-line snippets. Nothing for fewer than two
 * characters, or for a line starting with a space.
 */
export function suggest(
  line: string,
  history: string[],
  snippets: { script: string }[],
  max = 5,
): Suggestion[] {
  if (line.length < 2 || line.startsWith(' ')) return []
  const out: Suggestion[] = []
  const seen = new Set<string>([line])
  const add = (text: string, from: Suggestion['from']) => {
    if (out.length < max && text.startsWith(line) && !seen.has(text)) {
      seen.add(text)
      out.push({ text, from })
    }
  }
  for (let i = history.length - 1; i >= 0; i--) add(history[i]!, 'history')
  for (const s of snippets) {
    const script = s.script.trim()
    if (!script.includes('\n')) add(script, 'snippet')
  }
  return out
}

/**
 * Whether the line the terminal shows at the cursor ends with what was typed:
 * true when the shell echoed it. A password typed at a prompt is not echoed,
 * so it is never kept in history.
 */
export function wasEchoed(screenLine: string, typed: string): boolean {
  const shown = screenLine.trimEnd()
  const want = typed.trimEnd()
  return want.length > 0 && shown.endsWith(want)
}
