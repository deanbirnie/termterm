import { ChevronDown, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LocalShell } from '@termterm/app'
import { api } from './api'
import { Button } from './ui'

/**
 * "Terminal": opens a shell on this computer. The arrow beside it lists the
 * other shells installed (PowerShell, Command Prompt, WSL, ...).
 */
export function LocalTerminalButton({ onOpen }: { onOpen: (shell: LocalShell | null, title: string) => void }) {
  const [shells, setShells] = useState<LocalShell[]>([])
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.localShells().then(setShells)
  }, [])

  // Close the menu on a click anywhere else.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])

  const fallback = shells[0]
  return (
    <div className="split-button" ref={root}>
      <Button
        title={fallback ? `Open ${fallback.name} on this computer (Ctrl+Shift+T)` : undefined}
        onClick={() => onOpen(null, fallback?.name ?? 'Terminal')}
      >
        <SquareTerminal size={15} /> Terminal
      </Button>
      {shells.length > 1 && (
        <Button aria-label="Choose a shell" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronDown size={15} />
        </Button>
      )}
      {open && (
        <ul className="menu" role="menu">
          {shells.map((shell, i) => (
            <li key={shell.id}>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onOpen(shell, shell.name)
                }}
              >
                {shell.name}
                {i === 0 && <span className="muted"> default</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
