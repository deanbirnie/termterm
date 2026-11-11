import { CloudOff, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { DeviceView, SyncStatus } from '../../../shared/api'
import { api } from '../api'
import { Button, ErrorText, Field, useAction } from '../ui'

export function SyncPage({ sync }: { sync: SyncStatus }) {
  return (
    <div className="split-main narrow-page">
      <h2 className="section-title">Sync</h2>
      {sync.configured ? <Connected sync={sync} /> : <Setup />}
      {sync.configured && !sync.needsSignIn && <Devices lastSyncAt={sync.lastSyncAt} />}
      <p className="note">
        <ShieldCheck size={16} />
        <span>
          Your vault is encrypted on this device before it is uploaded. The sync server stores
          only ciphertext and never receives your master password, so whoever runs it cannot
          read your hosts, passwords or keys.
        </span>
      </p>
    </div>
  )
}

function Setup() {
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(() => api.syncRegister({ serverUrl, username, password }))
  }
  return (
    <form className="form-card" onSubmit={submit}>
      <p className="muted">
        Create an account on your termterm sync server to keep this vault in step across your
        devices. On your other devices choose “I already have one” when the app first starts.
      </p>
      <Field label="Sync server">
        <input placeholder="https://sync.example.com" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
      </Field>
      <Field label="Username">
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label="Master password" hint="Confirms it is you. It is not sent to the server.">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      <Button variant="primary" type="submit" disabled={busy || !serverUrl || !username || !password}>
        {busy ? 'Setting up…' : 'Create account and sync'}
      </Button>
    </form>
  )
}

function Connected({ sync }: { sync: SyncStatus }) {
  const [password, setPassword] = useState('')
  const [confirmOff, setConfirmOff] = useState(false)
  const { busy, error, run } = useAction()
  const last = sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'Never'
  return (
    <div className="form-card">
      <dl className="facts">
        <dt>Server</dt>
        <dd>{sync.serverUrl}</dd>
        <dt>Account</dt>
        <dd>{sync.username}</dd>
        <dt>Status</dt>
        <dd>
          {sync.state === 'syncing'
            ? 'Syncing…'
            : sync.state === 'error'
              ? 'Not syncing'
              : sync.pending
                ? `${sync.pending} change${sync.pending > 1 ? 's' : ''} waiting`
                : 'Up to date'}
        </dd>
        <dt>Last synced</dt>
        <dd>{last}</dd>
      </dl>
      {sync.insecure && (
        <p className="warning">
          <TriangleAlert size={16} />
          <span>
            This server uses plain HTTP. Your vault contents stay encrypted, but your sign-in can
            be intercepted on the network. Put the server behind HTTPS.
          </span>
        </p>
      )}
      {sync.state === 'error' && !error && <ErrorText error={sync.error ?? 'Sync failed'} />}
      {sync.needsSignIn && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => api.syncReauth(password)).then((ok) => ok && setPassword(''))
          }}
        >
          <Field
            label="Master password"
            hint="If you changed it on another device, enter the new one. This device will use it from now on."
          >
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button variant="primary" type="submit" disabled={busy || !password}>
            Sign in again
          </Button>
        </form>
      )}
      <ErrorText error={error} />
      <div className="panel-actions">
        {!sync.needsSignIn && (
          <Button disabled={busy || sync.state === 'syncing'} onClick={() => void run(() => api.syncNow())}>
            <RefreshCw size={14} /> Sync now
          </Button>
        )}
        {confirmOff ? (
          <Button variant="danger" onClick={() => void run(() => api.syncDisconnect())}>
            Stop syncing this device
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmOff(true)}>
            <CloudOff size={14} /> Turn off sync
          </Button>
        )}
      </div>
      {confirmOff && (
        <p className="muted">Your vault stays on this device and on the server. Other devices keep syncing.</p>
      )}
    </div>
  )
}

function Devices({ lastSyncAt }: { lastSyncAt?: number }) {
  const [devices, setDevices] = useState<DeviceView[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const { busy, error, run } = useAction()

  const load = useCallback(() => run(async () => setDevices(await api.syncDevices())), [])
  // Refresh whenever a sync completes: that is when the list can have changed.
  useEffect(() => {
    void load()
  }, [load, lastSyncAt])

  if (!devices) return <ErrorText error={error} />
  return (
    <>
      <h2 className="section-title spaced">Devices</h2>
      <ul className="devices">
        {devices.map((d) => (
          <li key={d.id}>
            <span className="device-text">
              <strong>{d.name}</strong>
              <small>
                {d.current ? 'This device' : `Last active ${new Date(d.lastUsedAt).toLocaleString()}`}
              </small>
            </span>
            {!d.current &&
              (confirming === d.id ? (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void run(() => api.syncRevokeDevice(d.id)).then(() => { setConfirming(null); void load() })}
                >
                  Confirm sign out
                </Button>
              ) : (
                <Button variant="ghost" aria-label={`Sign out ${d.name}`} onClick={() => setConfirming(d.id)}>
                  Sign out
                </Button>
              ))}
          </li>
        ))}
      </ul>
      <p className="field-hint">
        Signing a device out stops it syncing. It keeps the copy of the vault it already has, so
        also change your master password if the device is lost.
      </p>
      <ErrorText error={error} />
    </>
  )
}
