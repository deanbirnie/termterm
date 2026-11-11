import { Braces, Plus, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { SnippetView, VaultSnapshot } from '@termterm/app'
import { api } from '../api'
import { Button, Empty, ErrorText, Field, useAction } from '../ui'

export function SnippetsPage({ snapshot }: { snapshot: VaultSnapshot }) {
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const current = editing?.id ? snapshot.snippets.find((s) => s.id === editing.id) : undefined
  return (
    <div className="split">
      <div className="split-main">
        <div className="toolbar">
          <Button onClick={() => setEditing({ id: null })}>
            <Plus size={15} /> New snippet
          </Button>
        </div>
        {snapshot.snippets.length === 0 ? (
          <Empty icon={<Braces size={28} />} title="No snippets yet">
            Save commands you run often, then run them in any open session from the snippet
            button in the terminal.
          </Empty>
        ) : (
          <>
            <h2 className="section-title">Snippets</h2>
            <ul className="cards">
              {snapshot.snippets.map((s) => (
                <li key={s.id}>
                  <button
                    className={`card ${editing?.id === s.id ? 'selected' : ''}`}
                    onClick={() => setEditing({ id: s.id })}
                  >
                    <span className="card-icon snippet">
                      <Braces size={18} />
                    </span>
                    <span className="card-text">
                      <strong>{s.label}</strong>
                      <small className="mono">{s.script.split('\n')[0]}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {editing && (editing.id === null || current) && (
        <SnippetPanel
          key={editing.id ?? 'new'}
          snippet={current}
          onClose={() => setEditing(null)}
          onSaved={(id) => setEditing({ id })}
        />
      )}
    </div>
  )
}

function SnippetPanel({
  snippet,
  onClose,
  onSaved,
}: {
  snippet?: SnippetView
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const [label, setLabel] = useState(snippet?.label ?? '')
  const [script, setScript] = useState(snippet?.script ?? '')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => onSaved(await api.saveSnippet(snippet?.id ?? null, { label, script })))
  }
  const dirty = !snippet || label !== snippet.label || script !== snippet.script
  return (
    <aside className="panel" aria-label="Snippet">
      <header className="panel-head">
        <h2>{snippet ? 'Snippet' : 'New snippet'}</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <form className="panel-body" onSubmit={submit}>
        <Field label="Label">
          <input autoFocus={!snippet} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Script">
          <textarea className="mono" rows={10} spellCheck={false} value={script} onChange={(e) => setScript(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button variant="primary" type="submit" disabled={busy || !dirty || !label.trim() || !script.trim()}>
            Save
          </Button>
          {snippet && (
            <Button variant="ghost" onClick={() => void run(() => api.deleteItem(snippet.id)).then(onClose)}>
              Delete
            </Button>
          )}
        </div>
      </form>
    </aside>
  )
}
