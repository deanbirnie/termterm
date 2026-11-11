import type { TermtermApi } from '../../shared/api'

declare global {
  interface Window {
    termterm: TermtermApi
  }
}

export const api = window.termterm

/** Electron prefixes IPC errors with "Error invoking remote method ...: Error: ". */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
