import { KeyRound, Plus, Server, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ConnectTarget, HostInput, HostView, VaultSnapshot } from '@termterm/app'
import { api } from '../api'
import { Button, Empty, ErrorText, Field, useAction } from '../ui'

/** Parses `ssh user@host -p 2222`, `user@host:2222` or a bare hostname. */
export function parseQuickConnect(input: string): ConnectTarget | null {
  let text = input.trim().replace(/^ssh\s+/, '')
  if (!text) return null
  let port = 22
  const flag = /(?:^|\s)-p\s*(\d+)/.exec(text)
  if (flag) {
    port = Number(flag[1])
    text = text.replace(flag[0], ' ').trim()
  }
  const m = /^(?:([^@\s]+)@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+)(?::(\d+))?$/.exec(text)
  if (!m) return null
  if (m[3]) port = Number(m[3])
  if (port < 1 || port > 65535) return null
  return { username: m[1] ?? '', address: m[2]!.replace(/^\[|\]$/g, ''), port }
}

type Editing = { id: string | null }

export function HostsPage({
  snapshot,
  onConnect,
}: {
  snapshot: VaultSnapshot
  onConnect: (target: ConnectTarget, title: string) => void
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const quick = parseQuickConnect(query)
  const explicit = /^ssh\s|@/.test(query.trim())

  const hosts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return snapshot.hosts
    return snapshot.hosts.filter((h) =>
      [h.label, h.address, h.username, ...h.tags].some((s) => s.toLowerCase().includes(q)),
    )
  }, [snapshot.hosts, query])

  const open = (h: HostView) => onConnect({ hostId: h.id }, h.label)
  const quickConnect = () => {
    if (!quick || !('address' in quick)) return
    onConnect(quick, quick.username ? `${quick.username}@${quick.address}` : quick.address)
    setQuery('')
  }
  const current = editing?.id ? snapshot.hosts.find((h) => h.id === editing.id) : undefined

  return (
    <div className="split">
      <div className="split-main">
        <form
          className="searchbar"
          onSubmit={(e) => {
            e.preventDefault()
            if (explicit && quick) quickConnect()
            else if (hosts.length === 1) open(hosts[0]!)
            else if (quick && hosts.length === 0) quickConnect()
          }}
        >
          <input
            aria-label="Find a host or connect"
            placeholder="Find a host or ssh user@hostname…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button variant="primary" type="submit" disabled={!(quick && (explicit || hosts.length === 0)) && hosts.length !== 1}>
            Connect
          </Button>
        </form>

        <div className="toolbar">
          <Button onClick={() => setEditing({ id: null })}>
            <Plus size={15} /> New host
          </Button>
        </div>

        {snapshot.hosts.length === 0 ? (
          <Empty icon={<Server size={28} />} title="No hosts yet">
            Add a host to save its address and credentials in your vault, or type
            <code> ssh user@hostname </code> above to connect right away.
          </Empty>
        ) : hosts.length === 0 ? (
          <p className="muted pad">No hosts match “{query}”.</p>
        ) : (
          <>
            <h2 className="section-title">Hosts</h2>
            <ul className="cards">
              {hosts.map((h) => (
                <li key={h.id}>
                  <button
                    className={`card ${editing?.id === h.id ? 'selected' : ''}`}
                    onClick={() => setEditing({ id: h.id })}
                    onDoubleClick={() => open(h)}
                    title="Double-click to connect"
                  >
                    <span className="card-icon">
                      <Server size={18} />
                    </span>
                    <span className="card-text">
                      <strong>{h.label}</strong>
                      <small>
                        {['ssh', h.username, ...h.tags].filter(Boolean).join(', ')}
                      </small>
                    </span>
                    {h.keyId && <KeyRound size={14} className="card-badge" aria-label="Uses a key" />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {editing && (editing.id === null || current) && (
        <HostPanel
          key={editing.id ?? 'new'}
          host={current}
          snapshot={snapshot}
          onClose={() => setEditing(null)}
          onSaved={(id) => setEditing({ id })}
          onConnect={open}
        />
      )}
    </div>
  )
}

function HostPanel({
  host,
  snapshot,
  onClose,
  onSaved,
  onConnect,
}: {
  host?: HostView
  snapshot: VaultSnapshot
  onClose: () => void
  onSaved: (id: string) => void
  onConnect: (h: HostView) => void
}) {
  const [label, setLabel] = useState(host?.label ?? '')
  const [address, setAddress] = useState(host?.address ?? '')
  const [port, setPort] = useState(String(host?.port ?? 22))
  const [username, setUsername] = useState(host?.username ?? '')
  const [tags, setTags] = useState(host?.tags.join(', ') ?? '')
  const [keyId, setKeyId] = useState(host?.keyId ?? '')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, error, run } = useAction()

  // A key deleted elsewhere (or on another device) must not linger in the form.
  useEffect(() => {
    if (keyId && !snapshot.keys.some((k) => k.id === keyId)) setKeyId('')
  }, [snapshot.keys, keyId])

  const input = (): HostInput => ({
    label,
    address,
    port: Number(port),
    username,
    tags: tags.split(','),
    keyId: keyId || null,
    password: password ? password : clearPassword ? null : undefined,
  })
  const dirty =
    !host ||
    label !== host.label ||
    address !== host.address ||
    Number(port) !== host.port ||
    username !== host.username ||
    tags !== host.tags.join(', ') ||
    keyId !== (host.keyId ?? '') ||
    !!password ||
    clearPassword

  const save = async (): Promise<string | null> => {
    let id: string | null = null
    const ok = await run(async () => {
      id = await api.saveHost(host?.id ?? null, input())
    })
    if (ok && id) {
      setPassword('')
      setClearPassword(false)
      onSaved(id)
    }
    return ok ? id : null
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save()
  }

  return (
    <aside className="panel" aria-label="Host details">
      <header className="panel-head">
        <h2>{host ? 'Host details' : 'New host'}</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <form className="panel-body" onSubmit={submit}>
        <Field label="Address">
          <input
            autoFocus={!host}
            placeholder="IP or hostname"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <Field label="Label">
          <input placeholder={address || 'My server'} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Tags" hint="Comma separated">
          <input placeholder="vps, production" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>

        <h3 className="group-title">SSH</h3>
        <div className="row">
          <Field label="Username">
            <input placeholder="root" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Port">
            <input inputMode="numeric" className="narrow" value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
        </div>
        <Field label="Key">
          <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            <option value="">No key</option>
            {snapshot.keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Password"
          hint={
            host?.hasPassword && !clearPassword ? (
              <>
                A password is saved.{' '}
                <button type="button" className="link" onClick={() => { setClearPassword(true); setPassword('') }}>
                  Remove it
                </button>
              </>
            ) : clearPassword ? (
              'The saved password will be removed when you save.'
            ) : (
              'Optional. Leave empty to be asked when connecting.'
            )
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            placeholder={host?.hasPassword && !clearPassword ? '•••••••• (unchanged)' : ''}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setClearPassword(false) }}
          />
        </Field>
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button type="submit" disabled={busy || !dirty || !address.trim()}>
            {host ? 'Save changes' : 'Save host'}
          </Button>
          {host &&
            (confirmDelete ? (
              <Button variant="danger" onClick={() => void run(() => api.deleteItem(host.id)).then(onClose)}>
                Confirm delete
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ))}
        </div>
      </form>
      <footer className="panel-foot">
        <Button
          variant="primary"
          className="wide"
          disabled={busy || !address.trim()}
          onClick={async () => {
            if (!dirty && host) return onConnect(host)
            const id = await save()
            if (id) onConnect({ ...(host ?? { tags: [], hasPassword: false }), id, label: label.trim() || address.trim(), address, port: Number(port), username })
          }}
        >
          {dirty && host ? 'Save and connect' : 'Connect'}
        </Button>
      </footer>
    </aside>
  )
}
