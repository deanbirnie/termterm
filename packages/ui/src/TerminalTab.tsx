import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { Braces, ChevronDown, ChevronUp, FolderOpen, History, RotateCw, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ConnectTarget, SessionStatus, SnippetView } from '@termterm/app'
import { api, errorMessage } from './api'
import { LineTracker, suggest, wasEchoed, type Suggestion } from './suggest'
import type { SessionTab } from './Workspace'
import { defaultFontSize, getTerminalPrefs, onTerminalPrefs, setTerminalPrefs } from './terminal-prefs'
import { Button } from './ui'

const THEME = {
  background: '#0d1117',
  foreground: '#d6deeb',
  cursor: '#5eead4',
  selectionBackground: '#2b4a66',
  black: '#1b2230',
  red: '#f47067',
  green: '#6bd68a',
  yellow: '#e3b341',
  blue: '#6cb6ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#c9d1d9',
  brightBlack: '#6e7681',
  brightRed: '#ff938a',
  brightGreen: '#8ddb8c',
  brightYellow: '#f0c674',
  brightBlue: '#96d0ff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#76e3ea',
  brightWhite: '#f0f6fc',
}

const SEARCH_DECORATIONS = {
  matchBackground: '#2b4a66',
  matchOverviewRuler: '#6cb6ff',
  activeMatchBackground: '#9e6a03',
  activeMatchColorOverviewRuler: '#e3b341',
}

const EXTRA_KEYS = [
  { label: 'Esc', name: 'Escape', send: '\x1b' },
  { label: 'Tab', name: 'Tab', send: '\t' },
  { label: '↑', name: 'Up', send: '\x1b[A' },
  { label: '↓', name: 'Down', send: '\x1b[B' },
  { label: '←', name: 'Left', send: '\x1b[D' },
  { label: '→', name: 'Right', send: '\x1b[C' },
  { label: '/', name: 'Slash', send: '/' },
  { label: '-', name: 'Dash', send: '-' },
  { label: '|', name: 'Pipe', send: '|' },
  { label: '~', name: 'Tilde', send: '~' },
]

/** Seconds before each automatic reconnect attempt; then it stops and offers Reconnect. */
const RECONNECT_DELAYS = [1, 2, 5, 10, 20, 30]
/** Failures retrying cannot fix, or must not retry: a refused host key, a failed or cancelled login. */
const NO_RETRY = /authenticat|host key|cancel|could not be used|cannot use key/i

/** Which host or shell a session's command history belongs to. */
export function historyKey(target: ConnectTarget): string {
  if ('local' in target) return `local:${target.local ?? 'default'}`
  if ('hostId' in target) return `host:${target.hostId}`
  return `ssh:${target.username}@${target.address}:${target.port}`
}

/** Where the suggestion list sits: under the cursor, or above it near the bottom. */
type Placement = { left: number; top?: number; bottom?: number }

