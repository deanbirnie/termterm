import { describe, expect, it } from 'vitest'
import { checkForUpdate, isNewer } from '../src/updates'

const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('isNewer', () => {
  it('compares x.y.z numerically', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.3.0', '0.3.0')).toBe(false)
    expect(isNewer('0.2.9', '0.3.0')).toBe(false)
  })
  it('treats a development build as older and ignores odd tags', () => {
    expect(isNewer('0.3.1', 'dev')).toBe(true)
    expect(isNewer('nonsense', '0.3.0')).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('points at the APK of a newer release', async () => {
    const state = await checkForUpdate(
      '0.3.0',
      reply({
        tag_name: 'v0.3.1',
        html_url: 'https://github.com/x/releases/tag/v0.3.1',
        assets: [
          { name: 'termterm-0.3.1-setup.exe', browser_download_url: 'https://dl/setup.exe' },
          { name: 'termterm-0.3.1.apk', browser_download_url: 'https://dl/termterm-0.3.1.apk' },
        ],
      }),
    )
    expect(state).toEqual({ status: 'available', version: '0.3.1', downloadUrl: 'https://dl/termterm-0.3.1.apk' })
  })
  it('falls back to the release page when the release has no APK', async () => {
    const state = await checkForUpdate(
      '0.3.0',
      reply({ tag_name: 'v0.4.0', html_url: 'https://github.com/x/releases/tag/v0.4.0', assets: [] }),
    )
    expect(state).toMatchObject({ status: 'available', downloadUrl: 'https://github.com/x/releases/tag/v0.4.0' })
  })
  it('reports up to date, and failures', async () => {
    expect((await checkForUpdate('0.3.1', reply({ tag_name: 'v0.3.1' }))).status).toBe('current')
    const failed = await checkForUpdate('0.3.1', reply({ message: 'rate limited' }, 403))
    expect(failed).toMatchObject({ status: 'error', message: 'Could not check for updates: GitHub answered 403' })
  })
})
