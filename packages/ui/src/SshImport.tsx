import { useEffect, useState } from 'react'
import type { SshImportPreview, SshImportResult } from '@termterm/app'
import { api } from './api'
import { useAppInfo } from './Update'
import { Button, ErrorText, Field, Modal, useAction } from './ui'

/**
 * Brings hosts in from OpenSSH: reads ~/.ssh on a computer (or pasted text on
 * a phone), shows what it found, and imports the chosen hosts, the keys they
 * use and the host keys already trusted in known_hosts.
 */
export function SshImportDialog({ onClose }: { onClose: () => void }) {
  const info = useAppInfo()
  const fromFiles = info?.capabilities.sshFiles ?? false
  const [paste, setPaste] = useState<{ config: string; knownHosts: string } | null>(null)
  const [preview, setPreview] = useState<SshImportPreview | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [trustKnown, setTrustKnown] = useState(true)
  const [result, setResult] = useState<SshImportResult | null>(null)
  const { busy, error, run } = useAction()

  const scan = (text?: { config: string; knownHosts: string }) =>
    void run(async () => {
      const p = await api.sshImportScan(text)
      setPreview(p)
      setChosen(new Set(p.hosts.filter((h) => !h.exists).map((h) => h.alias)))
    })

  // On a computer, read ~/.ssh straight away; a phone starts with pasting.
  useEffect(() => {
    if (!info) return
    if (fromFiles) scan()
    else setPaste({ config: '', knownHosts: '' })
  }, [info, fromFiles])

  if (result) {
    return (
      <Modal title="Imported" onClose={onClose}>
        <p>
          {count(result.hosts, 'host')}, {count(result.keys, 'key')} and {count(result.knownHosts, 'known host key')}{' '}
          added to your vault.
        </p>
        {result.keysNeedingPassphrase.length > 0 && (
          <p className="hint-box">
            These keys are protected by a passphrase, so their hosts were added without them. Add each under Keychain
            → Import with its passphrase, then choose it on the host: {result.keysNeedingPassphrase.join(', ')}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    )
  }

  if (paste && !preview) {
    return (
      <Modal title="Import from SSH config" onClose={onClose}>
        <Field label="~/.ssh/config" hint="Paste the file's contents. Host blocks become hosts in your vault.">
          <textarea
            rows={8}
            className="mono"
            spellCheck={false}
            value={paste.config}
            onChange={(e) => setPaste({ ...paste, config: e.target.value })}
          />
        </Field>
        <Field label="~/.ssh/known_hosts (optional)" hint="Host keys you already trust, so connecting does not ask again.">
          <textarea
            rows={4}
            className="mono"
            spellCheck={false}
            value={paste.knownHosts}
            onChange={(e) => setPaste({ ...paste, knownHosts: e.target.value })}
          />
        </Field>
        <ErrorText error={error} />
        <div className="modal-actions">
          {fromFiles && (
            <Button
              variant="ghost"
              onClick={() => {
                setPaste(null)
                scan()
              }}
            >
              Read ~/.ssh instead
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !(paste.config.trim() || paste.knownHosts.trim())}
            onClick={() => scan(paste)}
          >
            Continue
          </Button>
        </div>
      </Modal>
    )
  }

  if (!preview) {
    return (
      <Modal title="Import from SSH config" onClose={onClose}>
        {error ? <ErrorText error={error} /> : <p className="muted">Reading ~/.ssh…</p>}
        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </Modal>
    )
  }

  const known = preview.knownHosts
  const nothing = preview.hosts.length === 0 && known.add === 0
  const toggle = (alias: string, on: boolean) =>
    setChosen((c) => {
      const next = new Set(c)
      if (on) next.add(alias)
      else next.delete(alias)
      return next
    })
  return (
    <Modal title="Import from SSH config" onClose={onClose}>
      <p className="muted">From {preview.source}.</p>
      {nothing ? (
        <p>
          No hosts or host keys found{fromFiles ? ' in ~/.ssh/config or ~/.ssh/known_hosts' : ''}.
        </p>
      ) : (
        <>
          {preview.hosts.length > 0 && (
            <ul className="import-list" aria-label="Hosts found">
              {preview.hosts.map((h) => (
                <li key={h.alias}>
                  <label className="check">
                    <input
                      type="checkbox"
                      disabled={h.exists}
                      checked={!h.exists && chosen.has(h.alias)}
                      onChange={(e) => toggle(h.alias, e.target.checked)}
                    />
                    <span>
                      <b>{h.alias}</b>{' '}
                      <span className="muted">
                        {h.username ? `${h.username}@` : ''}
                        {h.address}
                        {h.port !== 22 ? `:${h.port}` : ''}
                        {h.key ? ` · key ${h.key}` : ''}
                        {h.exists ? ' · already in your vault' : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {known.add > 0 && (
            <label className="check">
              <input type="checkbox" checked={trustKnown} onChange={(e) => setTrustKnown(e.target.checked)} />
              <span>Also trust the {count(known.add, 'host key')} from known_hosts</span>
            </label>
          )}
        </>
      )}
      {preview.notes.length > 0 && (
        <ul className="import-notes">
          {preview.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
      <div className="modal-actions">
        {!paste && (
          <Button
            variant="ghost"
            onClick={() => {
              setPreview(null)
              setPaste({ config: '', knownHosts: '' })
            }}
          >
            Paste instead
          </Button>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={busy || (chosen.size === 0 && !(trustKnown && known.add > 0))}
          onClick={() => void run(async () => setResult(await api.sshImportApply([...chosen], trustKnown)))}
        >
          {chosen.size > 0 ? `Import ${count(chosen.size, 'host')}` : 'Import host keys'}
        </Button>
      </div>
    </Modal>
  )
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
