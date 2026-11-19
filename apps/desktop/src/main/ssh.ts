import type { Client, ClientChannel } from 'ssh2'
import type { ConnectTarget, SessionStatus } from '@termterm/app'
import type { VaultService } from '@termterm/app'
import { agentFor, friendlyError, LOST, openConnection, planConnection, vaultIdOf, type Prompts } from './ssh-connect'

interface Session {
  /** Every connection opened for it: jump hosts first, the target last. */
  clients: Client[]
  /** The size the terminal last asked for, kept so one sent while connecting is not lost. */
  size: { cols: number; rows: number }
  stream?: ClientChannel
  prompts: Set<string>
  closed: boolean
  /** The remote shell reported its exit status: it ended rather than being cut off. */
  exited?: boolean
}

export interface SshEvents {
  data(sessionId: string, data: Uint8Array): void
  status(sessionId: string, status: SessionStatus): void
}

/** Terminal sessions: an interactive shell on a saved host or an address. */
export class SshManager {
  private sessions = new Map<string, Session>()

  constructor(
    private readonly vault: VaultService,
    private readonly prompts: Prompts,
    private readonly events: SshEvents,
  ) {}

  connect(sessionId: string, target: ConnectTarget, cols: number, rows: number): void {
    this.close(sessionId)
    // Throws straight away for what the vault cannot supply (missing host, unreadable key).
    const hops = planConnection(this.vault, target)
    const agent = agentFor(this.vault, target)
    if (agent) hops.at(-1)!.agent = agent

    const session: Session = { clients: [], size: { cols, rows }, prompts: new Set(), closed: false }
    this.sessions.set(sessionId, session)

    const finish = (error?: string) => {
      if (session.closed) return
      session.closed = true
      this.prompts.cancel(session.prompts)
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      for (const client of session.clients) client.end()
      this.events.status(sessionId, { state: 'closed', error })
    }

    this.events.status(sessionId, { state: 'connecting' })
    openConnection(
      this.vault.scope(vaultIdOf(target)),
      hops,
      (host, body) => (session.closed ? Promise.resolve(null) : this.prompts.ask(sessionId, host, body, session.prompts)),
      (client) => session.clients.push(client),
    ).then(
      (client) => {
        if (session.closed) return client.end()
        client
          .on('error', (err) => finish(friendlyError(err)))
          // Also reached when a jump host's connection drops.
          .on('close', () => finish(session.stream && !session.exited ? LOST : undefined))
        const opened = session.size
        // Environment variables the host asks for; servers only set those
        // their AcceptEnv allows, and quietly ignore the rest.
        const env = hops.at(-1)?.env
        const open = (forwardAgent: boolean) =>
          client.shell({ term: 'xterm-256color', ...opened }, { ...(env ? { env } : {}), ...(forwardAgent ? { agentForward: true } : {}) }, (err, stream) => {
          // A server that does not allow agent forwarding: carry on without it, as ssh does.
          if (err && forwardAgent && /agent forwarding/i.test(err.message)) {
            this.events.data(sessionId, new TextEncoder().encode('termterm: the server refused agent forwarding; continuing without it.\r\n'))
            return open(false)
          }
          if (err) return finish(err.message)
          session.stream = stream
          // A resize that arrived while the shell was being opened.
          if (session.size !== opened) stream.setWindow(session.size.rows, session.size.cols, 0, 0)
          this.events.status(sessionId, { state: 'connected' })
          const forward = (chunk: Buffer) => this.events.data(sessionId, chunk)
          stream.on('data', forward)
          stream.stderr.on('data', forward)
          // A shell the user left (exit, logout) reports its exit status first;
          // one that just stops was cut off, and the interface reconnects it.
          stream.on('exit', () => (session.exited = true))
          stream.on('close', () => finish(session.exited ? undefined : LOST))
        })
        open(!!agent)
      },
      (err: Error) => finish(err.message),
    )
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.size = { cols, rows }
    session.stream?.setWindow(rows, cols, 0, 0)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.closed = true
    this.prompts.cancel(session.prompts)
    for (const client of session.clients) client.destroy()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
