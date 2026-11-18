import { FileInput, FolderOpen, KeyRound, Pencil, Plus, Server, UserRound, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { HOST_COLORS, type ConnectTarget, type HostInput, type HostView, type VaultSnapshot } from '@termterm/app'
import { api } from '../api'
import { LocalTerminalButton } from '../LocalTerminalButton'
import { SshImportDialog } from '../SshImport'
import { useAppInfo } from '../Update'
import { Button, Empty, ErrorText, Field, PasswordInput, useAction } from '../ui'

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

/** "NAME=value" lines to variables; blank lines and # comments are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) throw new Error(`"${line}" is not NAME=value`)
    env[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return env
}

export function HostsPage({
  snapshot,
  onConnect,
}: {
  snapshot: VaultSnapshot
  onConnect: (target: ConnectTarget, title: string, kind?: 'files') => void
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [importing, setImporting] = useState(false)
  // Assume full capability until told otherwise, so nothing flickers on desktop.
  const info = useAppInfo()
  const canConnect = info?.capabilities.ssh ?? true
  const localTerminal = info?.capabilities.localTerminal ?? false
  const quick = canConnect ? parseQuickConnect(query) : null
  const explicit = /^ssh\s|@/.test(query.trim())

  const hosts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return snapshot.hosts
    return snapshot.hosts.filter((h) =>
      [h.label, h.address, h.username, h.group ?? '', ...h.tags].some((s) => s.toLowerCase().includes(q)),
    )
  }, [snapshot.hosts, query])

  // Ungrouped hosts first, then each group in name order.
  const sections = useMemo(() => {
    const byGroup = new Map<string, HostView[]>()
    for (const h of hosts) {
      const g = h.group ?? ''
      byGroup.set(g, [...(byGroup.get(g) ?? []), h])
    }
    return [...byGroup.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [hosts])
  const identityOf = (h: HostView) => snapshot.identities.find((i) => i.id === h.identityId)

  const open = (h: HostView) => onConnect({ hostId: h.id }, h.label)
  const browse = (h: HostView) => onConnect({ hostId: h.id }, h.label, 'files')
  const canBrowse = info?.capabilities.sftp ?? false
  const quickConnect = () => {
    if (!quick || !('address' in quick)) return
    onConnect(quick, quick.username ? `${quick.username}@${quick.address}` : quick.address)
    setQuery('')
  }
  const current = editing?.id ? snapshot.hosts.find((h) => h.id === editing.id) : undefined

  return (
    <div className="split">
      {importing && <SshImportDialog onClose={() => setImporting(false)} />}
      <div className="split-main">
        <form
          className="searchbar"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canConnect) return
            if (explicit && quick) quickConnect()
            else if (hosts.length === 1) open(hosts[0]!)
            else if (quick && hosts.length === 0) quickConnect()
          }}
        >
          <input
            aria-label="Find a host or connect"
            placeholder={canConnect ? 'Find a host or ssh user@hostname…' : 'Find a host…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {canConnect && (
            <Button variant="primary" type="submit" disabled={!(quick && (explicit || hosts.length === 0)) && hosts.length !== 1}>
              Connect
            </Button>
          )}
        </form>

        <div className="toolbar">
          <Button onClick={() => setEditing({ id: null })}>
            <Plus size={15} /> New host
          </Button>
          <Button onClick={() => setImporting(true)} title="Import hosts from ~/.ssh/config and known_hosts">
            <FileInput size={15} /> Import
          </Button>
          {localTerminal && (
            <LocalTerminalButton onOpen={(shell, title) => onConnect({ local: shell?.id ?? null }, title)} />
          )}
        </div>

        {snapshot.hosts.length === 0 ? (
          <Empty icon={<Server size={28} />} title="No hosts yet">
            Add a host to save its address and credentials in your vault
            {canConnect && (
              <>
                , or type <code>ssh user@hostname</code> above to connect right away
              </>
            )}
            .
          </Empty>
        ) : hosts.length === 0 ? (
          <p className="muted pad">No hosts match “{query}”.</p>
        ) : (
          sections.map(([group, list]) => (
            <section key={group || '$none'} aria-label={group || 'Hosts'}>
              {group ? <GroupTitle name={group} /> : <h2 className="section-title">Hosts</h2>}
              <ul className="cards">
                {list.map((h) => {
                  const identity = identityOf(h)
                  return (
                    <li key={h.id}>
                      <button
                        className={`card ${editing?.id === h.id ? 'selected' : ''} ${h.color ? `host-${h.color}` : ''}`}
                        onClick={() => setEditing({ id: h.id })}
                        onDoubleClick={canConnect ? () => open(h) : undefined}
                        title={canConnect ? 'Double-click to connect' : undefined}
                      >
                        <span className="card-icon">
                          <Server size={18} />
                        </span>
                        <span className="card-text">
                          <strong>{h.label}</strong>
                          <small>
                            {['ssh', identity ? identity.label : h.username, ...h.tags].filter(Boolean).join(', ')}
                          </small>
                        </span>
                        {identity ? (
                          <UserRound size={14} className="card-badge" aria-label={`Logs in as ${identity.label}`} />
                        ) : (
                          h.keyId && <KeyRound size={14} className="card-badge" aria-label="Uses a key" />
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      {editing && (editing.id === null || current) && (
        <HostPanel
          key={editing.id ?? 'new'}
          host={current}
          snapshot={snapshot}
          onClose={() => setEditing(null)}
          onSaved={(id) => setEditing({ id })}
          onConnect={canConnect ? open : undefined}
          onBrowse={canConnect && canBrowse ? browse : undefined}
        />
      )}
    </div>
  )
}

/** A group's heading, which renames the group (on every host in it) in place. */
function GroupTitle({ name }: { name: string }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const { busy, error, run } = useAction()
  if (!editing) {
    return (
      <h2 className="section-title group-heading">
        {name}
        <button className="icon-btn" aria-label={`Rename group ${name}`} onClick={() => { setValue(name); setEditing(true) }}>
          <Pencil size={13} />
        </button>
      </h2>
    )
  }
  return (
    <form
      className="group-rename"
      onSubmit={(e) => {
        e.preventDefault()
        void run(() => api.renameGroup(name, value)).then((ok) => ok && setEditing(false))
      }}
    >
      <input aria-label="Group name" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      <Button type="submit" disabled={busy}>
        Rename
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.renameGroup(name, '')).then((ok) => ok && setEditing(false))}>
        Ungroup
      </Button>
      <Button variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      <ErrorText error={error} />
    </form>
  )
}

