import { describe, expect, it } from 'vitest'
import { isNewer, latestRelease, notesBetween, parseChanges } from '../src/release-notes'

describe('release notes', () => {
  it('compares versions numerically; development builds count as oldest', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.3.0', '0.3.0')).toBe(false)
    expect(isNewer('0.2.9', '0.3.0')).toBe(false)
    expect(isNewer('0.3.1', 'dev')).toBe(true)
    expect(isNewer('nonsense', '0.3.0')).toBe(false)
  })

  it("reads the What's Changed list as plain text, without author and link", () => {
    const body = [
      '**Desktop app**',
      '- Windows: run `termterm-0.5.0-setup.exe`.',
      '',
      "## What's Changed",
      '* Desktop: split tabs into panes, like tmux by @deanbirnie in https://github.com/deanbirnie/termterm/pull/21',
      '* Bump a thing by @dependabot[bot] in https://github.com/deanbirnie/termterm/pull/22',
      '- <img src=x onerror=alert(1)> stays text',
      '',
      '## New Contributors',
      '* @someone made their first contribution',
      '',
      '**Full Changelog**: https://github.com/deanbirnie/termterm/compare/v0.4.0...v0.5.0',
    ].join('\r\n')
    expect(parseChanges(body)).toEqual([
      'Desktop: split tabs into panes, like tmux',
      'Bump a thing',
      '<img src=x onerror=alert(1)> stays text',
    ])
    expect(parseChanges('No list here')).toEqual([])
    expect(parseChanges(undefined)).toEqual([])
  })

  it('collects every published release after the installed one, newest first', () => {
    const r = (v: string, extra = {}) => ({ tag_name: `v${v}`, html_url: `https://github.com/r/v${v}`, body: '', ...extra })
    const releases = [r('0.3.0'), r('0.5.0'), r('0.4.0'), r('0.6.0', { draft: true }), r('0.5.1-beta.1', { prerelease: true })]
    expect(latestRelease(releases)?.tag_name).toBe('v0.5.0')
    expect(notesBetween(releases, '0.3.0', '0.5.0').map((n) => n.version)).toEqual(['0.5.0', '0.4.0'])
    expect(notesBetween(releases, '0.5.0', '0.5.0')).toEqual([])
    expect(notesBetween([r('0.4.0', { html_url: 'javascript:alert(1)' })], '0.3.0', '0.4.0')[0]?.url).toBe(
      'https://github.com/deanbirnie/termterm/releases/latest',
    )
  })
})
