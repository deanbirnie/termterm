/**
 * Session logs: what a terminal shows, as plain text for a file.
 *
 * Terminal output is full of control sequences (colours, cursor moves,
 * window titles). A log keeps the text and drops those, so it reads like
 * what was on the screen.
 */

// CSI (colours, cursor), OSC (titles, links), and the short ESC sequences.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const DCS = /\x1b[P^_][^\x1b]*\x1b\\/g
const SHORT = /\x1b[()*+][A-Za-z0-9]|\x1b[=>78DEHMNOZc]/g
// Other control characters, keeping tab and newline.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** Plain text from a stretch of terminal output. */
export function plainText(output: string): string {
  let text = output.replace(OSC, '').replace(DCS, '').replace(CSI, '').replace(SHORT, '')
  text = text.replace(/\r+\n/g, '\n')
  // A carriage return on its own redraws the line (progress bars): keep what was drawn last.
  text = text
    .split('\n')
    .map((line) => {
      const parts = line.split('\r')
      return parts.length > 1 ? parts.filter((p) => p !== '').at(-1) ?? '' : line
    })
    .join('\n')
  // Backspace removes the character before it.
  while (/[^\n\x08]\x08/.test(text)) text = text.replace(/[^\n\x08]\x08/g, '')
  return text.replace(CONTROL, '')
}

/** Collects a session's output while recording, as plain text. Stops growing at the limit. */
export class SessionRecorder {
  private decoder = new TextDecoder()
  private parts: string[] = []
  private size = 0
  /** Output kept back because it ends inside a control sequence. */
  private pending = ''
  truncated = false
  readonly startedAt = new Date()

  constructor(private readonly limit = 20 * 1024 * 1024) {}

  add(chunk: Uint8Array): void {
    if (this.truncated) return
    let text = this.pending + this.decoder.decode(chunk, { stream: true })
    // Hold back an unfinished escape sequence at the end until the rest arrives.
    const esc = text.lastIndexOf('\x1b')
    if (esc >= 0 && esc > text.length - 64 && !/[@-~\x07]/.test(text.slice(esc + 2))) {
      this.pending = text.slice(esc)
      text = text.slice(0, esc)
    } else {
      this.pending = ''
    }
    const plain = plainText(text)
    if (this.size + plain.length > this.limit) {
      this.truncated = true
      return
    }
    this.parts.push(plain)
    this.size += plain.length
  }

  text(): string {
    return this.parts.join('') + (this.truncated ? '\n[termterm: recording stopped at the size limit]\n' : '')
  }
}

/** A file name for a log: the session's title, what it holds and the time, safe on every system. */
export function logFileName(title: string, kind: 'output' | 'recording', at = new Date()): string {
  const safe = title.replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session'
  const stamp = at.toISOString().replace(/[:T]/g, '-').slice(0, 19)
  return `${safe}-${kind}-${stamp}.log`
}
