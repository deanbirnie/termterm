import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { Settings, VaultSnapshot, VaultView } from '@termterm/app'
import { api } from './api'
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
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void api.settings().then(setSettings)
  }, [])
  if (!snapshot.multiVault) return null
  return (
    <section aria-label="Vaults">
      <p className="field-hint">
        Each vault keeps its own hosts, keys, identities, snippets, known hosts and port forwards, and one is shown at a
        time. Nothing in one vault can use or see another. Only the Personal vault syncs for now.
      </p>
      <ul className="vault-list">
        {snapshot.vaults.map((v) => (
          <li key={v.id}>
            <span>
              <strong>{v.name}</strong>
              {v.personal && <span className="muted"> · opened with your master password; syncs</span>}
              {v.id === snapshot.activeVaultId && <span className="muted"> · shown now</span>}
            </span>
            <span className="vault-actions">
              <button className="icon-btn" aria-label={`Rename ${v.name}`} title="Rename" onClick={() => setNaming({ vault: v })}>
                <Pencil size={15} />
              </button>
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
  const { busy, error, run } = useAction()
  return (
    <Modal title={`Delete ${vault.name}?`} tone="danger" onClose={onClose}>
      <p>
        Everything in it (hosts, keys, identities, snippets, known hosts and port forwards) is deleted from this device.
        This cannot be undone.
      </p>
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
              await api.deleteVault(vault.id)
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
