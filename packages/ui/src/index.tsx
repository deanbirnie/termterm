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
  // Size the app to the visible area, so that on a phone the layout shrinks
  // when the on-screen keyboard opens instead of sliding underneath it.
  const viewport = window.visualViewport
  if (viewport) {
    const apply = () => document.documentElement.style.setProperty('--app-height', `${viewport.height}px`)
    viewport.addEventListener('resize', apply)
    apply()
  }

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
