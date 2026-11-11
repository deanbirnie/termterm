import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

// Workspace packages are consumed as TypeScript source and bundled in.
const alias = {
  '@termterm/core': resolve(__dirname, '../../packages/core/src/index.ts'),
  '@termterm/app': resolve(__dirname, '../../packages/app/src/index.ts'),
  '@termterm/ui': resolve(__dirname, '../../packages/ui/src/index.tsx'),
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
].join('; ')

/** Production builds get a strict CSP; the dev server needs inline scripts for HMR. */
const csp = (): Plugin => ({
  name: 'termterm-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    ),
})

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    // Sandboxed preload scripts cannot require node_modules: bundle everything.
    build: { externalizeDeps: false },
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), csp()],
  },
})
