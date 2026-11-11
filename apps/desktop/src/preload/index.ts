import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { TermtermApi } from '../shared/api'

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const send =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.send(channel, ...args)

const on =
  (channel: string) =>
  (cb: (...args: never[]) => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) =>
      (cb as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }

const api: TermtermApi = {
  phase: invoke('phase'),
  onPhase: on('phase'),
  createVault: invoke('vault:create'),
  signIn: invoke('vault:signIn'),
  unlock: invoke('vault:unlock'),
  lock: invoke('vault:lock'),
  snapshot: invoke('vault:snapshot'),
  onSnapshot: on('vault:snapshot'),
  saveHost: invoke('host:save'),
  generateKey: invoke('key:generate'),
  importKey: invoke('key:import'),
  renameKey: invoke('key:rename'),
  saveSnippet: invoke('snippet:save'),
  deleteItem: invoke('item:delete'),
  syncRegister: invoke('sync:register'),
  syncReauth: invoke('sync:reauth'),
  syncNow: invoke('sync:now'),
  syncDisconnect: invoke('sync:disconnect'),
  sshConnect: invoke('ssh:connect'),
  sshWrite: send('ssh:write'),
  sshResize: send('ssh:resize'),
  sshClose: send('ssh:close'),
  sshPromptReply: send('ssh:promptReply'),
  onSshData: on('ssh:data'),
  onSshStatus: on('ssh:status'),
  onSshPrompt: on('ssh:prompt'),
  clipboardWrite: send('clipboard:write'),
  clipboardRead: invoke('clipboard:read'),
}

contextBridge.exposeInMainWorld('termterm', api)
