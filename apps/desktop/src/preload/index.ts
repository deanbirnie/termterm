import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { TermtermApi } from '@termterm/app'

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
  addVault: invoke('vault:add'),
  addServer: invoke('server:add'),
  removeServer: invoke('server:remove'),
  serverSignIn: invoke('server:signIn'),
  serverVaults: invoke('server:vaults'),
  addServerVault: invoke('server:addVault'),
  connectVault: invoke('vault:connect'),
  disconnectVault: invoke('vault:disconnect'),
  vaultMembers: invoke('members:list'),
  lookupMember: invoke('members:lookup'),
  addMember: invoke('members:add'),
  setMemberRole: invoke('members:role'),
  removeMember: invoke('members:remove'),
  generateMemberKey: invoke('memberKey:generate'),
  importMemberKey: invoke('memberKey:import'),
  setMemberKeyCertificate: invoke('memberKey:certificate'),
  removeMemberKey: invoke('memberKey:remove'),
  signIn: invoke('vault:signIn'),
  unlock: invoke('vault:unlock'),
  biometricUnlockAvailable: invoke('vault:biometricAvailable'),
  biometricUnlock: invoke('vault:biometricUnlock'),
  lock: invoke('vault:lock'),
  changePassword: invoke('vault:changePassword'),
  settings: invoke('settings:get'),
  saveSettings: invoke('settings:save'),
  deviceUnlockAvailable: invoke('settings:deviceUnlockAvailable'),
  snapshot: invoke('vault:snapshot'),
  onSnapshot: on('vault:snapshot'),
  saveHost: invoke('host:save'),
  generateKey: invoke('key:generate'),
  importKey: invoke('key:import'),
  renameKey: invoke('key:rename'),
  createVault: invoke('vault:create'),
  renameVault: invoke('vault:rename'),
  deleteVault: invoke('vault:delete'),
  switchVault: invoke('vault:switch'),
  setKeyCertificate: invoke('key:certificate'),
  saveSnippet: invoke('snippet:save'),
  saveIdentity: invoke('identity:save'),
  vaultExport: invoke('vault:export'),
  pickExportFile: invoke('vault:pickExport'),
  vaultImport: invoke('vault:import'),
  saveTextFile: invoke('file:saveText'),
  renameGroup: invoke('group:rename'),
  saveForward: invoke('forward:save'),
  forwardStart: invoke('forward:start'),
  forwardStop: invoke('forward:stop'),
  forwardStates: invoke('forward:states'),
  onForwardState: on('forward:state'),
  sftpOpen: invoke('sftp:open'),
  sftpList: invoke('sftp:list'),
  sftpMkdir: invoke('sftp:mkdir'),
  sftpRename: invoke('sftp:rename'),
  sftpDelete: invoke('sftp:delete'),
  sftpChmod: invoke('sftp:chmod'),
  sftpReadText: invoke('sftp:readText'),
  sftpWriteText: invoke('sftp:writeText'),
  sftpClose: send('sftp:close'),
  localList: invoke('local:list'),
  localMkdir: invoke('local:mkdir'),
  localRename: invoke('local:rename'),
  localDelete: invoke('local:delete'),
  transfer: invoke('files:transfer'),
  onTransfer: on('files:transfer'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  sshImportScan: invoke('ssh-import:scan'),
  sshImportApply: invoke('ssh-import:apply'),
  commandHistory: invoke('history:get'),
  recordCommands: invoke('history:record'),
  clearCommandHistory: invoke('history:clear'),
  deleteItem: invoke('item:delete'),
  syncRegister: invoke('sync:register'),
  syncSignIn: invoke('sync:signIn'),
  syncReauth: invoke('sync:reauth'),
  syncNow: invoke('sync:now'),
  syncDisconnect: invoke('sync:disconnect'),
  syncDeleteAccount: invoke('sync:deleteAccount'),
  syncDismissRollback: invoke('sync:dismissRollback'),
  syncDevices: invoke('sync:devices'),
  syncUsage: invoke('sync:usage'),
  syncRevokeDevice: invoke('sync:revokeDevice'),
  sshConnect: invoke('ssh:connect'),
  sshWrite: send('ssh:write'),
  sshResize: send('ssh:resize'),
  sshClose: send('ssh:close'),
  sshPromptReply: send('ssh:promptReply'),
  terminalFocus: () => undefined, // a physical keyboard has nothing to switch
  onSshData: on('ssh:data'),
  onSshStatus: on('ssh:status'),
  onSshPrompt: on('ssh:prompt'),
  appInfo: invoke('app:info'),
  localShells: invoke('terminal:shells'),
  updateState: invoke('update:state'),
  onUpdateState: on('update:state'),
  updateCheck: invoke('update:check'),
  updateDownload: invoke('update:download'),
  updateInstall: invoke('update:install'),
  clipboardWrite: send('clipboard:write'),
  clipboardRead: invoke('clipboard:read'),
}

contextBridge.exposeInMainWorld('termterm', api)
