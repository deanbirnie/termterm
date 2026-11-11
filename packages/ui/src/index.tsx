import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

/**
 * Renders the termterm interface into `root`. The host app must have put its
 * implementation of the `TermtermApi` contract on `window.termterm` first.
 */
export function mount(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
