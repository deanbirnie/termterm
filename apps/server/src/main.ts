import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createApp } from './app.ts'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'
const dbPath = resolve(process.env.TERMTERM_DB ?? './data/termterm.db')
mkdirSync(dirname(dbPath), { recursive: true })

const { server } = createApp({
  dbPath,
  allowRegistration: process.env.TERMTERM_ALLOW_REGISTRATION !== 'false',
  trustProxy: process.env.TERMTERM_TRUST_PROXY === 'true',
})

server.listen(port, host, () => {
  console.log(`termterm sync server listening on http://${host}:${port} (db: ${dbPath})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
