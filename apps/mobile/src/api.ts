/**
 * The mobile implementation of the contract the shared interface talks to.
 * On desktop this sits behind Electron IPC in a separate process; here it
 * runs in the same WebView as the interface, on top of the same VaultService.
 */
import { Capacitor } from '@capacitor/core'
import {
  VaultService,
  type AppPhase,
  type ForwardState,
  type SessionStatus,
  type Settings,
  type SshPrompt,
  type TermtermApi,
  type TransferState,
  type UpdateState,
  type VaultSnapshot,
} from '@termterm/app'
import { BiometricCancelled, biometricKeyStore } from './device-key'
import { createSsh, nativeKeyTools, setTerminalFocus } from './ssh'
import { vaultStorage } from './storage'
import { openExportFile, saveExportFile } from './export-file'
import { checkForUpdate, downloadApk, installApk } from './updates'

declare const __APP_VERSION__: string

// SSH and key handling live in the native Android plugin, so they exist only
// in the installed app, not when this code runs in a desktop browser.
const NATIVE = Capacitor.isNativePlatform()
const SSH_UNAVAILABLE = 'SSH sessions are only available in the installed app'
const KEYS_UNAVAILABLE = 'Keys can only be created in the installed app'
const SETTINGS_KEY = 'termterm.settings'
const notOnPhone = async (): Promise<never> => {
  throw new Error('Browsing files is available in the desktop app')
}

