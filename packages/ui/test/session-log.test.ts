import { describe, expect, it } from 'vitest'
import { logFileName, plainText, SessionRecorder } from '../src/session-log.ts'

describe('session logs', () => {
  it('keeps the text and drops colours, cursor moves and titles', () => {
    expect(plainText('\x1b]0;dean@web: ~\x07\x1b[01;32mdean@web\x1b[00m:\x1b[01;34m~\x1b[00m$ ls\r\nREADME.md\r\n')).toBe(
      'dean@web:~$ ls\nREADME.md\n',
    )
  })

  it('keeps what a progress bar drew last, and applies backspaces', () => {
    expect(plainText('10%\r50%\r100%\r\ndone\n')).toBe('100%\ndone\n')
    expect(plainText('ecoh\x08\x08ho hi\n')).toBe('echo hi\n')
    expect(plainText('a\tb\x07c\n')).toBe('a\tbc\n')
  })

  it('records across chunks, including a sequence split between them', () => {
    const r = new SessionRecorder()
    const enc = new TextEncoder()
    r.add(enc.encode('hello \x1b[3'))
    r.add(enc.encode('1mred\x1b[0m wörld\r\n'))
    expect(r.text()).toBe('hello red wörld\n')
  })

  it('stops at its size limit and says so', () => {
    const r = new SessionRecorder(10)
    r.add(new TextEncoder().encode('0123456789'))
    r.add(new TextEncoder().encode('more'))
    expect(r.truncated).toBe(true)
    expect(r.text()).toBe('0123456789\n[termterm: recording stopped at the size limit]\n')
  })

  it('names files after the session and the time', () => {
    expect(logFileName('dean@web: prod', 'output', new Date('2026-11-17T22:15:03Z'))).toBe('dean@web-prod-output-2026-11-17-22-15-03.log')
    expect(logFileName('///', 'recording')).toMatch(/^session-recording-/)
  })
})
