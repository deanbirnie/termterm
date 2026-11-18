/**
 * Reaching a server through a SOCKS5 or HTTP proxy: a socket to the proxy
 * that, once this resolves, carries the connection to `host:port`. SOCKS
 * passes the host by name, so it is looked up at the proxy's end.
 */
import { connect, type Socket } from 'node:net'
import type { ProxyConfig } from '@termterm/core'

const TIMEOUT_MS = 30_000

const SOCKS_ERRORS: Record<number, string> = {
  1: 'general failure',
  2: 'not allowed by its rules',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'timed out',
  7: 'command not supported',
  8: 'address type not supported',
}

export function connectThroughProxy(proxy: ProxyConfig, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(proxy.port, proxy.host)
    const where = `the proxy at ${proxy.host}:${proxy.port}`
    let received = Buffer.alloc(0)
    let waiting: ((data: Buffer) => boolean) | null = null
    let done = false
    const fail = (message: string) => {
      if (done) return
      done = true
      sock.destroy()
      reject(new Error(message))
    }
    const succeed = () => {
      if (done) return
      done = true
      sock.setTimeout(0)
      sock.removeAllListeners('data')
      sock.removeAllListeners('error')
      sock.removeAllListeners('timeout')
      sock.removeAllListeners('close')
      if (received.length) sock.unshift(received)
      resolve(sock)
    }
    // Hands everything received so far to `handler` until it returns true.
    const expect = (handler: (data: Buffer) => boolean) => {
      waiting = handler
      if (received.length) onData(Buffer.alloc(0))
    }
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      const handler = waiting
      // A handler may set the next one (expect) before returning true: keep that.
      if (handler?.(received) && waiting === handler) waiting = null
    }
    const take = (n: number) => {
      const out = received.subarray(0, n)
      received = received.subarray(n)
      return out
    }

    sock.setTimeout(TIMEOUT_MS)
    sock.on('timeout', () => fail(`No answer from ${where}`))
    sock.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ECONNREFUSED' ? `Could not reach ${where} (connection refused)` : `Could not reach ${where}: ${e.message}`),
    )
    sock.on('close', () => fail(`${where[0]!.toUpperCase()}${where.slice(1)} closed the connection`))
    sock.on('data', onData)

    if (proxy.kind === 'http') {
      sock.once('connect', () => {
        const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
        const auth = proxy.username
          ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
          : ''
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
        expect((data) => {
          const end = data.indexOf('\r\n\r\n')
          if (end < 0) {
            if (data.length > 16 * 1024) fail(`${where} sent an answer that is not HTTP`)
            return false
          }
          const head = take(end + 4).toString('latin1')
          const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)
          if (!status) fail(`${where} sent an answer that is not HTTP`)
          else if (status[1] === '200') succeed()
          else if (status[1] === '407') fail(proxy.username ? `${where} refused the username or password` : `${where} needs a username and password`)
          else fail(`${where} would not connect to ${host}:${port} (HTTP ${status[1]})`)
          return true
        })
      })
      return
    }

    // SOCKS5 (RFC 1928), with username and password (RFC 1929) when given.
    sock.once('connect', () => {
      const methods = proxy.username ? [0x00, 0x02] : [0x00]
      sock.write(Buffer.from([5, methods.length, ...methods]))
      expect((data) => {
        if (data.length < 2) return false
        const [version, method] = take(2)
        if (version !== 5) {
          fail(`${where} is not a SOCKS5 proxy`)
          return true
        }
        if (method === 0x02 && proxy.username) {
          const user = Buffer.from(proxy.username)
          const pass = Buffer.from(proxy.password ?? '')
          sock.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
          expect((reply) => {
            if (reply.length < 2) return false
            if (take(2)[1] !== 0) fail(`${where} refused the username or password`)
            else request()
            return true
          })
        } else if (method === 0x00) {
          request()
        } else {
          fail(proxy.username ? `${where} accepts none of the ways to log in that termterm offers` : `${where} needs a username and password`)
        }
        return true
      })
    })
    const request = () => {
      const name = Buffer.from(host)
      if (name.length > 255) return fail('The host name is too long for SOCKS')
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]))
      expect((data) => {
        if (data.length < 5) return false
        const type = data[3]
        const addressLength = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? 1 + data[4]! : -1
        if (addressLength < 0) {
          fail(`${where} sent an answer that is not SOCKS5`)
          return true
        }
        if (data.length < 4 + addressLength + 2) return false
        const reply = take(4 + addressLength + 2)
        if (reply[1] === 0) succeed()
        else fail(`${where} could not connect to ${host}:${port} (${SOCKS_ERRORS[reply[1]!] ?? `error ${reply[1]}`})`)
        return true
      })
    }
  })
}