class Emitter<Args extends unknown[]> {
  private listeners = new Set<(...args: Args) => void>()
  on = (cb: (...args: Args) => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  emit(...args: Args) {
    for (const cb of this.listeners) cb(...args)
  }
}

// ---- settings: not secret, so plain local storage --------------------------------

const DEFAULT_SETTINGS: Settings = { autoLockMinutes: 15, rememberDevice: false, autoCheckUpdates: true, keepTabsOnVaultSwitch: false }

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>
    const minutes = Number(stored.autoLockMinutes)
    return {
      ...DEFAULT_SETTINGS,
      rememberDevice: stored.rememberDevice === true,
      autoCheckUpdates: stored.autoCheckUpdates !== false,
      keepTabsOnVaultSwitch: stored.keepTabsOnVaultSwitch === true,
      autoLockMinutes:
        Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : DEFAULT_SETTINGS.autoLockMinutes,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function createApi(): TermtermApi {
  const phase = new Emitter<[AppPhase]>()
  const snapshot = new Emitter<[VaultSnapshot]>()
  let settings = loadSettings()

  const vault = new VaultService(
    {
      storage: vaultStorage,
      // In the installed app the vault key can sit behind a fingerprint or
      // face check; in a browser there is nothing comparable.
      deviceKey: NATIVE
        ? biometricKeyStore
        : {
            available: async () => false,
            save: async () => {
              throw new Error('Not available in a browser')
            },
            load: async () => null,
            clear: () => undefined,
          },
      keys: NATIVE
        ? nativeKeyTools
        : {
            generate: () => {
              throw new Error(KEYS_UNAVAILABLE)
            },
            import: () => {
              throw new Error(KEYS_UNAVAILABLE)
            },
          },
      deviceName: () => (Capacitor.getPlatform() === 'android' ? 'Android device' : 'Mobile browser'),
      rememberDevice: () => NATIVE && settings.rememberDevice,
    },
    (s) => snapshot.emit(s),
    (p) => phase.emit(p),
  )

  const sshData = new Emitter<[string, Uint8Array]>()
  const sshStatus = new Emitter<[string, SessionStatus]>()
  const sshPrompt = new Emitter<[SshPrompt]>()
  const forwardState = new Emitter<[string, ForwardState]>()
  const transfer = new Emitter<[TransferState]>()
  const ssh = NATIVE
    ? createSsh(vault, {
        data: (id, data) => sshData.emit(id, data),
        status: (id, status) => sshStatus.emit(id, status),
        prompt: (prompt) => sshPrompt.emit(prompt),
        forwardState: (id, state) => forwardState.emit(id, state),
        transfer: (t) => transfer.emit(t),
      })
    : null
  const needSsh = () => {
    if (!ssh) throw new Error(SSH_UNAVAILABLE)
    return ssh
  }

  // Like the desktop app: forwards keep running while the vault is locked (as
  // open terminals do), and the ones marked to start automatically start
  // whenever it is opened.
  phase.on((p) => {
    if (!ssh) return
    if (p === 'unlocked') {
      for (const f of vault.snapshot().forwards) {
        if (f.autoStart && !ssh.runningForwards().includes(f.id)) void ssh.forwardStart(f.id).catch(() => undefined)
      }
    }
  })

  // Auto-lock: a phone has no idle timer worth trusting, so lock when the app
  // has been in the background for longer than the chosen time.
  let hiddenAt: number | null = null
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now()
    } else if (hiddenAt !== null) {
      const away = Date.now() - hiddenAt
      hiddenAt = null
      if (settings.autoLockMinutes > 0 && away >= settings.autoLockMinutes * 60_000) vault.lock()
    }
  })

  // Android apps cannot replace themselves: a check finds the newer APK, and
  // the person downloads it in the browser and installs it over this one.
  let updateState: UpdateState = { status: 'idle' }
  const updateChanged = new Emitter<[UpdateState]>()
  const setUpdateState = (state: UpdateState) => {
    updateState = state
    updateChanged.emit(state)
  }
  let apkUrl: string | undefined
  const checkUpdates = async () => {
    if (['checking', 'downloading', 'ready'].includes(updateState.status)) return updateState
    setUpdateState({ status: 'checking' })
    const result = await checkForUpdate(__APP_VERSION__)
    apkUrl = result.apkUrl
    // The installed app downloads the APK itself; elsewhere it stays a link.
    const state = result.state
    setUpdateState(NATIVE && apkUrl && state.status === 'available' ? { ...state, downloadUrl: undefined } : state)
    return updateState
  }
  const downloadUpdate = async () => {
    if (updateState.status !== 'available' || !NATIVE || !apkUrl) return
    const version = updateState.version
    setUpdateState({ status: 'downloading', version, percent: 0 })
    try {
      await downloadApk(apkUrl, (percent) => {
        if (updateState.status === 'downloading') setUpdateState({ status: 'downloading', version, percent })
      })
      setUpdateState({ status: 'ready', version, install: true })
    } catch (e) {
      setUpdateState({ status: 'error', message: `The update could not be downloaded: ${(e as Error).message}` })
    }
  }
  if (settings.autoCheckUpdates) void checkUpdates()

  return {
    phase: () => vault.phase(),
    onPhase: phase.on,
    createVault: (password) => vault.create(password),
    signIn: (input) => vault.signIn(input),
    unlock: (password) => vault.unlock(password),
    biometricUnlockAvailable: () => vault.canUnlockWithDevice(),
    biometricUnlock: () => vault.unlockWithDevice(),
    lock: async () => vault.lock(),
    changePassword: (current, next) => vault.changePassword(current, next),

    settings: async () => settings,
    saveSettings: async (patch) => {
      const before = settings
      settings = {
        ...settings,
        ...patch,
        rememberDevice: NATIVE && (patch.rememberDevice ?? settings.rememberDevice),
      }
      if (settings.rememberDevice !== before.rememberDevice) {
        try {
          // Turning it on stores the key, which asks for a fingerprint first.
          await vault.applyRememberDevice()
        } catch (e) {
          settings = before
          if (e instanceof BiometricCancelled) return settings
          throw e
        }
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      return settings
    },
    deviceUnlockAvailable: async () => NATIVE && (await biometricKeyStore.available()),

    snapshot: async () => vault.snapshot(),
    onSnapshot: snapshot.on,

    saveHost: async (id, input) => vault.saveHost(id, input),
    generateKey: (label, type) => vault.generateKey(label, type),
    importKey: (input) => vault.importKey(input),
    renameKey: async (id, label) => vault.renameKey(id, label),
    addVault: async (name) => vault.addVault(name),
    renameVault: async (id, name) => vault.renameVault(id, name),
    deleteVault: (id, options) => vault.deleteVault(id, options),
    addServer: (input) => vault.addServer(input),
    removeServer: (id) => vault.removeServer(id),
    serverSignIn: (id, password) => vault.serverSignIn(id, password),
    serverVaults: (id) => vault.serverVaults(id),
    addServerVault: (serverId, vaultId) => vault.addServerVault(serverId, vaultId),
    connectVault: (vaultId, serverId) => vault.connectVault(vaultId, serverId),
    disconnectVault: (vaultId, options) => vault.disconnectVault(vaultId, options),
    switchVault: async (id) => vault.switchVault(id),
    setKeyCertificate: async (id, certificate) => vault.setKeyCertificate(id, certificate),
    saveSnippet: async (id, input) => vault.saveSnippet(id, input),
    saveIdentity: async (id, input) => vault.saveIdentity(id, input),
    vaultExport: async (password) => {
      const { text } = await vault.exportVault(password)
      return saveExportFile(`termterm-export-${new Date().toISOString().slice(0, 10)}.termterm`, text)
    },
    pickExportFile: () => openExportFile(),
    saveTextFile: (name, text) => saveExportFile(name, text),
    vaultImport: (text, password) => vault.importVault(text, password),
    renameGroup: async (from, to) => vault.renameGroup(from, to),
    saveForward: async (id, input) => vault.saveForward(id, input),
    forwardStart: (id) => needSsh().forwardStart(id),
    forwardStop: async (id) => ssh?.forwardStop(id),
    forwardStates: async () => ssh?.forwardStates() ?? {},
    onForwardState: forwardState.on,
    // The server's files; this phone's own files are reached through Android's
    // file picker (sftpDownloadPicked / sftpUploadPicked), not browsed.
    sftpOpen: (sessionId, target) => needSsh().sftpOpen(sessionId, target),
    sftpList: (sessionId, path) => needSsh().sftpList(sessionId, path),
    sftpMkdir: (sessionId, path) => needSsh().sftpMkdir(sessionId, path),
    sftpRename: (sessionId, from, to) => needSsh().sftpRename(sessionId, from, to),
    sftpDelete: (sessionId, path) => needSsh().sftpDelete(sessionId, path),
    sftpClose: (sessionId) => ssh?.sftpClose(sessionId),
    sftpChmod: (sessionId, path, mode) => needSsh().sftpChmod(sessionId, path, mode),
    sftpReadText: (sessionId, path) => needSsh().sftpReadText(sessionId, path),
    sftpWriteText: (sessionId, path, text, expected) => needSsh().sftpWriteText(sessionId, path, text, expected),
    sftpDownloadPicked: (sessionId, path, name, size) => needSsh().sftpDownload(sessionId, path, name, size),
    sftpUploadPicked: (sessionId, folder) => needSsh().sftpUpload(sessionId, folder),
    localList: notOnPhone,
    localMkdir: notOnPhone,
    localRename: notOnPhone,
    localDelete: notOnPhone,
    transfer: notOnPhone,
    onTransfer: transfer.on,
    pathForFile: () => '',
    // A phone has no ~/.ssh: only pasted text.
    sshImportScan: async (paste) => {
      if (!paste) throw new Error('Paste the contents of ~/.ssh/config to import from it')
      return vault.scanSshImport({ source: 'pasted text', config: paste.config, knownHosts: paste.knownHosts })
    },
    sshImportApply: (aliases, knownHosts) => vault.applySshImport(aliases, knownHosts),
    commandHistory: async (key) => vault.commandHistory(key),
    recordCommands: async (key, commands) => vault.recordCommands(key, commands),
    clearCommandHistory: async () => vault.clearCommandHistory(),
    deleteItem: async (id) => vault.deleteItem(id),

    syncRegister: (input) => vault.syncRegister(input),
    syncSignIn: (input) => vault.syncSignIn(input),
    syncReauth: (password) => vault.syncReauth(password),
    syncNow: () => vault.syncNow(),
    syncDisconnect: () => vault.syncDisconnect(),
    syncDeleteAccount: (password) => vault.syncDeleteAccount(password),
    syncDismissRollback: async () => vault.syncDismissRollback(),
    syncDevices: () => vault.syncDevices(),
    syncUsage: () => vault.syncUsage(),
    syncRevokeDevice: (id) => vault.syncRevokeDevice(id),

    sshConnect: async (sessionId, target, cols, rows) => {
      if ('local' in target) throw new Error('A local terminal is not available on a phone')
      if (!ssh) throw new Error(SSH_UNAVAILABLE)
      await ssh.connect(sessionId, target, cols, rows)
    },
    sshWrite: (sessionId, data) => ssh?.write(sessionId, data),
    sshResize: (sessionId, cols, rows) => ssh?.resize(sessionId, cols, rows),
    sshClose: (sessionId) => ssh?.close(sessionId),
    sshPromptReply: (promptId, reply) => ssh?.promptReply(promptId, reply),
    terminalFocus: (active) => {
      if (NATIVE) setTerminalFocus(active)
    },
    onSshData: sshData.on,
    onSshStatus: sshStatus.on,
    onSshPrompt: sshPrompt.on,

    appInfo: async () => ({
      version: __APP_VERSION__,
      packaged: Capacitor.isNativePlatform(),
      platform: 'mobile',
      capabilities: { ssh: NATIVE, keys: NATIVE, biometricUnlock: true, forwards: NATIVE, sftp: NATIVE, localFiles: false },
    }),
    localShells: async () => [],
    updateState: async () => updateState,
    onUpdateState: updateChanged.on,
    updateCheck: checkUpdates,
    updateDownload: downloadUpdate,
    updateInstall: async () => {
      if (updateState.status === 'ready' && NATIVE) await installApk()
    },

    clipboardWrite: (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
    clipboardRead: async () => (await navigator.clipboard?.readText().catch(() => '')) ?? '',
  }
}
