import { Check, Copy, KeyRound, Plus, Upload, UserRound, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { certificateProblem, parseCertificate, type IdentityView, type KeyView, type VaultSnapshot } from '@termterm/app'
import { api } from '../api'
import { useAppInfo } from '../Update'
import { Button, Empty, ErrorText, Field, PasswordInput, useAction } from '../ui'

type Mode =
  | { kind: 'generate' }
  | { kind: 'import' }
  | { kind: 'view'; id: string }
  | { kind: 'identity'; id: string | null }

export function KeychainPage({ snapshot }: { snapshot: VaultSnapshot }) {
  const [mode, setMode] = useState<Mode | null>(null)
  const canManage = useAppInfo()?.capabilities.keys ?? true
  const viewed = mode?.kind === 'view' ? snapshot.keys.find((k) => k.id === mode.id) : undefined
  const identity = mode?.kind === 'identity' && mode.id ? snapshot.identities.find((i) => i.id === mode.id) : undefined

  return (
    <div className="split">
      <div className="split-main">
        <div className="toolbar">
          {canManage && (
            <>
              <Button onClick={() => setMode({ kind: 'generate' })}>
                <Plus size={15} /> Generate key
              </Button>
              <Button onClick={() => setMode({ kind: 'import' })}>
                <Upload size={15} /> Import key
              </Button>
            </>
          )}
          <Button onClick={() => setMode({ kind: 'identity', id: null })} title="A login that several hosts can share">
            <UserRound size={15} /> New identity
          </Button>
        </div>
        {snapshot.keys.length === 0 ? (
          <Empty icon={<KeyRound size={28} />} title="No keys yet">
            {canManage
              ? 'Generate a new SSH key or import an existing private key. Private keys are stored encrypted and are never shown again after saving.'
              : 'Keys you add in the desktop app appear here once this device has synced.'}
          </Empty>
        ) : (
          <>
            <h2 className="section-title">Keys</h2>
            <ul className="cards">
              {snapshot.keys.map((k) => (
                <li key={k.id}>
                  <button
                    className={`card ${viewed?.id === k.id ? 'selected' : ''}`}
                    onClick={() => setMode({ kind: 'view', id: k.id })}
                  >
                    <span className="card-icon key">
                      <KeyRound size={18} />
                    </span>
                    <span className="card-text">
                      <strong>{k.label}</strong>
                      <small>Type {k.keyType.replace(/^ssh-/, '').toUpperCase()}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {snapshot.identities.length > 0 && (
          <>
            <h2 className="section-title spaced">Identities</h2>
            <ul className="cards">
              {snapshot.identities.map((i) => (
                <li key={i.id}>
                  <button
                    className={`card ${identity?.id === i.id ? 'selected' : ''}`}
                    onClick={() => setMode({ kind: 'identity', id: i.id })}
                  >
                    <span className="card-icon">
                      <UserRound size={18} />
                    </span>
                    <span className="card-text">
                      <strong>{i.label}</strong>
                      <small>
                        {[i.username, i.keyId && 'key', i.hasPassword && 'password'].filter(Boolean).join(', ')}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {mode?.kind === 'identity' && (mode.id === null || identity) && (
        <IdentityPanel
          key={mode.id ?? 'new'}
          item={identity}
          keys={snapshot.keys}
          usedBy={identity ? snapshot.hosts.filter((h) => h.identityId === identity.id).map((h) => h.label) : []}
          onClose={() => setMode(null)}
          onSaved={(id) => setMode({ kind: 'identity', id })}
        />
      )}
      {mode?.kind === 'generate' && (
        <GeneratePanel onClose={() => setMode(null)} onDone={(id) => setMode({ kind: 'view', id })} />
      )}
      {mode?.kind === 'import' && (
        <ImportPanel onClose={() => setMode(null)} onDone={(id) => setMode({ kind: 'view', id })} />
      )}
      {viewed && (
        <KeyPanel
          key={viewed.id}
          item={viewed}
          usedBy={[
            ...snapshot.hosts.filter((h) => h.keyId === viewed.id && !h.identityId).map((h) => h.label),
            ...snapshot.identities.filter((i) => i.keyId === viewed.id).map((i) => `${i.label} (identity)`),
          ]}
          onClose={() => setMode(null)}
        />
      )}
    </div>
  )
}

function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <aside className="panel" aria-label={title}>
      <header className="panel-head">
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {children}
    </aside>
  )
}

function GeneratePanel({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<'ed25519' | 'rsa'>('ed25519')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => onDone(await api.generateKey(label, type)))
  }
  return (
    <PanelShell title="Generate key" onClose={onClose}>
      <form className="panel-body" onSubmit={submit}>
        <Field label="Label">
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Type" hint="Ed25519 is recommended. Use RSA only for servers that require it.">
          <select value={type} onChange={(e) => setType(e.target.value as 'ed25519' | 'rsa')}>
            <option value="ed25519">Ed25519</option>
            <option value="rsa">RSA 4096</option>
          </select>
        </Field>
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button variant="primary" type="submit" disabled={busy || !label.trim()}>
            {busy ? 'Generating…' : 'Generate'}
          </Button>
        </div>
      </form>
    </PanelShell>
  )
}

function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [label, setLabel] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => onDone(await api.importKey({ label, privateKey, passphrase })))
  }
  return (
    <PanelShell title="Import key" onClose={onClose}>
      <form className="panel-body" onSubmit={submit}>
        <Field label="Label">
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Private key">
          <textarea
            className="mono"
            rows={9}
            spellCheck={false}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
          />
        </Field>
        <Field label="Passphrase" hint="Only if the key is encrypted.">
          <PasswordInput autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button variant="primary" type="submit" disabled={busy || !label.trim() || !privateKey.trim()}>
            Import
          </Button>
        </div>
      </form>
    </PanelShell>
  )
}

function KeyPanel({ item, usedBy, onClose }: { item: KeyView; usedBy: string[]; onClose: () => void }) {
  const [label, setLabel] = useState(item.label)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, error, run } = useAction()
  const copy = () => {
    api.clipboardWrite(item.publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <PanelShell title="Key details" onClose={onClose}>
      <form
        className="panel-body"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => api.renameKey(item.id, label))
        }}
      >
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Public key" hint="Add this line to ~/.ssh/authorized_keys on the server.">
          <textarea className="mono" rows={5} readOnly value={item.publicKey} />
        </Field>
        <Button onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy public key'}
        </Button>
        <dl className="facts">
          <dt>Fingerprint</dt>
          <dd className="mono">{item.fingerprint}</dd>
          <dt>Private key</dt>
          <dd>Stored encrypted{item.hasPassphrase ? ', with passphrase' : ''}</dd>
          <dt>Used by</dt>
          <dd>{usedBy.length ? usedBy.join(', ') : 'Nothing yet'}</dd>
        </dl>
        <CertificateSection item={item} />
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button type="submit" disabled={busy || !label.trim() || label === item.label}>
            Rename
          </Button>
          {confirmDelete ? (
            <Button variant="danger" onClick={() => void run(() => api.deleteItem(item.id))}>
              {usedBy.length ? `Delete and detach from ${usedBy.length} place${usedBy.length > 1 ? 's' : ''}` : 'Confirm delete'}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>
      </form>
    </PanelShell>
  )
}

/** The key's OpenSSH certificate: what it allows and until when, or a place to add one. */
function CertificateSection({ item }: { item: KeyView }) {
  const [text, setText] = useState('')
  const { busy, error, run } = useAction()
  if (item.certificate) {
    let info: ReturnType<typeof parseCertificate> | null = null
    try {
      info = parseCertificate(item.certificate)
    } catch {
      info = null
    }
    const problem = certificateProblem(item.certificate, item.publicKey)
    const when = (ms: number | null, none: string) => (ms === null ? none : new Date(ms).toLocaleString())
    return (
      <section aria-label="Certificate">
        <h3 className="group-title">Certificate</h3>
        <p className="field-hint">Logins with this key offer the certificate first, then the key on its own.</p>
        {info && (
          <dl className="facts">
            <dt>Key ID</dt>
            <dd className="mono">{info.keyId || '(none)'}</dd>
            <dt>Usernames</dt>
            <dd>{info.principals.length ? info.principals.join(', ') : 'Any'}</dd>
            <dt>Valid</dt>
            <dd>
              {info.validAfter === null && info.validBefore === null
                ? 'Always'
                : `${when(info.validAfter, 'from the start')} to ${when(info.validBefore, 'forever')}`}
            </dd>
          </dl>
        )}
        {problem && <p className="error" role="alert">{problem}</p>}
        <ErrorText error={error} />
        <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.setKeyCertificate(item.id, null))}>
          Remove certificate
        </Button>
      </section>
    )
  }
  return (
    <section aria-label="Certificate">
      <h3 className="group-title">Certificate</h3>
      <Field
        label="Certificate"
        hint="If your servers trust a certificate authority, paste the certificate it signed for this key (the line from the -cert.pub file)."
      >
        <textarea
          className="mono"
          rows={4}
          placeholder="ssh-ed25519-cert-v01@openssh.com AAAA…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <ErrorText error={error} />
      <Button
        disabled={busy || !text.trim()}
        onClick={() =>
          void run(async () => {
            await api.setKeyCertificate(item.id, text)
            setText('')
          })
        }
      >
        Add certificate
      </Button>
    </section>
  )
}

function IdentityPanel({
  item,
  keys,
  usedBy,
  onClose,
  onSaved,
}: {
  item?: IdentityView
  keys: KeyView[]
  usedBy: string[]
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const [label, setLabel] = useState(item?.label ?? '')
  const [username, setUsername] = useState(item?.username ?? '')
  const [keyId, setKeyId] = useState(item?.keyId ?? '')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, error, run } = useAction()
  const dirty =
    !item ||
    label !== item.label ||
    username !== item.username ||
    keyId !== (item.keyId ?? '') ||
    !!password ||
    clearPassword
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const id = await api.saveIdentity(item?.id ?? null, {
        label,
        username,
        keyId: keyId || null,
        password: password ? password : clearPassword ? null : undefined,
      })
      setPassword('')
      setClearPassword(false)
      onSaved(id)
    })
  }
  return (
    <PanelShell title={item ? 'Identity' : 'New identity'} onClose={onClose}>
      <form className="panel-body" onSubmit={submit}>
        <p className="field-hint">
          A username with a key and/or password that several hosts can log in with. Change it
          here and every host using it follows.
        </p>
        <Field label="Username">
          <input autoFocus={!item} placeholder="root" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Label">
          <input placeholder={username || 'Ops login'} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Key">
          <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            <option value="">No key</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Password"
          hint={
            item?.hasPassword && !clearPassword ? (
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
            placeholder={item?.hasPassword && !clearPassword ? '•••••••• (unchanged)' : ''}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setClearPassword(false) }}
          />
        </Field>
        {item && (
          <dl className="facts">
            <dt>Used by</dt>
            <dd>{usedBy.length ? usedBy.join(', ') : 'No hosts yet. Choose it under Login in a host.'}</dd>
          </dl>
        )}
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button type="submit" disabled={busy || !dirty || !username.trim()}>
            {item ? 'Save changes' : 'Save identity'}
          </Button>
          {item &&
            (confirmDelete ? (
              <Button variant="danger" onClick={() => void run(() => api.deleteItem(item.id)).then(onClose)}>
                {usedBy.length ? 'Delete: its hosts keep this login' : 'Confirm delete'}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ))}
        </div>
      </form>
    </PanelShell>
  )
}
