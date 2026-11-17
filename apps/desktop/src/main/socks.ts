/**
 * The SOCKS5 side of a dynamic port forward (ssh -D): reads a client's
 * CONNECT request and hands the destination to `open`, which reaches it
 * through the SSH server. Only CONNECT with no authentication, as ssh does;
 * the proxy listens on this computer only unless told otherwise.
 */
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

const VERSION = 5
const NO_AUTH = 0
const NO_ACCEPTABLE = 0xff
const CONNECT = 1
const REPLY = { ok: 0, failure: 1, refused: 5, unsupported: 7, badAddress: 8 }

/** Parses a SOCKS5 request ("VER CMD RSV ATYP ADDR PORT"): null if more bytes are needed. */
export function parseRequest(buf: Buffer): { cmd: number; host: string; port: number; length: number } | { error: number } | null {
  if (buf.length < 5) return null
  if (buf[0] !== VERSION) return { error: REPLY.failure }
  const cmd = buf[1]!
  const atyp = buf[3]!
  let host: string
  let offset: number
  if (atyp === 1) {
    if (buf.length < 10) return null
    host = [...buf.subarray(4, 8)].join('.')
    offset = 8
  } else if (atyp === 3) {
    const n = buf[4]!
    if (buf.length < 5 + n + 2) return null
    host = buf.subarray(5, 5 + n).toString('utf8')
    offset = 5 + n
  } else if (atyp === 4) {
    if (buf.length < 22) return null
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
    host = parts.join(':')
    offset = 20
  } else {
    return { error: REPLY.badAddress }
  }
  return { cmd, host, port: buf.readUInt16BE(offset), length: offset + 2 }
}

const reply = (code: number) => Buffer.from([VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0])

/** Serves one SOCKS client on `socket`. */
export function serveSocks(socket: Socket, open: (host: string, port: number) => Promise<Duplex>): void {
  let buffered = Buffer.alloc(0)
  let stage: 'greeting' | 'request' | 'connecting' = 'greeting'
  socket.on('error', () => socket.destroy())
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    if (stage === 'greeting') {
      if (buffered.length < 2) return
      const methods = buffered[1]!
      if (buffered.length < 2 + methods) return
      if (buffered[0] !== VERSION) return void socket.destroy()
      const offered = buffered.subarray(2, 2 + methods)
      buffered = buffered.subarray(2 + methods)
      if (!offered.includes(NO_AUTH)) {
        socket.end(Buffer.from([VERSION, NO_ACCEPTABLE]))
        return
      }
      socket.write(Buffer.from([VERSION, NO_AUTH]))
      stage = 'request'
    }
    if (stage === 'request') {
      const request = parseRequest(buffered)
      if (!request) return
      if ('error' in request) return void socket.end(reply(request.error))
      if (request.cmd !== CONNECT) return void socket.end(reply(REPLY.unsupported))
      const rest = buffered.subarray(request.length)
      stage = 'connecting'
      socket.off('data', onData)
      socket.pause()
      open(request.host, request.port).then(
        (stream) => {
          if (socket.destroyed) return void stream.destroy()
          socket.write(reply(REPLY.ok))
          if (rest.length) stream.write(rest)
          stream.on('error', () => socket.destroy())
          socket.on('close', () => stream.destroy())
          socket.pipe(stream).pipe(socket)
          socket.resume()
        },
        () => socket.end(reply(REPLY.refused)),
      )
    }
  }
  socket.on('data', onData)
}
