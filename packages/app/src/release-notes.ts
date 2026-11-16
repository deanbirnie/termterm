/**
 * What changed between the installed version and the newest release, read
 * from the GitHub releases list. Both apps use it for the "New update" card;
 * the Android app also finds its APK here.
 */

export const RELEASES_API = 'https://api.github.com/repos/deanbirnie/termterm/releases?per_page=30'
export const RELEASES_PAGE = 'https://github.com/deanbirnie/termterm/releases/latest'

export interface ReleaseNotes {
  version: string
  url: string
  /** One line per change, as plain text. */
  changes: string[]
}

/** The parts of a GitHub release this reads. Everything is checked, as it comes from the network. */
export interface GithubRelease {
  tag_name?: unknown
  html_url?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: { name?: unknown; browser_download_url?: unknown }[]
}

/** Compares plain x.y.z versions; anything else (a development build) counts as oldest. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
  const a = parse(candidate)
  const b = parse(current)
  if (!a) return false
  if (!b) return true
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!
  return false
}

export const versionOf = (release: GithubRelease) =>
  typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''

const published = (r: GithubRelease) => r.draft !== true && r.prerelease !== true && /^\d+\.\d+\.\d+$/.test(versionOf(r))

/** The newest published (not draft, not pre-release) release. */
export function latestRelease(releases: GithubRelease[]): GithubRelease | undefined {
  return releases.filter(published).reduce<GithubRelease | undefined>(
    (best, r) => (!best || isNewer(versionOf(r), versionOf(best)) ? r : best),
    undefined,
  )
}

/**
 * The changes listed in a release description: the bullet points under its
 * "What's Changed" heading (GitHub's generated notes), without the
 * "by @someone in <link>" endings. Plain text only: nothing is rendered as HTML.
 */
export function parseChanges(body: unknown): string[] {
  if (typeof body !== 'string') return []
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#+\s*What'?s Changed/i.test(l.trim()))
  if (start < 0) return []
  const changes: string[] = []
  for (const line of lines.slice(start + 1)) {
    const t = line.trim()
    if (/^#/.test(t) || /^\*\*Full Changelog/i.test(t)) break
    const m = /^[*-]\s+(.*)$/.exec(t)
    if (!m) continue
    const text = m[1]!
      .replace(/\s+by @[\w-]+(\[bot\])?\s+in\s+\S+\s*$/, '')
      .replace(/\s+in\s+https?:\/\/\S+\s*$/, '')
      .trim()
    if (text) changes.push(text.slice(0, 200))
  }
  return changes
}

/** Notes for every published release after `current`, up to `latest`, newest first. */
export function notesBetween(releases: GithubRelease[], current: string, latest: string): ReleaseNotes[] {
  return releases
    .filter(published)
    .filter((r) => isNewer(versionOf(r), current) && !isNewer(versionOf(r), latest))
    .sort((a, b) => (isNewer(versionOf(a), versionOf(b)) ? -1 : 1))
    .map((r) => ({
      version: versionOf(r),
      url: typeof r.html_url === 'string' && r.html_url.startsWith('https://') ? r.html_url : RELEASES_PAGE,
      changes: parseChanges(r.body),
    }))
}

/** Fetches the releases list. Throws on failure; callers decide what that means. */
export async function fetchReleases(
  url = RELEASES_API,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<GithubRelease[]> {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const data = (await response.json()) as unknown
  if (!Array.isArray(data)) throw new Error('GitHub sent something unexpected')
  return data as GithubRelease[]
}
