import type { TermtermApi } from '@termterm/app'

declare global {
  interface Window {
    termterm: TermtermApi
  }
}

/**
 * The host app's implementation of the contract. Looked up on each use, so
 * it does not matter whether the host sets `window.termterm` before or after
 * this module loads.
 */
export const api = new Proxy({} as TermtermApi, {
  get: (_target, name) => window.termterm[name as keyof TermtermApi],
})

/** Electron prefixes IPC errors with "Error invoking remote method ...: Error: ". */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
