import { describe, expect, it } from 'vitest'
import { checkForUpdate } from '../src/updates'

const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

const release = (version: string, extra: object = {}) => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/deanbirnie/termterm/releases/tag/v${version}`,
  body: `**Desktop app**\n- Windows: run the installer\n\n## What's Changed\n* Change in ${version} by @dean in https://github.com/x/pull/1\n\n**Full Changelog**: https://x`,
  assets: [
    { name: `termterm-${version}-setup.exe`, browser_download_url: `https://dl/${version}/setup.exe` },
    { name: `termterm-${version}.apk`, browser_download_url: `https://dl/${version}/termterm-${version}.apk` },
  ],
  ...extra,
})

describe('checkForUpdate', () => {
  it('finds the newest release, its APK and every change since this version', async () => {
    const { state, apkUrl } = await checkForUpdate(
      '0.3.0',
      reply([release('0.5.0'), release('0.6.0-beta.1', { prerelease: true }), release('0.4.0'), release('0.3.0')]),
    )
    expect(apkUrl).toBe('https://dl/0.5.0/termterm-0.5.0.apk')
    expect(state).toMatchObject({ status: 'available', version: '0.5.0', downloadUrl: apkUrl })
    expect(state.status === 'available' && state.notes).toEqual([
      { version: '0.5.0', url: 'https://github.com/deanbirnie/termterm/releases/tag/v0.5.0', changes: ['Change in 0.5.0'] },
      { version: '0.4.0', url: 'https://github.com/deanbirnie/termterm/releases/tag/v0.4.0', changes: ['Change in 0.4.0'] },
    ])
  })
  it('falls back to the release page when the release has no APK', async () => {
    const { state, apkUrl } = await checkForUpdate('0.3.0', reply([release('0.4.0', { assets: [] })]))
    expect(apkUrl).toBeUndefined()
    expect(state).toMatchObject({ status: 'available', downloadUrl: 'https://github.com/deanbirnie/termterm/releases/tag/v0.4.0' })
  })
  it('reports up to date, and failures', async () => {
    expect((await checkForUpdate('0.5.0', reply([release('0.5.0')]))).state.status).toBe('current')
    const failed = await checkForUpdate('0.5.0', reply({ message: 'rate limited' }, 403))
    expect(failed.state).toMatchObject({ status: 'error', message: 'Could not check for updates: GitHub answered 403' })
  })
})
