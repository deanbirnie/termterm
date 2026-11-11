import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = import.meta.dirname
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string
}

// The app talks to whichever sync server the user enters, so connections are
// open; everything else is locked to what ships inside the app.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  'connect-src https: http:',
].join('; ')

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
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    // Workspace packages are consumed as TypeScript source and bundled in.
    alias: {
      '@termterm/core': resolve(root, '../../packages/core/src/index.ts'),
      '@termterm/app': resolve(root, '../../packages/app/src/index.ts'),
      '@termterm/ui': resolve(root, '../../packages/ui/src/index.tsx'),
    },
  },
  plugins: [react(), csp()],
  build: { outDir: 'dist', target: 'es2022' },
})
