import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRequest, serveSocks } from '../src/main/socks'

const servers: { close(): void }[] = []
afterEach(() => servers.splice(0).forEach((s) => s.close()))

async function listen(handler: (s: Socket) => void): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

/** Sends `bytes` and resolves with everything received until `count` bytes arrive or the socket ends. */
function exchange(port: number, steps: Buffer[], count: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1')
    let got = Buffer.alloc(0)
    s.on('data', (d) => {
      got = Buffer.concat([got, d])
      if (got.length >= count) {
        s.destroy()
        resolve(got)
      }
    })
    s.on('close', () => resolve(got))
    s.on('connect', () => steps.forEach((b) => s.write(b)))
  })
}

describe('SOCKS5', () => {
  it('parses IPv4, domain and IPv6 requests, and asks for more bytes when short', () => {
    expect(parseRequest(Buffer.from([5, 1, 0, 1, 10, 0, 0, 7, 0, 80]))).toEqual({ cmd: 1, host: '10.0.0.7', port: 80, length: 10 })
    const name = Buffer.from('intranet.lan')
    expect(parseRequest(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])]))).toMatchObject({
      host: 'intranet.lan',
      port: 443,
    })
    const v6 = Buffer.alloc(22)
    v6.set([5, 1, 0, 4])
    v6[19] = 1
    v6.writeUInt16BE(22, 20)
    expect(parseRequest(v6)).toMatchObject({ host: '0:0:0:0:0:0:0:1', port: 22 })
    expect(parseRequest(Buffer.from([5, 1, 0, 1, 10]))).toBeNull()
    expect(parseRequest(Buffer.from([5, 1, 0, 9, 0]))).toEqual({ error: 8 })
  })

  it('connects a client to the destination it asks for, with data both ways', async () => {
    const echo = await listen((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))))
    const asked: string[] = []
    const proxy = await listen((s) =>
      serveSocks(s, async (host, port) => {
        asked.push(`${host}:${port}`)
        return connect(echo, '127.0.0.1')
      }),
    )
    const request = Buffer.concat([Buffer.from([5, 1, 0, 3, 7]), Buffer.from('example'), Buffer.from([0, 80])])
    const got = await exchange(proxy, [Buffer.from([5, 1, 0]), request, Buffer.from('hi')], 2 + 10 + 7)
    expect([...got.subarray(0, 2)]).toEqual([5, 0]) // no authentication
    expect(got[3]).toBe(0) // CONNECT succeeded
    expect(got.subarray(12).toString()).toBe('echo:hi')
    expect(asked).toEqual(['example:80'])
  })

  it('refuses clients that need authentication, other commands, and destinations that fail', async () => {
    const proxy = await listen((s) => serveSocks(s, async () => Promise.reject(new Error('no route'))))
    expect([...(await exchange(proxy, [Buffer.from([5, 1, 2])], 2))]).toEqual([5, 0xff])
    const bind = await exchange(proxy, [Buffer.from([5, 1, 0]), Buffer.from([5, 2, 0, 1, 1, 2, 3, 4, 0, 80])], 12)
    expect(bind[3]).toBe(7)
    const refused = await exchange(proxy, [Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 1, 1, 2, 3, 4, 0, 80])], 12)
    expect(refused[3]).toBe(5)
  })
})
