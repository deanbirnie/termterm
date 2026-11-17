import { describe, expect, it } from 'vitest'
import { toBase64 } from '@termterm/core'
import { parseKnownHosts, parseSshConfig } from '../src/ssh-import'

/** A public key blob of the given type, as known_hosts stores it. */
function blob(type: string, fill: number): string {
  const name = new TextEncoder().encode(type)
  const out = new Uint8Array(4 + name.length + 4 + 32)
  new DataView(out.buffer).setUint32(0, name.length)
  out.set(name, 4)
  new DataView(out.buffer).setUint32(4 + name.length, 32)
  out.fill(fill, 8 + name.length)
  return toBase64(out)
}

describe('parseSshConfig', () => {
  it('reads each named host, with defaults from wildcard blocks; first value wins', () => {
    const config = [
      '# my hosts',
      'Host web web-alias',
      '  HostName 203.0.113.10',
      '  User deploy',
      '  Port 2222',
      '  IdentityFile ~/.ssh/deploy_key',
      '',
      'Host db',
      '  HostName=db.internal',
      '  ProxyJump bastion',
      '',
      'Host *.example.com !skip.example.com',
      '  User admin',
      '',
      'Host *',
      '  User fallback',
      '  Port 22',
      '',
      'Match host db exec "true"',
      '  User ignored',
    ].join('\n')
    expect(parseSshConfig(config)).toEqual([
      { alias: 'web', address: '203.0.113.10', port: 2222, username: 'deploy', identityFile: '~/.ssh/deploy_key', proxyJump: undefined },
      { alias: 'web-alias', address: '203.0.113.10', port: 2222, username: 'deploy', identityFile: '~/.ssh/deploy_key', proxyJump: undefined },
      { alias: 'db', address: 'db.internal', port: 22, username: 'fallback', identityFile: undefined, proxyJump: 'bastion' },
    ])
  })

  it('uses the alias as the address when there is no HostName, and %h', () => {
    expect(parseSshConfig('Host box\n  HostName %h.lan\nHost plain')).toMatchObject([
      { alias: 'box', address: 'box.lan' },
      { alias: 'plain', address: 'plain', port: 22, username: '' },
    ])
  })
})

describe('parseKnownHosts', () => {
  it('reads plain entries, one per name, and skips what cannot be imported', () => {
    const ed = blob('ssh-ed25519', 1)
    const text = [
      `box.example.com,203.0.113.10 ssh-ed25519 ${ed}`,
      `[gw.example.com]:2222 ssh-ed25519 ${ed} comment`,
      `|1|abc=|def= ssh-ed25519 ${ed}`,
      `@revoked old.example.com ssh-ed25519 ${ed}`,
      `wrong.example.com ssh-rsa ${ed}`, // the key is not of the type it claims
      '# comment',
    ].join('\n')
    const { entries, skipped } = parseKnownHosts(text)
    expect(entries.map((e) => [e.host, e.port, e.keyType])).toEqual([
      ['box.example.com', 22, 'ssh-ed25519'],
      ['203.0.113.10', 22, 'ssh-ed25519'],
      ['gw.example.com', 2222, 'ssh-ed25519'],
    ])
    expect(entries[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(skipped).toBe(3)
  })
})