function HostPanel({
  host,
  snapshot,
  onClose,
  onSaved,
  onConnect,
  onBrowse,
}: {
  host?: HostView
  snapshot: VaultSnapshot
  onClose: () => void
  onSaved: (id: string) => void
  /** Absent when this build cannot open SSH sessions. */
  onConnect?: (h: HostView) => void
  /** Opens the host's files (SFTP); absent where there is no file browser. */
  onBrowse?: (h: HostView) => void
}) {
  const [label, setLabel] = useState(host?.label ?? '')
  const [address, setAddress] = useState(host?.address ?? '')
  const [port, setPort] = useState(String(host?.port ?? 22))
  const [username, setUsername] = useState(host?.username ?? '')
  const [tags, setTags] = useState(host?.tags.join(', ') ?? '')
  const [keyId, setKeyId] = useState(host?.keyId ?? '')
  const [jumpHostId, setJumpHostId] = useState(host?.jumpHostId ?? '')
  const [identityId, setIdentityId] = useState(host?.identityId ?? '')
  const [group, setGroup] = useState(host?.group ?? '')
  const [color, setColor] = useState(host?.color ?? '')
  const [keepAlive, setKeepAlive] = useState(host?.keepAlive === undefined ? '' : String(host.keepAlive))
  const [startupSnippetId, setStartupSnippetId] = useState(host?.startupSnippetId ?? '')
  const envText = (env?: Record<string, string>) =>
    Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  const [env, setEnv] = useState(envText(host?.env))
  const [proxyKind, setProxyKind] = useState<'' | 'socks5' | 'http'>(host?.proxy?.kind ?? '')
  const [proxyHost, setProxyHost] = useState(host?.proxy?.host ?? '')
  const [proxyPort, setProxyPort] = useState(host?.proxy ? String(host.proxy.port) : '')
  const [proxyUser, setProxyUser] = useState(host?.proxy?.username ?? '')
  const [proxyPassword, setProxyPassword] = useState('')
  const [clearProxyPassword, setClearProxyPassword] = useState(false)
  const [agentForward, setAgentForward] = useState(!!host?.agentForward)
  const identity = snapshot.identities.find((i) => i.id === identityId)
  const groups = [...new Set(snapshot.hosts.map((h) => h.group).filter((g): g is string => !!g))].sort()
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, error, run } = useAction()

  // A key deleted elsewhere (or on another device) must not linger in the form.
  useEffect(() => {
    if (keyId && !snapshot.keys.some((k) => k.id === keyId)) setKeyId('')
  }, [snapshot.keys, keyId])
  useEffect(() => {
    if (jumpHostId && !snapshot.hosts.some((h) => h.id === jumpHostId)) setJumpHostId('')
  }, [snapshot.hosts, jumpHostId])
  useEffect(() => {
    if (identityId && !snapshot.identities.some((i) => i.id === identityId)) setIdentityId('')
  }, [snapshot.identities, identityId])
  useEffect(() => {
    if (startupSnippetId && !snapshot.snippets.some((sn) => sn.id === startupSnippetId)) setStartupSnippetId('')
  }, [snapshot.snippets, startupSnippetId])

  // Hosts this one can go through: not itself, nor any that already go through it.
  const jumpChoices = snapshot.hosts.filter((h) => {
    if (!host) return true
    for (let id: string | undefined = h.id, n = 0; id && n < 10; n++) {
      if (id === host.id) return false
      id = snapshot.hosts.find((x) => x.id === id)?.jumpHostId
    }
    return true
  })

  const input = (): HostInput => ({
    label,
    address,
    port: Number(port),
    username,
    tags: tags.split(','),
    keyId: keyId || null,
    jumpHostId: jumpHostId || null,
    identityId: identityId || null,
    group,
    color: color || null,
    keepAlive: keepAlive === '' ? null : Number(keepAlive),
    startupSnippetId: startupSnippetId || null,
    env: parseEnv(env),
    password: password ? password : clearPassword ? null : undefined,
    proxy: proxyKind
      ? {
          kind: proxyKind,
          host: proxyHost,
          port: Number(proxyPort || (proxyKind === 'http' ? 8080 : 1080)),
          username: proxyUser,
          password: proxyPassword ? proxyPassword : clearProxyPassword ? null : undefined,
        }
      : null,
    agentForward,
  })
  const dirty =
    !host ||
    label !== host.label ||
    address !== host.address ||
    Number(port) !== host.port ||
    username !== host.username ||
    tags !== host.tags.join(', ') ||
    keyId !== (host.keyId ?? '') ||
    jumpHostId !== (host.jumpHostId ?? '') ||
    identityId !== (host.identityId ?? '') ||
    group.trim() !== (host.group ?? '') ||
    color !== (host.color ?? '') ||
    keepAlive !== (host.keepAlive === undefined ? '' : String(host.keepAlive)) ||
    startupSnippetId !== (host.startupSnippetId ?? '') ||
    env.trim() !== envText(host.env) ||
    !!password ||
    clearPassword ||
    proxyKind !== (host.proxy?.kind ?? '') ||
    proxyHost !== (host.proxy?.host ?? '') ||
    proxyPort !== (host.proxy ? String(host.proxy.port) : '') ||
    proxyUser !== (host.proxy?.username ?? '') ||
    !!proxyPassword ||
    clearProxyPassword ||
    agentForward !== !!host.agentForward

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
        <Field label="Group" hint="Hosts with the same group are listed together.">
          <input list="host-groups" placeholder="None" value={group} onChange={(e) => setGroup(e.target.value)} />
        </Field>
        <datalist id="host-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <Field label="Tags" hint="Comma separated">
          <input placeholder="vps, production" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>

        <h3 className="group-title">SSH</h3>
        <Field
          label="Login"
          hint={
            identity
              ? `Logs in as ${identity.username}${identity.keyId ? ' with a key' : ''}${identity.hasPassword ? ' and a saved password' : ''}. Edit identities under Keychain.`
              : snapshot.identities.length
                ? 'Use a saved identity, or this host’s own username, key and password.'
                : undefined
          }
        >
          <select value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
            <option value="">This host’s own</option>
            {snapshot.identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          {!identity && (
            <Field label="Username">
              <input placeholder="root" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
          )}
          <Field label="Port">
            <input inputMode="numeric" className="narrow" value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
        </div>
        {!identity && (
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
        )}
        <Field
          label="Jump host"
          hint="Connect through another saved host first, for a server that is only reachable from there (ssh's ProxyJump)."
        >
          <select value={jumpHostId} onChange={(e) => setJumpHostId(e.target.value)}>
            <option value="">None: connect directly</option>
            {jumpChoices.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Proxy"
          hint={
            jumpHostId
              ? "Used only if this host is reached directly; through a jump host, the jump host's own proxy applies."
              : 'Reach this host through a SOCKS5 or HTTP proxy, for networks that only let traffic out that way.'
          }
        >
          <select value={proxyKind} onChange={(e) => setProxyKind(e.target.value as '' | 'socks5' | 'http')}>
            <option value="">None: connect directly</option>
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP (CONNECT)</option>
          </select>
        </Field>
        {proxyKind && (
          <>
            <div className="row">
              <Field label="Proxy address">
                <input value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="proxy.example.com" />
              </Field>
              <Field label="Proxy port">
                <input
                  inputMode="numeric"
                  className="narrow"
                  value={proxyPort}
                  placeholder={proxyKind === 'http' ? '8080' : '1080'}
                  onChange={(e) => setProxyPort(e.target.value)}
                />
              </Field>
            </div>
            <div className="row">
              <Field label="Proxy username" hint="Only if the proxy asks for one.">
                <input autoComplete="off" value={proxyUser} onChange={(e) => setProxyUser(e.target.value)} />
              </Field>
              <Field
                label="Proxy password"
                hint={
                  host?.proxy?.hasPassword && !clearProxyPassword ? (
                    <>
                      Saved.{' '}
                      <button type="button" className="link" onClick={() => { setClearProxyPassword(true); setProxyPassword('') }}>
                        Remove it
                      </button>
                    </>
                  ) : clearProxyPassword ? (
                    'Will be removed when you save.'
                  ) : undefined
                }
              >
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={host?.proxy?.hasPassword && !clearProxyPassword ? '•••••••• (unchanged)' : ''}
                  value={proxyPassword}
                  onChange={(e) => { setProxyPassword(e.target.value); setClearProxyPassword(false) }}
                />
              </Field>
            </div>
          </>
        )}
        {!identity && (
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
            <PasswordInput
              autoComplete="new-password"
              placeholder={host?.hasPassword && !clearPassword ? '•••••••• (unchanged)' : ''}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setClearPassword(false) }}
            />
          </Field>
        )}
        <h3 className="group-title">Session</h3>
        <div className="field">
          <span className="field-label" id="host-colour-label">Colour</span>
          <div className="swatches" role="radiogroup" aria-labelledby="host-colour-label">
            <button
              type="button"
              role="radio"
              aria-checked={!color}
              aria-label="No colour"
              className="swatch none"
              onClick={() => setColor('')}
            />
            {HOST_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c[0]!.toUpperCase() + c.slice(1)}
                className={`swatch host-${c}`}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <span className="field-hint">Marks this host's card, tabs and panes, to tell them apart at a glance.</span>
        </div>
        <Field label="Startup snippet" hint="Typed into the session each time it connects.">
          <select value={startupSnippetId} onChange={(e) => setStartupSnippetId(e.target.value)}>
            <option value="">None</option>
            {snapshot.snippets.map((sn) => (
              <option key={sn.id} value={sn.id}>
                {sn.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Keep-alive"
          hint="How often to check the connection is alive. More often helps through firewalls that drop quiet connections."
        >
          <select value={keepAlive} onChange={(e) => setKeepAlive(e.target.value)}>
            <option value="">Default (every 20 seconds)</option>
            {[10, 30, 60, 120, 300].map((n) => (
              <option key={n} value={n}>
                Every {n < 60 ? `${n} seconds` : `${n / 60} minute${n > 60 ? 's' : ''}`}
              </option>
            ))}
            <option value="0">Off</option>
            {keepAlive && ![0, 10, 30, 60, 120, 300].includes(Number(keepAlive)) && (
              <option value={keepAlive}>Every {keepAlive} seconds</option>
            )}
          </select>
        </Field>
        <Field
          label="Environment variables"
          hint="One NAME=value per line, set when the shell starts. The server only applies the ones its AcceptEnv setting allows."
        >
          <textarea
            className="env-input"
            rows={3}
            placeholder={'LANG=en_GB.UTF-8\nAPP_ENV=staging'}
            value={env}
            onChange={(e) => setEnv(e.target.value)}
          />
        </Field>
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={agentForward} onChange={(e) => setAgentForward(e.target.checked)} />
            Agent forwarding
          </label>
          <span className="field-hint">
            Lets this server log in onward (to other servers, or git) with the keys in your vault, like ssh -A. Your keys never
            leave this device, but while a session is open anyone with root on the server could use them: only for servers you
            trust.
          </span>
        </div>
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
      {onConnect ? (
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
          {onBrowse && host && (
            <Button disabled={busy || dirty} onClick={() => onBrowse(host)} title="Browse this host's files (SFTP)">
              <FolderOpen size={15} /> Files
            </Button>
          )}
        </footer>
      ) : (
        <footer className="panel-foot">
          <p className="field-hint">
            Connecting is not available in this app yet. Hosts you save here sync to your other
            devices.
          </p>
        </footer>
      )}
    </aside>
  )
}
