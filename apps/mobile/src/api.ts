/**
 * The mobile implementation of the contract the shared interface talks to.
 * On desktop this sits behind Electron IPC in a separate process; here it
 * runs in the same WebView as the interface, on top of the same VaultService.
 */
import { Capacitor } from '@capacitor/core'
import {
  VaultService,
  type AppPhase,
  type SessionStatus,
  type Settings,
  type SshPrompt,
  type TermtermApi,
  type UpdateState,
  type VaultSnapshot,
} from '@termterm/app'
import { BiometricCancelled, biometricKeyStore } from './device-key'
import { createSsh, nativeKeyTools, setTerminalFocus } from './ssh'
import { vaultStorage } from './storage'

declare const __APP_VERSION__: string

// SSH and key handling live in the native Android plugin, so they exist only
// in the installed app, not when this code runs in a desktop browser.
const NATIVE = Capacitor.isNativePlatform()
const SSH_UNAVAILABLE = 'SSH sessions are only available in the installed app'
const KEYS_UNAVAILABLE = 'Keys can only be created in the installed app'
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
      rememberDevice: stored.rememberDevice === true,
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
  const ssh = NATIVE
    ? createSsh(vault, {
        data: (id, data) => sshData.emit(id, data),
        status: (id, status) => sshStatus.emit(id, status),
        prompt: (prompt) => sshPrompt.emit(prompt),
      })
    : null

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
    reason: 'To update, download the new APK from the releases page and install it over this one.',
  }

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
        autoCheckUpdates: false,
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
    saveSnippet: async (id, input) => vault.saveSnippet(id, input),
    deleteItem: async (id) => vault.deleteItem(id),

    syncRegister: (input) => vault.syncRegister(input),
    syncSignIn: (input) => vault.syncSignIn(input),
    syncReauth: (password) => vault.syncReauth(password),
    syncNow: () => vault.syncNow(),
    syncDisconnect: () => vault.syncDisconnect(),
    syncDevices: () => vault.syncDevices(),
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
      capabilities: { ssh: NATIVE, keys: NATIVE, biometricUnlock: true },
    }),
    localShells: async () => [],
    updateState: async () => updateState,
    onUpdateState: () => () => undefined,
    updateCheck: async () => updateState,
    updateDownload: async () => undefined,
    updateInstall: async () => undefined,

    clipboardWrite: (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
    clipboardRead: async () => (await navigator.clipboard?.readText().catch(() => '')) ?? '',
  }
}
