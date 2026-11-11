import { Check, Copy, KeyRound, Plus, Upload, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { KeyView, VaultSnapshot } from '@termterm/app'
import { api } from '../api'
import { Button, Empty, ErrorText, Field, useAction } from '../ui'

type Mode = { kind: 'generate' } | { kind: 'import' } | { kind: 'view'; id: string }

export function KeychainPage({ snapshot }: { snapshot: VaultSnapshot }) {
  const [mode, setMode] = useState<Mode | null>(null)
  const viewed = mode?.kind === 'view' ? snapshot.keys.find((k) => k.id === mode.id) : undefined

  return (
    <div className="split">
      <div className="split-main">
        <div className="toolbar">
          <Button onClick={() => setMode({ kind: 'generate' })}>
            <Plus size={15} /> Generate key
          </Button>
          <Button onClick={() => setMode({ kind: 'import' })}>
            <Upload size={15} /> Import key
          </Button>
        </div>
        {snapshot.keys.length === 0 ? (
          <Empty icon={<KeyRound size={28} />} title="No keys yet">
            Generate a new SSH key or import an existing private key. Private keys are stored
            encrypted and are never shown again after saving.
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
      </div>
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
          usedBy={snapshot.hosts.filter((h) => h.keyId === viewed.id).map((h) => h.label)}
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
          <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
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
          <dd>{usedBy.length ? usedBy.join(', ') : 'No hosts'}</dd>
        </dl>
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button type="submit" disabled={busy || !label.trim() || label === item.label}>
            Rename
          </Button>
          {confirmDelete ? (
            <Button variant="danger" onClick={() => void run(() => api.deleteItem(item.id))}>
              {usedBy.length ? `Delete and detach from ${usedBy.length} host${usedBy.length > 1 ? 's' : ''}` : 'Confirm delete'}
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
