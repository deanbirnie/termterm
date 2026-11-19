import { Cloud, CloudOff, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { Settings, VaultSnapshot, VaultView } from '@termterm/app'
import { api } from './api'
import { MembersDialog } from './Members'
import { ConnectVaultDialog, DisconnectVaultDialog } from './SyncServers'
import { Button, ErrorText, Field, Modal, useAction } from './ui'

/**
 * Which vault is on screen, and the way to another. Every page shows one
 * vault's items only; switching is always a deliberate choice here.
 */
export function VaultBar({
  snapshot,
  onSwitch,
  onManage,
}: {
  snapshot: VaultSnapshot
  onSwitch: (id: string) => void
  onManage: () => void
}) {
  if (!snapshot.multiVault) return null
  return (
    <>
    <div className="vault-bar">
      <label className="vault-pick">
        <span>Vault</span>
        <select aria-label="Vault" value={snapshot.activeVaultId} onChange={(e) => onSwitch(e.target.value)}>
          {snapshot.vaults.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <Button variant="ghost" onClick={onManage}>
        Manage vaults
      </Button>
    </div>
    {snapshot.readOnly && (
      <p className="vault-note" role="note">
        Shared vault: you can connect with its hosts. Only its admins can change them.
      </p>
    )}
    </>
  )
}

/** Asked before a switch that closes tabs (unless the setting keeps them). */
export function SwitchVaultDialog({
  to,
  tabs,
  forwards,
  onCancel,
  onConfirm,
}: {
  to: string
  tabs: number
  forwards: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const what = [
    tabs ? `your ${tabs} open tab${tabs === 1 ? '' : 's'}` : '',
    forwards ? `${forwards} running port forward${forwards === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return (
    <Modal title={`Switch to ${to}?`} onClose={onCancel}>
      <p>Switching vaults closes {what.join(' and stops ')}.</p>
      <p className="muted">
        To keep tabs open when you switch, turn on <strong>Keep tabs open when switching vaults</strong> in Settings, under
        Vaults.
      </p>
      <div className="modal-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onConfirm}>
          Close and switch
        </Button>
      </div>
    </Modal>
  )
}

/** Settings → Vaults: the vaults on this device, and what switching does. */
export function VaultsSettings({ snapshot }: { snapshot: VaultSnapshot }) {
  const [naming, setNaming] = useState<{ vault: VaultView | null } | null>(null)
  const [deleting, setDeleting] = useState<VaultView | null>(null)
  const [connecting, setConnecting] = useState<VaultView | null>(null)
  const [disconnecting, setDisconnecting] = useState<VaultView | null>(null)
  const [membersOf, setMembersOf] = useState<VaultView | null>(null)
  const serverOf = (v: VaultView) => snapshot.servers.find((s) => s.id === v.serverId)
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void api.settings().then(setSettings)
  }, [])
  if (!snapshot.multiVault) return null
  return (
    <section aria-label="Vaults">
      <p className="field-hint">
        Each vault keeps its own hosts, keys, identities, snippets, known hosts and port forwards, and one is shown at a
        time. Nothing in one vault can use or see another. Each vault syncs on its own: the Personal vault from the
        Sync page, others through any sync server account here.
      </p>
      <ul className="vault-list">
        {snapshot.vaults.map((v) => (
          <li key={v.id}>
            <span>
              <strong>{v.name}</strong>
              {v.personal && <span className="muted"> · opened with your master password</span>}
              {serverOf(v) && <span className="muted"> · syncs with {serverOf(v)!.serverUrl.replace(/^https?:\/\//, '')}</span>}
              {(v.members ?? 1) > 1 && <span className="muted"> · shared, {v.members} members</span>}
              {v.role === 'member' && <span className="muted"> · you connect only</span>}
              {v.lost && <span className="muted"> · you no longer have access: it stopped syncing</span>}
              {v.id === snapshot.activeVaultId && <span className="muted"> · shown now</span>}
            </span>
            <span className="vault-actions">
              {v.serverId && (
                <button className="icon-btn" aria-label={`Members of ${v.name}`} title="Members" onClick={() => setMembersOf(v)}>
                  <Users size={15} />
                </button>
              )}
              <button className="icon-btn" aria-label={`Rename ${v.name}`} title="Rename" onClick={() => setNaming({ vault: v })}>
                <Pencil size={15} />
              </button>
              {!v.personal &&
                (v.serverId ? (
                  <button className="icon-btn" aria-label={`Stop syncing ${v.name}`} title="Stop syncing" onClick={() => setDisconnecting(v)}>
                    <CloudOff size={15} />
                  </button>
                ) : (
                  <button className="icon-btn" aria-label={`Sync ${v.name}`} title="Sync" onClick={() => setConnecting(v)}>
                    <Cloud size={15} />
                  </button>
                ))}
              {!v.personal && (
                <button className="icon-btn" aria-label={`Delete ${v.name}`} title="Delete" onClick={() => setDeleting(v)}>
                  <Trash2 size={15} />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <Button onClick={() => setNaming({ vault: null })}>
        <Plus size={15} /> New vault
      </Button>
      {settings && (
        <label className="check">
          <input
            type="checkbox"
            checked={settings.keepTabsOnVaultSwitch}
            onChange={(e) => {
              const patch = { keepTabsOnVaultSwitch: e.target.checked }
              setSettings({ ...settings, ...patch })
              void api.saveSettings(patch).then(setSettings, () => setSettings(settings))
            }}
          />
          Keep tabs open when switching vaults
        </label>
      )}
      <p className="field-hint">
        Off: switching to another vault closes every tab and stops running port forwards, after asking. On: they stay
        open, each still using the vault it was opened from.
      </p>
      {naming && <VaultNameDialog vault={naming.vault} onClose={() => setNaming(null)} />}
      {deleting && <DeleteVaultDialog vault={deleting} onClose={() => setDeleting(null)} />}
      {connecting && <ConnectVaultDialog vault={connecting} servers={snapshot.servers} onClose={() => setConnecting(null)} />}
      {disconnecting && <DisconnectVaultDialog vault={disconnecting} onClose={() => setDisconnecting(null)} />}
      {membersOf && (
        <MembersDialog
          vault={snapshot.vaults.find((v) => v.id === membersOf.id) ?? membersOf}
          snapshot={snapshot}
          onClose={() => setMembersOf(null)}
        />
      )}
    </section>
  )
}

function VaultNameDialog({ vault, onClose }: { vault: VaultView | null; onClose: () => void }) {
  const [name, setName] = useState(vault?.name ?? '')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      if (vault) await api.renameVault(vault.id, name)
      else await api.addVault(name)
      onClose()
    })
  }
  return (
    <Modal title={vault ? `Rename ${vault.name}` : 'New vault'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Vault name" hint={vault ? undefined : 'An empty vault; switch to it to add hosts and keys.'}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </Field>
        <ErrorText error={error} />
        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            {vault ? 'Rename' : 'Create vault'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteVaultDialog({ vault, onClose }: { vault: VaultView; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [fromServer, setFromServer] = useState(false)
  const { busy, error, run } = useAction()
  return (
    <Modal title={`Delete ${vault.name}?`} tone="danger" onClose={onClose}>
      <p>
        Everything in it (hosts, keys, identities, snippets, known hosts and port forwards) is deleted from this device.
        This cannot be undone.
      </p>
      {vault.serverId && (
        <label className="check">
          <input type="checkbox" checked={fromServer} onChange={(e) => setFromServer(e.target.checked)} />
          Also delete it from the sync server, for every device
        </label>
      )}
      <Field label={`Type ${vault.name} to confirm`}>
        <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          disabled={busy || typed.trim() !== vault.name}
          onClick={() =>
            void run(async () => {
              await api.deleteVault(vault.id, { fromServer })
              onClose()
            })
          }
        >
          Delete vault
        </Button>
      </div>
    </Modal>
  )
}
