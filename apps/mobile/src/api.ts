/**
 * The mobile implementation of the contract the shared interface talks to.
 * On desktop this sits behind Electron IPC in a separate process; here it
 * runs in the same WebView as the interface, on top of the same VaultService.
 */
import { Capacitor } from '@capacitor/core'
import {
  VaultService,
  type AppPhase,
  type Settings,
  type TermtermApi,
  type UpdateState,
  type VaultSnapshot,
} from '@termterm/app'
import { vaultStorage } from './storage'

declare const __APP_VERSION__: string

const SSH_UNAVAILABLE = 'SSH sessions are not available in the mobile app yet'
const KEYS_UNAVAILABLE = 'Keys cannot be created in the mobile app yet. Add them in the desktop app.'
const SETTINGS_KEY = 'termterm.settings'

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

const DEFAULT_SETTINGS: Settings = { autoLockMinutes: 15, rememberDevice: false, autoCheckUpdates: false }

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>
    const minutes = Number(stored.autoLockMinutes)
    return {
      ...DEFAULT_SETTINGS,
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
      // Unlocking from the Android Keystore (with a fingerprint) comes later.
      deviceKey: {
        available: async () => false,
        save: async () => {
          throw new Error('Not available on this device yet')
        },
        load: async () => null,
        clear: () => undefined,
      },
      keys: {
        generate: () => {
          throw new Error(KEYS_UNAVAILABLE)
        },
        import: () => {
          throw new Error(KEYS_UNAVAILABLE)
        },
      },
      deviceName: () => (Capacitor.getPlatform() === 'android' ? 'Android device' : 'Mobile browser'),
      rememberDevice: () => false,
    },
    (s) => snapshot.emit(s),
    (p) => phase.emit(p),
  )

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

  const updateState: UpdateState = {
    status: 'unsupported',
    reason: 'Install new versions of the mobile app from the releases page.',
  }

  return {
    phase: () => vault.phase(),
    onPhase: phase.on,
    createVault: (password) => vault.create(password),
    signIn: (input) => vault.signIn(input),
    unlock: (password) => vault.unlock(password),
    lock: async () => vault.lock(),
    changePassword: (current, next) => vault.changePassword(current, next),

    settings: async () => settings,
    saveSettings: async (patch) => {
      settings = { ...settings, ...patch, rememberDevice: false, autoCheckUpdates: false }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      return settings
    },
    deviceUnlockAvailable: async () => false,

    snapshot: async () => vault.snapshot(),
    onSnapshot: snapshot.on,

    saveHost: async (id, input) => vault.saveHost(id, input),
    generateKey: (label, type) => vault.generateKey(label, type),
    importKey: (input) => vault.importKey(input),
    renameKey: async (id, label) => vault.renameKey(id, label),
    saveSnippet: async (id, input) => vault.saveSnippet(id, input),
    deleteItem: async (id) => vault.deleteItem(id),

    syncRegister: (input) => vault.syncRegister(input),
    syncReauth: (password) => vault.syncReauth(password),
    syncNow: () => vault.syncNow(),
    syncDisconnect: () => vault.syncDisconnect(),
    syncDevices: () => vault.syncDevices(),
    syncRevokeDevice: (id) => vault.syncRevokeDevice(id),

    sshConnect: async () => {
      throw new Error(SSH_UNAVAILABLE)
    },
    sshWrite: () => undefined,
    sshResize: () => undefined,
    sshClose: () => undefined,
    sshPromptReply: () => undefined,
    onSshData: () => () => undefined,
    onSshStatus: () => () => undefined,
    onSshPrompt: () => () => undefined,

    appInfo: async () => ({
      version: __APP_VERSION__,
      packaged: Capacitor.isNativePlatform(),
      capabilities: { ssh: false, keys: false },
    }),
    updateState: async () => updateState,
    onUpdateState: () => () => undefined,
    updateCheck: async () => updateState,
    updateDownload: async () => undefined,
    updateInstall: async () => undefined,

    clipboardWrite: (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
    clipboardRead: async () => (await navigator.clipboard?.readText().catch(() => '')) ?? '',
  }
}
