import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/api'

/**
 * In-app updates from GitHub releases. electron-updater reads the release's
 * `latest*.yml`, downloads the installer and checks its SHA-512 against that
 * file before installing. Nothing is downloaded until the user asks.
 */
export class Updater {
  private state: UpdateState

  constructor(private readonly onState: (state: UpdateState) => void) {
    const reason = this.unsupportedReason()
    this.state = reason ? { status: 'unsupported', reason } : { status: 'idle' }
    if (reason) return

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = null

    // Tests point an unpackaged build at a local feed. A packaged app always
    // uses the release feed baked in at build time and ignores this variable.
    const testFeed = app.isPackaged ? undefined : process.env.TERMTERM_UPDATE_FEED
    if (testFeed) {
      // An unpackaged build has no app-update.yml, so write the one it would have.
      const config = join(app.getPath('userData'), 'dev-app-update.yml')
      mkdirSync(dirname(config), { recursive: true })
      writeFileSync(
        config,
        `provider: generic\nurl: ${JSON.stringify(testFeed)}\nupdaterCacheDirName: termterm-updater-test\n`,
      )
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.updateConfigPath = config
    }

    autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'current', checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (p) => {
      if (this.state.status === 'downloading') {
        this.set({ ...this.state, percent: Math.round(p.percent) })
      }
    })
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }))
    autoUpdater.on('error', (err) => this.set({ status: 'error', message: friendly(err) }))
  }

  private unsupportedReason(): string | undefined {
    if (!app.isPackaged) {
      return process.env.TERMTERM_UPDATE_FEED ? undefined : 'Updates are only available in installed builds.'
    }
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      return 'The portable build cannot update itself. Download the new version from the releases page.'
    }
    if (process.platform === 'win32') return undefined
    if (process.platform === 'linux') {
      return process.env.APPIMAGE ? undefined : 'Only the AppImage build can update itself.'
    }
    return 'Automatic updates are not available on this platform yet.'
  }

  get(): UpdateState {
    return this.state
  }

  private set(state: UpdateState): void {
    this.state = state
    this.onState(state)
  }

  async check(): Promise<UpdateState> {
    const busy = ['unsupported', 'checking', 'downloading', 'ready']
    if (busy.includes(this.state.status)) return this.state
    this.set({ status: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ status: 'error', message: friendly(err as Error) })
    }
    return this.state
  }

  async download(): Promise<void> {
    if (this.state.status !== 'available') return
    this.set({ status: 'downloading', version: this.state.version, percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.set({ status: 'error', message: friendly(err as Error) })
    }
  }

  /** Quits and runs the downloaded installer. The caller closes sessions first. */
  install(): void {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall()
  }
}

function friendly(err: Error): string {
  const text = err?.message ?? String(err)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/.test(text)) {
    return 'Could not reach the update server. Check your connection and try again.'
  }
  if (/404|latest.*yml|No published versions/i.test(text)) {
    return 'No published release was found to update from.'
  }
  return text.split('\n')[0]!.slice(0, 200)
}
