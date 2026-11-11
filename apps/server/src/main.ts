import { dirname, resolve } from 'node:path'
import { createApp } from './app.ts'
import { prepareDataDir } from './privileges.ts'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'
const dbPath = resolve(process.env.TERMTERM_DB ?? './data/termterm.db')

function start() {
  try {
    prepareDataDir(dirname(dbPath))
    return createApp({
      dbPath,
      allowRegistration: process.env.TERMTERM_ALLOW_REGISTRATION !== 'false',
      trustProxy: process.env.TERMTERM_TRUST_PROXY === 'true',
      version: process.env.TERMTERM_VERSION,
    })
  } catch (err) {
    // The usual cause is a data folder this user cannot write to; say so
    // plainly instead of leaving a stack trace in a restart loop.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown'
    console.error(`termterm sync server could not start: ${(err as Error).message}`)
    console.error(
      `Check that ${dirname(dbPath)} exists and is writable by user id ${uid}. ` +
        'In Docker, set PUID and PGID to the owner of the mounted folder.',
    )
    process.exit(1)
  }
}

const { server } = start()

server.listen(port, host, () => {
  console.log(`termterm sync server ${process.env.TERMTERM_VERSION ?? 'dev'} listening on http://${host}:${port} (db: ${dbPath}, user id ${typeof process.getuid === 'function' ? process.getuid() : 'n/a'})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
