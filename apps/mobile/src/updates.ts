/**
 * Updates for the Android app. A check reads the releases list from GitHub:
 * the newest release, what changed since this version, and its APK. The
 * installed app downloads the APK itself (AppUpdatePlugin) and hands it to
 * Android's installer; in a plain browser the APK is offered as a link.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  fetchReleases,
  isNewer,
  latestRelease,
  notesBetween,
  RELEASES_API,
  RELEASES_PAGE,
  versionOf,
  type UpdateState,
} from '@termterm/app'

export { isNewer, RELEASES_PAGE }

export interface UpdateCheck {
  state: UpdateState
  /** The newest release's APK, when there is one to download. */
  apkUrl?: string
}

/** Asks GitHub for the releases and compares the newest with this app's version. */
export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<UpdateCheck> {
  try {
    const releases = await fetchReleases(RELEASES_API, fetchImpl)
    const latest = latestRelease(releases)
    const version = latest ? versionOf(latest) : ''
    if (!latest || !isNewer(version, current)) return { state: { status: 'current', checkedAt: Date.now() } }
    const apk = latest.assets?.find((a) => a.name === `termterm-${version}.apk`)
    const apkUrl = typeof apk?.browser_download_url === 'string' ? apk.browser_download_url : undefined
    const page = typeof latest.html_url === 'string' ? latest.html_url : RELEASES_PAGE
    return {
      state: { status: 'available', version, notes: notesBetween(releases, current, version), downloadUrl: apkUrl ?? page },
      apkUrl,
    }
  } catch (e) {
    return { state: { status: 'error', message: `Could not check for updates: ${(e as Error).message}` } }
  }
}

// ---- downloading and installing, in the installed app ----------------------------

interface AppUpdatePluginApi {
  download(options: { url: string }): Promise<void>
  install(): Promise<{ needsPermission: boolean }>
  addListener(event: 'progress', cb: (e: { percent: number }) => void): Promise<PluginListenerHandle>
}

const AppUpdate = registerPlugin<AppUpdatePluginApi>('AppUpdate')

/** Downloads the APK into the app, reporting progress; rejects with a readable message. */
export async function downloadApk(url: string, onProgress: (percent: number) => void): Promise<void> {
  const listener = await AppUpdate.addListener('progress', (e) => onProgress(e.percent))
  try {
    await AppUpdate.download({ url })
  } finally {
    await listener.remove()
  }
}

/**
 * Opens Android's installer for the downloaded APK. The first time, Android
 * asks whether termterm may install apps; that opens settings instead and
 * returns true, and the installer is opened on the next try.
 */
export async function installApk(): Promise<boolean> {
  return (await AppUpdate.install()).needsPermission
}
