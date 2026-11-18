import { homedir, hostname } from 'node:os'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, powerMonitor, shell } from 'electron'
import type { ConnectTarget, Settings } from '@termterm/app'
import type { DeviceKeyStore as DeviceKeyStorage } from '@termterm/app'
import { DeviceKeyStore } from './device-key'
import { HelloKeyStore } from './hello-key-store'
import { keyTools } from './keys'
import { SettingsStore } from './settings'
import { LocalTerminals } from './local-terminal'
import { pickShell } from './local-shells'
import { SshManager } from './ssh'
import { readSshFiles } from './ssh-files'
import { Prompts } from './ssh-connect'
import { ForwardManager } from './forwards'
import { FileSessions } from './files'
import { FileVaultStorage } from './storage'
import { Updater } from './updater'
import { fakeHelloSigner } from './fake-hello'
import { windowsHelloSigner } from './windows-hello'
import { VaultService } from '@termterm/app'

if (process.env.TERMTERM_DATA_DIR) app.setPath('userData', process.env.TERMTERM_DATA_DIR)

const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
let win: BrowserWindow | null = null

const emit = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#11151c',
    title: 'termterm',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))

  // The window only ever shows our own UI: no popups, no navigation.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })

  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  // Where the vault key is kept for unlocking without the master password.
  // With Windows Hello set up, it is locked behind Hello (face, fingerprint or
  // PIN) and asked for on the lock screen. Otherwise it is the operating
  // system's credential store, used silently at launch ("open unlocked").
  const silentKey = new DeviceKeyStore(join(app.getPath('userData'), 'device-key.bin'))
  // Automated tests stand in for Windows Hello. Never honoured by a packaged app.
  const fakeHello = !app.isPackaged && process.env.TERMTERM_FAKE_HELLO === '1'
  const helloKey = new HelloKeyStore(
    join(app.getPath('userData'), 'hello-key.json'),
    fakeHello ? fakeHelloSigner(app.getPath('userData')) : windowsHelloSigner,
  )
  let useHello = false
  /** Settles once it is known whether Windows Hello is set up. */
  const helloReady: Promise<void> = app
    .whenReady()
    .then(() => (process.platform === 'win32' || fakeHello ? helloKey.available() : false))
    .then((available) => {
      useHello = available
      // A silently usable copy would get round Windows Hello, so none may remain.
      if (useHello) silentKey.clear()
    })
  const deviceKey: DeviceKeyStorage = {
    get userPresence() {
      return useHello
    },
    available: () => (useHello ? helloKey.available() : silentKey.available()),
    has: async () => (useHello ? helloKey.has() : silentKey.has()),
    save: (key) => (useHello ? helloKey.save(key) : silentKey.save(key)),
    load: () => (useHello ? helloKey.load() : silentKey.load()),
    clear: () => (useHello ? helloKey.clear() : silentKey.clear()),
  }
  const vault = new VaultService(
    {
      storage: new FileVaultStorage(join(app.getPath('userData'), 'vault.json')),
      deviceKey,
      keys: keyTools,
      deviceName: hostname,
      rememberDevice: () => settings.get().rememberDevice,
    },
    (snapshot) => emit('vault:snapshot', snapshot),
    (phase) => {
      emit('phase', phase)
      // Forwards marked to start by themselves, whenever the vault is opened.
      if (phase === 'unlocked') {
        for (const f of vault.snapshot().forwards) {
          if (f.autoStart && !forwards.isRunning(f.id)) void forwards.start(f.id).catch(() => undefined)
        }
      }
    },
  )
  // Shells on this computer. They report through the same events as SSH
  // sessions, so the interface handles both the same way.
  const local = new LocalTerminals({
    data: (id, data) => emit('ssh:data', id, data),
    status: (id, status) => emit('ssh:status', id, status),
  })
  // Questions for the user (host keys, passwords) from terminals, forwards and file browsing.
  const prompts = new Prompts((prompt) => emit('ssh:prompt', prompt))
  const ssh = new SshManager(vault, prompts, {
    data: (id, data) => emit('ssh:data', id, data),
    status: (id, status) => emit('ssh:status', id, status),
  })
  const forwards = new ForwardManager(vault, prompts, (id, state) => emit('forward:state', id, state))
  const files = new FileSessions(vault, prompts, (t) => emit('files:transfer', t))

  const updater = new Updater((state) => emit('update:state', state))

  /** Only our own top-level page may talk to the main process. */
  const trusted = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame

  const handle = (channel: string, fn: (...args: never[]) => unknown) =>
    ipcMain.handle(channel, async (e, ...args) => {
      if (!trusted(e)) throw new Error('Forbidden')
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        // Strip stack traces and Electron's wrapper text; the UI shows this message.
        throw new Error((err as Error).message)
      }
    })
  const listen = (channel: string, fn: (...args: never[]) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (trusted(e)) (fn as (...a: unknown[]) => void)(...args)
    })

  handle('phase', () => vault.phase())
  handle('vault:create', (password: string) => vault.create(password))
  handle('vault:signIn', (input) => vault.signIn(input))
  handle('vault:unlock', (password: string) => vault.unlock(password))
  // Locking wipes the vault key but leaves established SSH sessions running;
  // they no longer need the vault, and the UI hides them until it is unlocked.
  handle('vault:biometricAvailable', async () => {
    await helloReady
    return vault.canUnlockWithDevice()
  })
  handle('vault:biometricUnlock', () => vault.unlockWithDevice())
  handle('vault:lock', () => vault.lock())
  handle('vault:changePassword', (current: string, next: string) =>
    vault.changePassword(current, next),
  )
  handle('settings:get', () => settings.get())
  handle('settings:save', async (input: Partial<Settings>) => {
    await helloReady
    if (input?.rememberDevice && !(await deviceKey.available())) {
      throw new Error('No secure credential store is available on this device')
    }
    const before = settings.get()
    const saved = settings.save(input)
    if (saved.rememberDevice === before.rememberDevice) return saved
    try {
      // With Windows Hello, turning this on asks for Hello before storing the key.
      await vault.applyRememberDevice()
    } catch (err) {
      settings.save(before)
      if ((err as Error).message === 'Cancelled') return settings.get()
      throw err
    }
    return saved
  })
  handle('settings:deviceUnlockAvailable', async () => {
    await helloReady
    return deviceKey.available()
  })
  handle('sync:devices', () => vault.syncDevices())
  handle('sync:usage', () => vault.syncUsage())
  handle('sync:revokeDevice', (id: string) => vault.syncRevokeDevice(id))
  handle('vault:snapshot', () => vault.snapshot())
  handle('host:save', (id: string | null, input) => vault.saveHost(id, input))
  handle('key:generate', (label: string, type: 'ed25519' | 'rsa') => vault.generateKey(label, type))
  handle('key:import', (input) => vault.importKey(input))
  handle('key:rename', (id: string, label: string) => vault.renameKey(id, label))
  handle('snippet:save', (id: string | null, input) => vault.saveSnippet(id, input))
  // Export files. The tests stand in a fixed path for the file pickers, which
  // they cannot click; installed builds ignore it.
  const testFile = app.isPackaged ? undefined : process.env.TERMTERM_TEST_FILE
  const exportFilters = [{ name: 'termterm export', extensions: ['termterm'] }]
  handle('vault:export', async (password: string) => {
    const { text } = await vault.exportVault(password)
    const day = new Date().toISOString().slice(0, 10)
    const path =
      testFile ??
      (await dialog.showSaveDialog(win!, {
        title: 'Save encrypted export',
        defaultPath: join(app.getPath('documents'), `termterm-export-${day}.termterm`),
        filters: exportFilters,
      })).filePath
    if (!path) return false
    await writeFile(path, text, { mode: 0o600 })
    return true
  })
  handle('vault:pickExport', async () => {
    const path =
      testFile ??
      (await dialog.showOpenDialog(win!, {
        title: 'Import an export file',
        properties: ['openFile'],
        filters: [...exportFilters, { name: 'All files', extensions: ['*'] }],
      })).filePaths[0]
    if (!path) return null
    if ((await stat(path)).size > 50 * 1024 * 1024) throw new Error('That file is too large to be a termterm export')
    return { name: basename(path), text: await readFile(path, 'utf8') }
  })
  handle('vault:import', (text: string, password: string) => vault.importVault(text, password))
  // Session logs. The tests name a folder to save into instead of the dialog.
  const testSaveDir = app.isPackaged ? undefined : process.env.TERMTERM_TEST_SAVE_DIR
  handle('file:saveText', async (name: string, text: string) => {
    const safeName = basename(String(name)) || 'session.log'
    const path = testSaveDir
      ? join(testSaveDir, safeName)
      : (await dialog.showSaveDialog(win!, {
          title: 'Save session log',
          defaultPath: join(app.getPath('documents'), safeName),
          filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
        })).filePath
    if (!path) return false
    await writeFile(path, String(text), { mode: 0o600 })
    return true
  })
  handle('identity:save', (id: string | null, input) => vault.saveIdentity(id, input))
  handle('group:rename', (from: string, to: string) => vault.renameGroup(from, to))
  // Tests point this at a folder of their own; an installed app always reads ~/.ssh.
  const sshDir = (!app.isPackaged && process.env.TERMTERM_SSH_DIR) || join(homedir(), '.ssh')
  handle('ssh-import:scan', async (paste?: { config?: string; knownHosts?: string }) =>
    vault.scanSshImport(
      paste
        ? { source: 'pasted text', config: paste.config, knownHosts: paste.knownHosts }
        : await readSshFiles(sshDir),
    ),
  )
  handle('ssh-import:apply', (aliases: string[], knownHosts: boolean) =>
    vault.applySshImport(Array.isArray(aliases) ? aliases.map(String) : [], knownHosts === true),
  )
  handle('forward:save', (id: string | null, input) => vault.saveForward(id, input))
  handle('forward:start', (id: string) => forwards.start(String(id)))
  handle('forward:stop', (id: string) => forwards.stop(String(id)))
  handle('forward:states', () => forwards.all())
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !v) throw new Error(`${name} is required`)
    return v
  }
  handle('sftp:open', (id: string, target: ConnectTarget) => files.open(text(id, 'Session'), target))
  handle('sftp:list', (id: string, path: string) => files.list(id, text(path, 'Path')))
  handle('sftp:mkdir', (id: string, path: string) => files.mkdir(id, text(path, 'Path')))
  handle('sftp:rename', (id: string, from: string, to: string) => files.rename(id, text(from, 'Path'), text(to, 'Path')))
  handle('sftp:delete', (id: string, path: string) => files.delete(id, text(path, 'Path')))
  handle('sftp:chmod', (id: string, path: string, mode: number) => files.chmod(id, text(path, 'Path'), Number(mode)))
  handle('sftp:readText', (id: string, path: string) => files.readText(id, text(path, 'Path')))
  handle('sftp:writeText', (id: string, path: string, body: string, expected?: { modified: number; size: number }) =>
    files.writeText(id, text(path, 'Path'), String(body), expected ? { modified: Number(expected.modified), size: Number(expected.size) } : undefined),
  )
  listen('sftp:close', (id: string) => files.close(String(id)))
  handle('local:list', (path: string | null) => files.localList(typeof path === 'string' ? path : null))
  handle('local:mkdir', (path: string) => files.localMkdir(text(path, 'Path')))
  handle('local:rename', (from: string, to: string) => files.localRename(text(from, 'Path'), text(to, 'Path')))
  handle('local:delete', (path: string) => files.localDelete(text(path, 'Path')))
  handle('files:transfer', (id: string, direction: string, paths: string[], toFolder: string) => {
    if (direction !== 'upload' && direction !== 'download') throw new Error('Unknown direction')
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p)) throw new Error('Paths are required')
    return files.transfer(id, direction, paths, text(toFolder, 'Folder'))
  })
  handle('history:get', (key: string) => vault.commandHistory(key))
  handle('history:record', (key: string, commands: string[]) => vault.recordCommands(key, commands))
  handle('history:clear', () => vault.clearCommandHistory())
  handle('item:delete', (id: string) => {
    // A deleted forward, or one whose host is deleted, stops running too.
    for (const f of vault.snapshot().forwards) if (f.id === id || f.hostId === id) forwards.stop(f.id)
    vault.deleteItem(id)
  })
  handle('sync:register', (input) => vault.syncRegister(input))
  handle('sync:signIn', (input) => vault.syncSignIn(input))
  handle('sync:reauth', (password: string) => vault.syncReauth(password))
  handle('sync:now', () => vault.syncNow())
  handle('sync:disconnect', () => vault.syncDisconnect())
  handle('sync:dismissRollback', () => vault.syncDismissRollback())
  handle('sync:deleteAccount', (password: string) => vault.syncDeleteAccount(password))
  handle('ssh:connect', (id: string, target: ConnectTarget, cols: number, rows: number) => {
    if (target && 'local' in target) {
      const shell = typeof target.local === 'string' ? target.local : settings.get().defaultShell
      return local.start(String(id), shell, Number(cols) || 80, Number(rows) || 24)
    }
    return ssh.connect(String(id), target, Number(cols) || 80, Number(rows) || 24)
  })
  handle('terminal:shells', () => {
    const shells = local.list()
    const first = pickShell(shells, settings.get().defaultShell)
    // The default first, then the rest in the order they were found.
    return [first, ...shells.filter((s) => s !== first)]
      .filter((s) => s !== undefined)
      .map(({ id, name }) => ({ id, name }))
  })
  handle('app:info', async () => {
    await helloReady
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: 'desktop' as const,
      capabilities: {
        ssh: true,
        keys: true,
        biometricUnlock: useHello,
        biometricName: useHello ? 'Windows Hello' : undefined,
        localTerminal: true,
        sshFiles: true,
        forwards: true,
        sftp: true,
      },
    }
  })
  handle('update:state', () => updater.get())
  handle('update:check', () => updater.check())
  handle('update:download', () => updater.download())
  handle('update:install', async () => {
    ssh.closeAll()
    local.closeAll()
    forwards.stopAll()
    files.closeAll()
    vault.lock({ forget: false })
    await vault.flush()
    updater.install()
  })
  handle('clipboard:read', () => clipboard.readText())
  listen('ssh:write', (id: string, data: string) => {
    if (local.has(id)) local.write(id, String(data))
    else ssh.write(id, String(data))
  })
  listen('ssh:resize', (id: string, cols: number, rows: number) => {
    if (!(cols > 0 && rows > 0)) return
    if (local.has(id)) local.resize(id, Math.floor(cols), Math.floor(rows))
    else ssh.resize(id, Math.floor(cols), Math.floor(rows))
  })
  listen('ssh:close', (id: string) => {
    local.close(id)
    ssh.close(id)
  })
  listen('ssh:promptReply', (promptId: string, reply) => prompts.reply(promptId, reply))
  listen('clipboard:write', (text: string) => clipboard.writeText(String(text)))

  void app.whenReady().then(async () => {
    // macOS needs the default menu for standard edit shortcuts.
    if (!devUrl && process.platform !== 'darwin') Menu.setApplicationMenu(null)
    await helloReady
    await vault.tryDeviceUnlock() // does nothing with Windows Hello: the lock screen asks instead
    createWindow()

    // Auto-lock: after a period without keyboard or mouse input anywhere on the
    // system, and whenever the machine sleeps or its screen is locked.
    const autoLock = () => {
      if (settings.get().autoLockMinutes > 0) vault.lock()
    }
    powerMonitor.on('suspend', autoLock)
    powerMonitor.on('lock-screen', autoLock)
    setInterval(() => {
      const minutes = settings.get().autoLockMinutes
      if (minutes > 0 && vault.unlocked && powerMonitor.getSystemIdleTime() >= minutes * 60) {
        vault.lock()
      }
    }, 15_000).unref()

    // The background check must not disturb anything the user already started.
    if (settings.get().autoCheckUpdates) {
      setTimeout(() => {
        if (updater.get().status === 'idle') void updater.check()
      }, 5_000).unref()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    ssh.closeAll()
    local.closeAll()
    forwards.stopAll()
    files.closeAll()
    vault.lock({ forget: false })
    // Let the last save reach the disk before the process goes away.
    void vault.flush().finally(() => app.quit())
  })
}
