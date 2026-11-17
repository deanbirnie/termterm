import { describe, expect, it } from 'vitest'
import { LineTracker, suggest, wasEchoed } from '../src/suggest'

describe('LineTracker', () => {
  it('follows typing, backspace and Enter', () => {
    const t = new LineTracker()
    expect(t.input('ls -l')).toEqual([])
    t.input('x\x7f')
    expect(t.line).toBe('ls -l')
    expect(t.input('a\r')).toEqual(['ls -la'])
    expect(t.line).toBe('')
  })

  it('handles pasted text with several lines', () => {
    const t = new LineTracker()
    expect(t.input('cd /srv\rgit pull\r')).toEqual(['cd /srv', 'git pull'])
  })

  it('gives up on the line after Tab, arrows or history keys, until Enter', () => {
    const t = new LineTracker()
    t.input('git ch\t')
    expect(t.known).toBe(false)
    expect(t.input('eckout main\r')).toEqual([]) // the shell completed something unseen
    expect(t.known).toBe(true)
    t.input('echo hi\x1b[D')
    expect(t.known).toBe(false)
    t.input('\r\x1b[A\r')
    expect(t.known).toBe(true)
    expect(t.line).toBe('')
  })

  it('Ctrl+C and Ctrl+U clear the line; Ctrl+W deletes a word', () => {
    const t = new LineTracker()
    t.input('rm -rf build')
    t.input('\x17')
    expect(t.line).toBe('rm -rf ')
    t.input('\x03')
    expect(t.line).toBe('')
    t.input('abc\x15')
    expect(t.line).toBe('')
  })
})

describe('suggest', () => {
  const history = ['ls', 'ls -la', 'git status', 'ls -la /var/log', 'git pull']
  it('offers history that starts with the line, newest first, then snippets', () => {
    expect(suggest('ls', history, [{ script: 'ls -lh --color' }]).map((s) => s.text)).toEqual([
      'ls -la /var/log',
      'ls -la',
      'ls -lh --color',
    ])
    expect(suggest('git', history, []).map((s) => s.from)).toEqual(['history', 'history'])
  })
  it('needs two characters, skips lines starting with a space and multi-line snippets', () => {
    expect(suggest('l', history, [])).toEqual([])
    expect(suggest(' ls', history, [])).toEqual([])
    expect(suggest('ech', [], [{ script: 'echo a\necho b' }])).toEqual([])
  })
  it('does not offer what is already typed, and limits the list', () => {
    expect(suggest('git status', history, [])).toEqual([])
    expect(suggest('ls', history, [], 1)).toHaveLength(1)
  })
})

describe('wasEchoed', () => {
  it('is true only when the screen line ends with what was typed', () => {
    expect(wasEchoed('dean@box:~$ ls -la   ', 'ls -la')).toBe(true)
    expect(wasEchoed('[sudo] password for dean: ', 'hunter2')).toBe(false)
    expect(wasEchoed('$ ', '')).toBe(false)
  })
})