export function TerminalTab({
  tab,
  active,
  snippets,
  closeLabel = 'Close tab',
  onClose,
  isShortcut,
  refocus = 0,
  onOpenFiles,
}: {
  tab: SessionTab
  active: boolean
  snippets: SnippetView[]
  closeLabel?: string
  onClose: () => void
  /** Keys the workspace handles (new tab, panes); the terminal ignores them. */
  isShortcut?: (e: KeyboardEvent) => boolean
  /** Changes when the active terminal should take the keyboard back. */
  refocus?: number
  /** Opens this host's files in a new tab, where there is a file browser. */
  onOpenFiles?: () => void
}) {
  const shortcutRef = useRef(isShortcut)
  shortcutRef.current = isShortcut
  const snippetsRef = useRef(snippets)
  snippetsRef.current = snippets
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [status, setStatus] = useState<SessionStatus>({ state: 'connecting' })
  const statusRef = useRef(status)
  statusRef.current = status
  const [attempt, setAttempt] = useState(0)
  const isLocal = 'local' in tab.target
  // On a touch screen there is no Esc, Tab, Ctrl or arrow key: offer them.
  const [touch] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false)
  const changeFontSize = (delta: number) => {
    const current = getTerminalPrefs().fontSize ?? defaultFontSize(touch)
    setTerminalPrefs({ fontSize: current + delta }) // open terminals update through onTerminalPrefs
    termRef.current?.focus()
  }
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  const armCtrl = (on: boolean) => {
    ctrlRef.current = on
    setCtrl(on)
  }
  const [snippetsOpen, setSnippetsOpen] = useState(false)

  // ---- reconnecting after a dropped connection ----
  const wasConnected = useRef(false)
  const retries = useRef(0)
  const [reconnect, setReconnect] = useState<{ attempt: number; at: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // ---- search ----
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  // ---- suggestions ----
  const tracker = useRef(new LineTracker())
  const history = useRef<string[]>([])
  const pending = useRef<string[]>([])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const dismissedFor = useRef<string | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const key = historyKey(tab.target)

  const flushHistory = () => {
    if (flushTimer.current) clearTimeout(flushTimer.current)
    flushTimer.current = null
    const commands = pending.current
    pending.current = []
    if (commands.length) void api.recordCommands(key, commands).catch(() => undefined)
  }

  const place = () => {
    const term = termRef.current
    const root = rootRef.current
    const screen = hostRef.current?.querySelector('.xterm-screen')
    if (!term || !root || !screen) return
    const box = screen.getBoundingClientRect()
    const outer = root.getBoundingClientRect()
    const cellW = box.width / term.cols
    const cellH = box.height / term.rows
    const { cursorX, cursorY } = term.buffer.active
    const left = Math.min(box.left - outer.left + cursorX * cellW, Math.max(0, outer.width - 280))
    const below = box.top - outer.top + (cursorY + 1) * cellH
    setPlacement(
      below + 170 < outer.height
        ? { left, top: below + 2 }
        : { left, bottom: outer.bottom - (box.top + cursorY * cellH) + 2 },
    )
  }

  const refreshSuggestions = () => {
    const t = tracker.current
    const on = getTerminalPrefs().suggestions && statusRef.current.state === 'connected'
    const list =
      on && t.known && dismissedFor.current !== t.line ? suggest(t.line, history.current, snippetsRef.current) : []
    setSuggestions(list)
    setSelected(0)
    if (list.length) place()
  }

  const accept = (s: Suggestion | undefined) => {
    if (!s) return
    const rest = s.text.slice(tracker.current.line.length)
    if (rest) {
      api.sshWrite(tab.id, rest)
      tracker.current.input(rest)
    }
    setSuggestions([])
    termRef.current?.focus()
  }

  /** The text on a buffer row, with any rows it wrapped from above. */
  const screenLineAt = (row: number) => {
    const buffer = termRef.current?.buffer.active
    if (!buffer) return ''
    let y = row
    let text = buffer.getLine(y)?.translateToString(true) ?? ''
    while (y > 0 && buffer.getLine(y)?.isWrapped) {
      y--
      text = (buffer.getLine(y)?.translateToString(true) ?? '') + text
    }
    return text
  }

  /** Follows what is typed for suggestions, and keeps entered commands that the shell echoed. */
  const typed = (data: string) => {
    const buffer = termRef.current?.buffer.active
    const row = buffer ? buffer.baseY + buffer.cursorY : -1
    const entered = tracker.current.input(data)
    // Only the first of several pasted lines was on screen to check.
    const first = entered[0]
    if (first && !first.startsWith(' ') && row >= 0) {
      // The echo of the last keys can still be on its way: look at the line a moment later.
      setTimeout(() => {
        if (!wasEchoed(screenLineAt(row), first)) return
        const command = first.trim()
        history.current = [...history.current.filter((c) => c !== command), command]
        pending.current.push(command)
        if (!flushTimer.current) flushTimer.current = setTimeout(flushHistory, 3000)
        refreshSuggestions() // what is being typed now may match it
      }, 500)
    }
    if (entered.length) dismissedFor.current = null
    refreshSuggestions()
  }

  useEffect(() => {
    const prefs = getTerminalPrefs()
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: prefs.fontSize ?? defaultFontSize(touch),
      lineHeight: prefs.lineHeight,
      scrollback: 10_000,
      theme: THEME,
      allowProposedApi: true, // search highlights use decorations
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(hostRef.current!)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // What is typed here is commands, not prose: ask for it to be left alone.
    // (On Android the keyboard ignores these hints, so the app also switches
    // the keyboard itself while the terminal has focus.)
    const input = term.textarea
    const focused = () => api.terminalFocus(true)
    const blurred = () => api.terminalFocus(false)
    if (input) {
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('autocorrect', 'off')
      input.setAttribute('autocapitalize', 'none')
      input.setAttribute('spellcheck', 'false')
      input.addEventListener('focus', focused)
      input.addEventListener('blur', blurred)
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && shortcutRef.current?.(e)) return false
      if (e.type !== 'keydown') return true
      // While suggestions show: → takes the highlighted one, ↑ ↓ choose, Esc hides them.
      const list = suggestionsRef.current
      if (list.length && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          accept(list[selectedRef.current])
          return false
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          setSelected((i) => (i + step + list.length) % list.length)
          return false
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismissedFor.current = tracker.current.line
          setSuggestions([])
          return false
        }
      }
      // Ctrl+Shift+F (Cmd+F on a Mac) searches; plain Ctrl+F stays with the shell.
      if ((e.ctrlKey && e.shiftKey && e.code === 'KeyF') || (e.metaKey && e.code === 'KeyF')) {
        e.preventDefault()
        openSearch()
        return false
      }
      // Ctrl+Shift+C / Ctrl+Shift+V, leaving plain Ctrl+C for the remote shell.
      if (!e.ctrlKey || !e.shiftKey) return true
      if (e.code === 'KeyC') {
        if (term.hasSelection()) api.clipboardWrite(term.getSelection())
        return false
      }
      if (e.code === 'KeyV') {
        e.preventDefault()
        void api.clipboardRead().then((text) => term.paste(text))
        return false
      }
      return true
    })

    const subscriptions = [
      term.onData((data) => {
        // With Ctrl armed from the key row, the next letter becomes its control character.
        if (ctrlRef.current && data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0)
          if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64)
          armCtrl(false)
        }
        typed(data)
        api.sshWrite(tab.id, data)
      }),
      term.onResize(({ cols, rows }) => api.sshResize(tab.id, cols, rows)),
      // The echo moves the cursor after a key: keep the suggestions beside it.
      term.onCursorMove(() => suggestionsRef.current.length && place()),
      search.onDidChangeResults(({ resultIndex, resultCount }) =>
        setResults({ index: resultIndex, count: resultCount }),
      ),
    ]
    const off = [
      // Text size or row spacing changed, here or in Settings.
      onTerminalPrefs((next) => {
        term.options.fontSize = next.fontSize ?? defaultFontSize(touch)
        term.options.lineHeight = next.lineHeight
        if (hostRef.current?.offsetParent) fit.fit()
        if (!next.suggestions) setSuggestions([])
      }),
      api.onSshData((id, data) => id === tab.id && term.write(data)),
      api.onSshStatus((id, s) => id === tab.id && setStatus(s)),
    ]
    const observer = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent) fit.fit()
    })
    observer.observe(hostRef.current!)

    return () => {
      flushHistory()
      input?.removeEventListener('focus', focused)
      input?.removeEventListener('blur', blurred)
      api.terminalFocus(false)
      observer.disconnect()
      off.forEach((fn) => fn())
      subscriptions.forEach((s) => s.dispose())
      term.dispose()
    }
  }, [tab.id])

  useEffect(() => {
    const term = termRef.current!
    fitRef.current!.fit()
    setStatus({ state: 'connecting' })
    tracker.current.reset()
    setSuggestions([])
    api.sshConnect(tab.id, tab.target, term.cols, term.rows).catch((e) =>
      setStatus({ state: 'closed', error: errorMessage(e) }),
    )
  }, [tab.id, tab.target, attempt])

  // A session that was working and dropped (network gone, laptop asleep,
  // server restarted) reconnects by itself a few times, sooner if the network
  // comes back. Failures a retry cannot fix, and shells that were exited, do not.
  useEffect(() => {
    const term = termRef.current
    if (status.state === 'connected') {
      if (retries.current > 0) term?.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n')
      wasConnected.current = true
      retries.current = 0
      setReconnect(null)
      void api.commandHistory(key).then(
        (h) => (history.current = h),
        () => undefined,
      )
      return
    }
    if (status.state !== 'closed') return
    tracker.current.reset()
    setSuggestions([])
    const error = status.error
    if (!isLocal && wasConnected.current && error && !NO_RETRY.test(error) && retries.current < RECONNECT_DELAYS.length) {
      if (retries.current === 0) term?.write(`\r\n\x1b[2m[${error}: reconnecting]\x1b[0m\r\n`)
      const delay = RECONNECT_DELAYS[retries.current]!
      retries.current++
      setNow(Date.now())
      setReconnect({ attempt: retries.current, at: Date.now() + delay * 1000 })
    } else {
      setReconnect(null)
    }
  }, [status])

  useEffect(() => {
    if (!reconnect) return
    const go = () => {
      setReconnect(null)
      setAttempt((a) => a + 1)
    }
    const timer = setTimeout(go, Math.max(0, reconnect.at - Date.now()))
    const tick = setInterval(() => setNow(Date.now()), 500)
    // Back online, or back from sleep: try straight away.
    const online = () => go()
    const visible = () => document.visibilityState === 'visible' && go()
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(timer)
      clearInterval(tick)
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [reconnect])

  useEffect(() => {
    if (!active) return
    fitRef.current?.fit()
    if (!searchOpen) termRef.current?.focus()
  }, [active, status.state, refocus])

  const reconnectNow = (fresh: boolean) => {
    if (fresh) retries.current = 0
    setReconnect(null)
    setAttempt((a) => a + 1)
  }

  // ---- search ----
  function openSearch() {
    setSearchOpen(true)
    const selection = termRef.current?.getSelection()
    if (selection && !selection.includes('\n')) setQuery(selection)
    setTimeout(() => searchInput.current?.select(), 0)
  }
  const find = (direction: 'next' | 'previous', text = query) => {
    const search = searchRef.current
    if (!search) return
    if (!text) {
      search.clearDecorations()
      setResults(null)
      return
    }
    const options = { decorations: SEARCH_DECORATIONS, incremental: direction === 'next' && text !== query }
    if (direction === 'next') search.findNext(text, options)
    else search.findPrevious(text, options)
  }
  const closeSearch = () => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    termRef.current?.clearSelection()
    setResults(null)
    termRef.current?.focus()
  }

  const runSnippet = (script: string) => {
    api.sshWrite(tab.id, script.replace(/\r?\n/g, '\r').replace(/\r?$/, '\r'))
    setSnippetsOpen(false)
    termRef.current?.focus()
  }

  const sendKey = (sequence: string) => {
    typed(sequence)
    api.sshWrite(tab.id, sequence)
    termRef.current?.focus()
  }

  const secondsLeft = reconnect ? Math.max(0, Math.ceil((reconnect.at - now) / 1000)) : 0
  const lostBecause = status.state === 'closed' && status.error && status.error !== 'Connection lost' ? `Connection lost (${status.error})` : 'Connection lost'

  return (
    <div className="terminal-tab" ref={rootRef}>
      <div className="terminal-host" ref={hostRef} />
      {touch && status.state === 'connected' && (
        // preventDefault on pointer down keeps focus in the terminal, so the
        // on-screen keyboard stays open while these are tapped.
        <div className="key-row" role="toolbar" aria-label="Extra keys" onPointerDown={(e) => e.preventDefault()}>
          {EXTRA_KEYS.map((k) => (
            <button key={k.label} aria-label={k.name} onClick={() => sendKey(k.send)}>
              {k.label}
            </button>
          ))}
          <button aria-pressed={ctrl} className={ctrl ? 'armed' : ''} onClick={() => armCtrl(!ctrl)}>
            Ctrl
          </button>
          <button aria-label="Smaller text" onClick={() => changeFontSize(-1)}>
            A−
          </button>
          <button aria-label="Larger text" onClick={() => changeFontSize(1)}>
            A+
          </button>
        </div>
      )}

      {suggestions.length > 0 && placement && (
        <ul
          className="suggestions"
          role="listbox"
          aria-label="Suggested commands"
          style={placement}
          // Keeps focus (and the phone keyboard) in the terminal while one is tapped.
          onPointerDown={(e) => e.preventDefault()}
        >
          {suggestions.map((s, i) => (
            <li key={s.text} role="option" aria-selected={i === selected}>
              <button className={i === selected ? 'selected' : ''} onClick={() => accept(s)} title={s.text}>
                {s.from === 'history' ? <History size={12} /> : <Braces size={12} />}
                <span>
                  <b>{tracker.current.line}</b>
                  {s.text.slice(tracker.current.line.length)}
                </span>
              </button>
            </li>
          ))}
          {!touch && <li className="suggestions-hint">→ to use · ↑↓ to choose · Esc to hide</li>}
        </ul>
      )}

      {searchOpen ? (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            aria-label="Search the terminal"
            placeholder="Search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              find('next', e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                find(e.shiftKey ? 'previous' : 'next')
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              }
            }}
          />
          <span className="search-count" aria-live="polite">
            {query && results ? (results.count === 0 ? 'No matches' : `${results.index + 1} of ${results.count}`) : ''}
          </span>
          <button className="icon-btn" aria-label="Previous match" title="Previous (Shift+Enter)" onClick={() => find('previous')}>
            <ChevronUp size={15} />
          </button>
          <button className="icon-btn" aria-label="Next match" title="Next (Enter)" onClick={() => find('next')}>
            <ChevronDown size={15} />
          </button>
          <button className="icon-btn" aria-label="Close search" title="Close (Esc)" onClick={closeSearch}>
            <X size={15} />
          </button>
        </div>
      ) : (
        <div className="terminal-tools">
          {onOpenFiles && (
            <button className="icon-btn" title="Browse this host's files" aria-label="Browse files" onClick={onOpenFiles}>
              <FolderOpen size={15} />
            </button>
          )}
          <button
            className="icon-btn"
            title={touch ? 'Search' : 'Search (Ctrl+Shift+F)'}
            aria-label="Search the terminal"
            onClick={openSearch}
          >
            <Search size={15} />
          </button>
          {status.state === 'connected' && snippets.length > 0 && (
            <div className="snippet-menu">
              <button
                className="icon-btn"
                title="Run snippet"
                aria-label="Run snippet"
                aria-expanded={snippetsOpen}
                onClick={() => setSnippetsOpen((o) => !o)}
              >
                <Braces size={15} />
              </button>
              {snippetsOpen && (
                <ul>
                  {snippets.map((s) => (
                    <li key={s.id}>
                      <button onClick={() => runSnippet(s.script)} title={s.script}>
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {status.state !== 'connected' && (
        <div className={`session-bar ${status.state === 'closed' && status.error && !reconnect ? 'failed' : ''}`} role="status">
          <span>
            {reconnect
              ? `${lostBecause}. Reconnecting in ${secondsLeft}s (attempt ${reconnect.attempt} of ${RECONNECT_DELAYS.length})`
              : status.state === 'connecting'
                ? isLocal
                  ? `Starting ${tab.title}…`
                  : retries.current > 0
                    ? `Reconnecting to ${tab.title}…`
                    : `Connecting to ${tab.title}…`
                : status.error
                  ? `Disconnected: ${status.error}`
                  : 'Session ended'}
          </span>
          {(status.state === 'closed' || reconnect) && (
            <span className="session-actions">
              <Button onClick={() => reconnectNow(!reconnect)}>
                <RotateCw size={14} /> {reconnect ? 'Reconnect now' : isLocal ? 'Restart' : 'Reconnect'}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {closeLabel}
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
