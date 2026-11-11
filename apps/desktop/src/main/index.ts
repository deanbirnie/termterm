import { join } from 'node:path'
import { BrowserWindow, Menu, app, clipboard, ipcMain, shell } from 'electron'
import type { ConnectTarget } from '../shared/api'
import { SshManager } from './ssh'
import { VaultService } from './vault-service'

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

  const vault = new VaultService(
    join(app.getPath('userData'), 'vault.json'),
    (snapshot) => emit('vault:snapshot', snapshot),
    (phase) => emit('phase', phase),
  )
  const ssh = new SshManager(vault, {
    data: (id, data) => emit('ssh:data', id, data),
    status: (id, status) => emit('ssh:status', id, status),
    prompt: (prompt) => emit('ssh:prompt', prompt),
  })

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
  handle('vault:lock', () => {
    ssh.closeAll()
    vault.lock()
  })
  handle('vault:snapshot', () => vault.snapshot())
  handle('host:save', (id: string | null, input) => vault.saveHost(id, input))
  handle('key:generate', (label: string, type: 'ed25519' | 'rsa') => vault.generateKey(label, type))
  handle('key:import', (input) => vault.importKey(input))
  handle('key:rename', (id: string, label: string) => vault.renameKey(id, label))
  handle('snippet:save', (id: string | null, input) => vault.saveSnippet(id, input))
  handle('item:delete', (id: string) => vault.deleteItem(id))
  handle('sync:register', (input) => vault.syncRegister(input))
  handle('sync:reauth', (password: string) => vault.syncReauth(password))
  handle('sync:now', () => vault.syncNow())
  handle('sync:disconnect', () => vault.syncDisconnect())
  handle('ssh:connect', (id: string, target: ConnectTarget, cols: number, rows: number) =>
    ssh.connect(String(id), target, Number(cols) || 80, Number(rows) || 24),
  )
  handle('clipboard:read', () => clipboard.readText())
  listen('ssh:write', (id: string, data: string) => ssh.write(id, String(data)))
  listen('ssh:resize', (id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) ssh.resize(id, Math.floor(cols), Math.floor(rows))
  })
  listen('ssh:close', (id: string) => ssh.close(id))
  listen('ssh:promptReply', (promptId: string, reply) => ssh.promptReply(promptId, reply))
  listen('clipboard:write', (text: string) => clipboard.writeText(String(text)))

  void app.whenReady().then(() => {
    // macOS needs the default menu for standard edit shortcuts.
    if (!devUrl && process.platform !== 'darwin') Menu.setApplicationMenu(null)
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    ssh.closeAll()
    vault.lock()
    app.quit()
  })
}
