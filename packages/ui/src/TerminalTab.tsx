import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Braces, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SessionStatus, SnippetView } from '@termterm/app'
import { api, errorMessage } from './api'
import type { SessionTab } from './App'
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

export function TerminalTab({
  tab,
  active,
  snippets,
  onClose,
}: {
  tab: SessionTab
  active: boolean
  snippets: SnippetView[]
  onClose: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<SessionStatus>({ state: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  const [snippetsOpen, setSnippetsOpen] = useState(false)

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13.5,
      scrollback: 10_000,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    termRef.current = term
    fitRef.current = fit

    // Ctrl+Shift+C / Ctrl+Shift+V, leaving plain Ctrl+C for the remote shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true
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
      term.onData((data) => api.sshWrite(tab.id, data)),
      term.onResize(({ cols, rows }) => api.sshResize(tab.id, cols, rows)),
    ]
    const off = [
      api.onSshData((id, data) => id === tab.id && term.write(data)),
      api.onSshStatus((id, s) => id === tab.id && setStatus(s)),
    ]
    const observer = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent) fit.fit()
    })
    observer.observe(hostRef.current!)

    return () => {
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
    api.sshConnect(tab.id, tab.target, term.cols, term.rows).catch((e) =>
      setStatus({ state: 'closed', error: errorMessage(e) }),
    )
  }, [tab.id, tab.target, attempt])

  useEffect(() => {
    if (!active) return
    fitRef.current?.fit()
    termRef.current?.focus()
  }, [active, status.state])

  const runSnippet = (script: string) => {
    api.sshWrite(tab.id, script.replace(/\r?\n/g, '\r').replace(/\r?$/, '\r'))
    setSnippetsOpen(false)
    termRef.current?.focus()
  }

  return (
    <div className="terminal-tab">
      <div className="terminal-host" ref={hostRef} />
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
      {status.state !== 'connected' && (
        <div className={`session-bar ${status.state === 'closed' && status.error ? 'failed' : ''}`} role="status">
          <span>
            {status.state === 'connecting'
              ? `Connecting to ${tab.title}…`
              : status.error
                ? `Disconnected: ${status.error}`
                : 'Session ended'}
          </span>
          {status.state === 'closed' && (
            <span className="session-actions">
              <Button onClick={() => setAttempt((a) => a + 1)}>
                <RotateCw size={14} /> Reconnect
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Close tab
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
