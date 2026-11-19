import { Cloud, LogOut, Plus, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { RemoteVaultView, ServerView, VaultSnapshot, VaultView } from '@termterm/app'
import { api } from './api'
import { Button, ErrorText, Field, InsecureUrlHint, Modal, PasswordInput, useAction } from './ui'

const serverName = (s: ServerView) => `${s.username} on ${s.serverUrl.replace(/^https?:\/\//, '')}`

/**
 * Sync page: every sync server account this device uses, with the vaults that
 * sync through each. Vaults are connected to a server in Settings → Vaults.
 */
export function SyncServers({ snapshot }: { snapshot: VaultSnapshot }) {
  const [adding, setAdding] = useState(false)
  const [browsing, setBrowsing] = useState<ServerView | null>(null)
  if (!snapshot.multiVault) return null
  const name = (id: string) => snapshot.vaults.find((v) => v.id === id)?.name ?? id
  return (
    <section aria-label="Servers and their vaults">
      <h2 className="section-title spaced">Sync servers</h2>
      {snapshot.servers.length === 0 ? (
        <p className="muted">No vault on this device syncs yet.</p>
      ) : (
        <ul className="vault-list server-list">
          {snapshot.servers.map((s) => (
            <li key={s.id} aria-label={serverName(s)}>
              <div className="server-head">
                <span>
                  <strong>{s.username}</strong> <span className="muted">{s.serverUrl}</span>
                  {s.personal && <span className="muted"> · the Personal vault’s account</span>}
                </span>
                <span className="vault-actions">
                  <Button variant="ghost" onClick={() => setBrowsing(s)} disabled={s.needsSignIn}>
                    Add vaults…
                  </Button>
                  {!s.personal && <RemoveServer server={s} />}
                </span>
              </div>
              <div className="server-vaults">
                {s.vaultIds.length ? (
                  s.vaultIds.map((id) => (
                    <span key={id} className="chip">
                      <Cloud size={12} /> {name(id)}
                    </span>
                  ))
                ) : (
                  <span className="muted">No vaults on this device sync here.</span>
                )}
              </div>
              {s.insecure && (
                <p className="field-hint">Plain HTTP: your sign-in can be read on the network.</p>
              )}
              {s.error && !s.needsSignIn && <ErrorText error={s.error} />}
              {s.needsSignIn && !s.personal && <ServerSignIn server={s} />}
              {s.needsSignIn && s.personal && (
                <p className="field-hint">Sign in again above, with the master password.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button onClick={() => setAdding(true)}>
        <Plus size={15} /> Add a sync server
      </Button>
      <p className="field-hint">
        A further server has its own account, with its own username and password (not your master password). Use it
        for vaults that must not be on the Personal vault’s server.
      </p>
      {adding && <AddServerDialog onClose={() => setAdding(false)} />}
      {browsing && <ServerVaultsDialog server={browsing} onClose={() => setBrowsing(null)} />}
    </section>
  )
}

function RemoveServer({ server }: { server: ServerView }) {
  const [confirm, setConfirm] = useState(false)
  const { busy, error, run } = useAction()
  if (!confirm) {
    return (
      <button className="icon-btn" aria-label={`Sign out of ${serverName(server)}`} title="Sign out" onClick={() => setConfirm(true)}>
        <LogOut size={15} />
      </button>
    )
  }
  return (
    <Modal title={`Sign out of ${serverName(server)}?`} onClose={() => setConfirm(false)}>
      <p>
        Its vaults stay on this device but stop syncing. Their copies on the server, and other devices, are not changed.
      </p>
      <ErrorText error={error} />
      <div className="modal-actions">
        <Button onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={() => void run(() => api.removeServer(server.id))}>
          Sign out
        </Button>
      </div>
    </Modal>
  )
}

function ServerSignIn({ server }: { server: ServerView }) {
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void run(() => api.serverSignIn(server.id, password)).then((ok) => ok && setPassword(''))
      }}
    >
      <ErrorText error={server.error ?? null} />
      <Field label={`Password for ${server.username}`}>
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      <Button variant="primary" type="submit" disabled={busy || !password}>
        Sign in again
      </Button>
    </form>
  )
}

function AddServerDialog({ onClose }: { onClose: () => void }) {
  const [create, setCreate] = useState(false)
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api.addServer({ serverUrl, username, password, create })
      onClose()
    })
  }
  return (
    <Modal title="Add a sync server" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={!create} onClick={() => setCreate(false)}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={create} onClick={() => setCreate(true)}>
            Create account
          </button>
        </div>
        <Field label="Sync server">
          <input autoFocus placeholder="https://sync.example.com" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        </Field>
        <InsecureUrlHint url={serverUrl} />
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field
          label={create ? 'New password for this account' : 'Password'}
          hint="This account’s own password, not your master password. It is not sent to the server, and this device does not keep it."
        >
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {!create && (
          <p className="warning">
            <TriangleAlert size={16} />
            <span>
              Signing in lets this device add every vault the account holds: their hosts, passwords and keys come onto
              this device. Only sign in on devices you trust.
            </span>
          </p>
        )}
        <ErrorText error={error} />
        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !serverUrl || !username || !password}>
            {busy ? 'Working…' : create ? 'Create account' : 'Sign in'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** The account's vaults on its server, to add to this device. */
function ServerVaultsDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const [vaults, setVaults] = useState<RemoteVaultView[] | null>(null)
  const { busy, error, run } = useAction()
  const load = () => run(async () => setVaults(await api.serverVaults(server.id)))
  useEffect(() => {
    void load()
  }, [server.id])
  return (
    <Modal title={`Vaults of ${serverName(server)}`} onClose={onClose}>
      <p className="warning">
        <TriangleAlert size={16} />
        <span>Adding a vault puts its hosts, passwords and keys on this device, and keeps it in step from then on.</span>
      </p>
      {vaults && vaults.length === 0 && <p className="muted">This account has no vaults besides the Personal one.</p>}
      {vaults && vaults.length > 0 && (
        <ul className="vault-list">
          {vaults.map((v) => (
            <li key={v.id}>
              <strong>{v.name}</strong>
              {v.onDevice ? (
                <span className="muted">On this device</span>
              ) : (
                <Button disabled={busy} onClick={() => void run(async () => {
                  await api.addServerVault(server.id, v.id)
                  setVaults(await api.serverVaults(server.id))
                })}>
                  Add {v.name}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
      <div className="modal-actions">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  )
}

/** Settings → Vaults: start syncing a vault through one of the server accounts. */
export function ConnectVaultDialog({
  vault,
  servers,
  onClose,
}: {
  vault: VaultView
  servers: ServerView[]
  onClose: () => void
}) {
  const [serverId, setServerId] = useState(servers[0]?.id ?? '')
  const { busy, error, run } = useAction()
  const server = servers.find((s) => s.id === serverId)
  return (
    <Modal title={`Sync ${vault.name}`} onClose={onClose}>
      {servers.length === 0 ? (
        <p>
          This device has no sync server yet. Turn on sync for the Personal vault, or add a sync server, on the Sync page.
        </p>
      ) : (
        <>
          <Field label="Sync server">
            <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {serverName(s)}
                  {s.personal ? ' (Personal vault’s account)' : ''}
                </option>
              ))}
            </select>
          </Field>
          {server && (
            <p className="warning">
              <TriangleAlert size={16} />
              <span>
                Everything in {vault.name} is copied, encrypted, to {server.serverUrl}. Every device signed in to the
                account <strong>{server.username}</strong> there can then add this vault, with its hosts, passwords and
                keys.
              </span>
            </p>
          )}
        </>
      )}
      <ErrorText error={error} />
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        {servers.length > 0 && (
          <Button
            variant="primary"
            disabled={busy || !server}
            onClick={() =>
              void run(async () => {
                await api.connectVault(vault.id, serverId)
                onClose()
              })
            }
          >
            {busy ? 'Working…' : 'Copy to server and sync'}
          </Button>
        )}
      </div>
    </Modal>
  )
}

/** Settings → Vaults: stop syncing a vault, keeping or deleting the server's copy. */
export function DisconnectVaultDialog({ vault, onClose }: { vault: VaultView; onClose: () => void }) {
  const [fromServer, setFromServer] = useState(false)
  const { busy, error, run } = useAction()
  return (
    <Modal title={`Stop syncing ${vault.name}?`} tone={fromServer ? 'danger' : undefined} onClose={onClose}>
      <p>The vault stays on this device. Changes made here no longer reach the server.</p>
      <label className="check">
        <input type="checkbox" checked={fromServer} onChange={(e) => setFromServer(e.target.checked)} />
        Also delete it from the server, for every device
      </label>
      {fromServer && (
        <p className="field-hint">Other devices keep their copies, but they no longer stay in step.</p>
      )}
      <ErrorText error={error} />
      <div className="modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant={fromServer ? 'danger' : 'primary'}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.disconnectVault(vault.id, { fromServer })
              onClose()
            })
          }
        >
          Stop syncing
        </Button>
      </div>
    </Modal>
  )
}
