/**
 * Running saved port forwards. Each forward gets its own SSH connection
 * (through the host's jump hosts, with the usual host key checks and
 * prompts), separate from any terminal to the same host.
 */
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client } from 'ssh2'
import type { ForwardState, VaultService } from '@termterm/app'
import { friendlyError, LOST, openConnection, planConnection, type Prompts } from './ssh-connect'
import { serveSocks } from './socks'

interface Running {
  clients: Client[]
  server?: Server
  sockets: Set<Duplex>
  prompts: Set<string>
  stopped: boolean
}

export class ForwardManager {
  private running = new Map<string, Running>()
  private states = new Map<string, ForwardState>()

  constructor(
    private readonly vault: VaultService,
    private readonly prompts: Prompts,
    private readonly onState: (id: string, state: ForwardState) => void,
  ) {}

  all(): Record<string, ForwardState> {
    return Object.fromEntries(this.states)
  }

  private set(id: string, state: ForwardState): void {
    this.states.set(id, state)
    this.onState(id, state)
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  async start(id: string): Promise<void> {
    this.stop(id, false)
    // Forwards are started from the vault on screen (or, at unlock, the one shown last).
    const scope = this.vault.scope()
    const forward = scope.forward(id)
    if (!forward) throw new Error('Port forward not found')
    const f = forward.data
    const hops = planConnection(this.vault, { hostId: f.hostId, vaultId: scope.vaultId })
    const run: Running = { clients: [], sockets: new Set(), prompts: new Set(), stopped: false }
    this.running.set(id, run)
    this.set(id, { state: 'starting' })

    const fail = (error: string) => {
      if (run.stopped) return
      this.shutdown(run)
      if (this.running.get(id) === run) this.running.delete(id)
      this.set(id, { state: 'error', error })
    }
    const counted = (socket: Duplex) => {
      run.sockets.add(socket)
      this.set(id, { state: 'active', connections: run.sockets.size })
      socket.once('close', () => {
        run.sockets.delete(socket)
        if (!run.stopped && this.running.get(id) === run) {
          this.set(id, { state: 'active', connections: run.sockets.size })
        }
      })
    }
    const pipe = (a: Duplex, b: Duplex) => {
      a.on('error', () => b.destroy())
      b.on('error', () => a.destroy())
      a.on('close', () => b.destroy())
      b.on('close', () => a.destroy())
      a.pipe(b).pipe(a)
    }

    let client: Client
    try {
      client = await openConnection(
        scope,
        hops,
        (host, body) => (run.stopped ? Promise.resolve(null) : this.prompts.ask(`forward:${id}`, host, body, run.prompts)),
        (c) => run.clients.push(c),
      )
    } catch (e) {
      fail((e as Error).message)
      return
    }
    if (run.stopped) return void client.end()
    client.on('error', (err) => fail(friendlyError(err)))
    client.on('close', () => fail(LOST))

    // Opens a stream to host:port from the server's side.
    const outFromServer = (socket: Socket | null, host: string, port: number) =>
      new Promise<Duplex>((resolve, reject) =>
        client.forwardOut(socket?.remoteAddress ?? '127.0.0.1', socket?.remotePort ?? 0, host, port, (err, stream) =>
          err ? reject(err) : resolve(stream),
        ),
      )

    const listen = (server: Server) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(f.bindPort, f.bindHost, () => {
          server.off('error', reject)
          resolve()
        })
      })

    try {
      if (f.kind === 'local') {
        run.server = createServer((socket) => {
          counted(socket)
          socket.pause()
          outFromServer(socket, f.destHost!, f.destPort!).then(
            (stream) => {
              pipe(socket, stream)
              socket.resume()
            },
            () => socket.destroy(),
          )
        })
        await listen(run.server)
      } else if (f.kind === 'dynamic') {
        run.server = createServer((socket) => {
          counted(socket)
          serveSocks(socket, (host, port) => outFromServer(socket, host, port))
        })
        await listen(run.server)
      } else {
        await new Promise<void>((resolve, reject) =>
          client.forwardIn(f.bindHost, f.bindPort, (err) => (err ? reject(err) : resolve())),
        )
        client.on('tcp connection', (info, accept, reject) => {
          if (info.destPort !== f.bindPort) return reject()
          const socket = connect(f.destPort!, f.destHost!)
          socket.once('connect', () => {
            const channel = accept()
            counted(channel)
            pipe(channel, socket)
          })
          socket.once('error', () => reject())
        })
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      fail(
        err.code === 'EADDRINUSE'
          ? `Port ${f.bindPort} is already in use on this computer`
          : err.code === 'EACCES'
            ? `Not allowed to listen on port ${f.bindPort} (ports below 1024 need extra rights)`
            : f.kind === 'remote'
              ? `The server refused to listen on ${f.bindHost}:${f.bindPort}: ${err.message}`
              : err.message,
      )
      return
    }
    if (!run.stopped) this.set(id, { state: 'active', connections: 0 })
  }

  stop(id: string, report = true): void {
    const run = this.running.get(id)
    if (run) {
      this.running.delete(id)
      this.shutdown(run)
    }
    if (report && this.states.has(id)) this.set(id, { state: 'stopped' })
  }

  private shutdown(run: Running): void {
    run.stopped = true
    this.prompts.cancel(run.prompts)
    run.server?.close()
    for (const socket of run.sockets) socket.destroy()
    for (const client of run.clients) client.end()
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id)
  }
}
