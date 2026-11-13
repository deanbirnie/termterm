/**
 * Update checks for the Android app. Android apps cannot replace themselves,
 * so this only finds out whether a newer release exists and where its APK is;
 * the person downloads it in the browser and installs it over this one.
 */
import type { UpdateState } from '@termterm/app'

const LATEST = 'https://api.github.com/repos/deanbirnie/termterm/releases/latest'
export const RELEASES_PAGE = 'https://github.com/deanbirnie/termterm/releases/latest'

interface Release {
  tag_name?: unknown
  html_url?: unknown
  assets?: { name?: unknown; browser_download_url?: unknown }[]
}

/** Compares plain x.y.z versions; anything else (a dev build) counts as oldest. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
  const a = parse(candidate)
  const b = parse(current)
  if (!a) return false
  if (!b) return true
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!
  return false
}

/** Asks GitHub for the latest release and compares it with this app's version. */
export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<UpdateState> {
  try {
    const response = await fetchImpl(LATEST, { headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    const release = (await response.json()) as Release
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const version = tag.replace(/^v/, '')
    if (!isNewer(version, current)) return { status: 'current', checkedAt: Date.now() }
    const apk = release.assets?.find((a) => a.name === `termterm-${version}.apk`)
    const downloadUrl =
      typeof apk?.browser_download_url === 'string'
        ? apk.browser_download_url
        : typeof release.html_url === 'string'
          ? release.html_url
          : RELEASES_PAGE
    return { status: 'available', version, downloadUrl }
  } catch (e) {
    return { status: 'error', message: `Could not check for updates: ${(e as Error).message}` }
  }
}
