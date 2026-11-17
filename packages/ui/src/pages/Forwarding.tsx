import { ArrowLeftRight, Plus, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { ForwardInput, ForwardState, ForwardView, VaultSnapshot } from '@termterm/app'
import { api } from '../api'
import { useAppInfo } from '../Update'
import { Button, Empty, ErrorText, Field, useAction } from '../ui'

const KINDS = [
  { value: 'local', label: 'Local', hint: 'A port on this device reaches a destination through the server (ssh -L).' },
  { value: 'remote', label: 'Remote', hint: 'A port on the server reaches a destination from this device (ssh -R).' },
  {
    value: 'dynamic',
    label: 'Dynamic (SOCKS)',
    hint: 'A SOCKS5 proxy on this device that reaches anything through the server (ssh -D). Point a browser or tool at it.',
  },
] as const

function describe(f: ForwardView, host?: string): string {
  const via = host ? ` through ${host}` : ''
  if (f.kind === 'dynamic') return `SOCKS proxy on ${f.bindHost}:${f.bindPort}${via}`
  if (f.kind === 'local') return `${f.bindHost}:${f.bindPort} → ${f.destHost}:${f.destPort}${via}`
  return `server's ${f.bindHost}:${f.bindPort} → ${f.destHost}:${f.destPort} here${via}`
}

function useForwardStates(): Record<string, ForwardState> {
  const [states, setStates] = useState<Record<string, ForwardState>>({})
  useEffect(() => {
    void api.forwardStates().then(setStates)
    return api.onForwardState((id, state) => setStates((s) => ({ ...s, [id]: state })))
  }, [])
  return states
}

export function ForwardingPage({ snapshot }: { snapshot: VaultSnapshot }) {
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const canRun = useAppInfo()?.capabilities.forwards ?? false
  const states = useForwardStates()
  const { error, run } = useAction()
  const current = editing?.id ? snapshot.forwards.find((f) => f.id === editing.id) : undefined
  const hostLabel = (id: string) => snapshot.hosts.find((h) => h.id === id)?.label

  return (
    <div className="split">
      <div className="split-main">
        <div className="toolbar">
          <Button onClick={() => setEditing({ id: null })} disabled={snapshot.hosts.length === 0}>
            <Plus size={15} /> New port forward
          </Button>
        </div>
        {!canRun && snapshot.forwards.length > 0 && (
          <p className="hint-box">Port forwards run in the installed apps. They are saved here and sync with your vault.</p>
        )}
        <ErrorText error={error} />
        {snapshot.forwards.length === 0 ? (
          <Empty icon={<ArrowLeftRight size={28} />} title="No port forwards yet">
            {snapshot.hosts.length === 0
              ? 'Add a host first: a port forward goes through one of your hosts.'
              : 'Reach a service on a server as if it were on this device, or the other way round, or browse through a server with a SOCKS proxy.'}
          </Empty>
        ) : (
          <>
            <h2 className="section-title">Port forwards</h2>
            <ul className="cards forward-list">
              {snapshot.forwards.map((f) => {
                const state = states[f.id]
                const on = state?.state === 'active' || state?.state === 'starting'
                return (
                  <li key={f.id} className="forward-row">
                    <button
                      className={`card ${editing?.id === f.id ? 'selected' : ''}`}
                      onClick={() => setEditing({ id: f.id })}
                    >
                      <span className={`card-icon forward ${state?.state === 'active' ? 'on' : ''}`}>
                        <ArrowLeftRight size={18} />
                      </span>
                      <span className="card-text">
                        <strong>{f.label}</strong>
                        <small className="mono">{describe(f, hostLabel(f.hostId))}</small>
                        {f.autoStart && <small className="forward-state">Starts automatically</small>}
                        {state && state.state !== 'stopped' && (
                          <small className={state.state === 'error' ? 'error' : 'forward-state'} role="status">
                            {state.state === 'starting'
                              ? 'Starting…'
                              : state.state === 'active'
                                ? `Running · ${state.connections ?? 0} connection${state.connections === 1 ? '' : 's'}`
                                : state.error}
                          </small>
                        )}
                      </span>
                    </button>
                    {canRun && (
                      <Button
                        variant={on ? 'default' : 'primary'}
                        aria-label={`${on ? 'Stop' : 'Start'} ${f.label}`}
                        onClick={() => void run(() => (on ? api.forwardStop(f.id) : api.forwardStart(f.id)))}
                      >
                        {on ? 'Stop' : 'Start'}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
      {editing && (editing.id === null || current) && (
        <ForwardPanel
          key={editing.id ?? 'new'}
          forward={current}
          snapshot={snapshot}
          onClose={() => setEditing(null)}
          onSaved={(id) => setEditing({ id })}
        />
      )}
    </div>
  )
}

function ForwardPanel({
  forward,
  snapshot,
  onClose,
  onSaved,
}: {
  forward?: ForwardView
  snapshot: VaultSnapshot
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const [form, setForm] = useState({
    label: forward?.label ?? '',
    hostId: forward?.hostId ?? snapshot.hosts[0]?.id ?? '',
    kind: forward?.kind ?? ('local' as ForwardView['kind']),
    bindHost: forward?.bindHost ?? '',
    bindPort: String(forward?.bindPort ?? ''),
    destHost: forward?.destHost ?? '',
    destPort: String(forward?.destPort ?? ''),
    autoStart: forward?.autoStart ?? false,
  })
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const { busy, error, run } = useAction()
  const kind = KINDS.find((k) => k.value === form.kind)!
  const input = (): ForwardInput => ({
    label: form.label,
    hostId: form.hostId,
    kind: form.kind,
    bindHost: form.bindHost,
    bindPort: Number(form.bindPort),
    ...(form.kind === 'dynamic' ? {} : { destHost: form.destHost, destPort: Number(form.destPort) }),
    autoStart: form.autoStart,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => onSaved(await api.saveForward(forward?.id ?? null, input())))
  }
  return (
    <aside className="panel" aria-label="Port forward">
      <header className="panel-head">
        <h2>{forward ? 'Port forward' : 'New port forward'}</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <form className="panel-body" onSubmit={submit}>
        <Field label="Through host">
          <select value={form.hostId} onChange={(e) => set({ hostId: e.target.value })}>
            {snapshot.hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind" hint={kind.hint}>
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value as ForwardView['kind'] })}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field
            label={form.kind === 'remote' ? 'Listen on the server' : 'Listen on this device'}
            hint={form.kind === 'remote' ? 'Default localhost' : 'Default 127.0.0.1: only this device can use it'}
          >
            <input
              placeholder={form.kind === 'remote' ? 'localhost' : '127.0.0.1'}
              value={form.bindHost}
              onChange={(e) => set({ bindHost: e.target.value })}
            />
          </Field>
          <Field label="Listening port">
            <input
              className="port-input"
              inputMode="numeric"
              placeholder={form.kind === 'dynamic' ? '1080' : '8080'}
              value={form.bindPort}
              onChange={(e) => set({ bindPort: e.target.value })}
            />
          </Field>
        </div>
        {form.kind !== 'dynamic' && (
          <div className="row">
            <Field
              label="Destination host"
              hint={form.kind === 'local' ? 'As the server sees it, e.g. localhost or 10.0.0.5' : 'As this device sees it, e.g. localhost'}
            >
              <input placeholder="localhost" value={form.destHost} onChange={(e) => set({ destHost: e.target.value })} />
            </Field>
            <Field label="Destination port">
              <input
                className="port-input"
                inputMode="numeric"
                placeholder="80"
                value={form.destPort}
                onChange={(e) => set({ destPort: e.target.value })}
              />
            </Field>
          </div>
        )}
        <Field label="Label" hint="Optional">
          <input value={form.label} onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.autoStart} onChange={(e) => set({ autoStart: e.target.checked })} />
          <span>Start automatically when the vault is opened</span>
        </label>
        <p className="field-hint">On every device that runs port forwards. It keeps running while the vault is locked, until stopped or the app quits.</p>
        <ErrorText error={error} />
        <div className="panel-actions">
          <Button variant="primary" type="submit" disabled={busy || !form.hostId || !form.bindPort}>
            Save
          </Button>
          {forward && (
            <Button variant="ghost" onClick={() => void run(() => api.deleteItem(forward.id)).then(onClose)}>
              Delete
            </Button>
          )}
        </div>
      </form>
    </aside>
  )
}
