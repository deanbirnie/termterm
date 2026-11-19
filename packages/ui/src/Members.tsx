import { TriangleAlert, UserMinus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { MemberView, VaultSnapshot, VaultView } from '@termterm/app'
import { api } from './api'
import { Button, ErrorText, Field, Modal, PasswordInput, useAction } from './ui'

/**
 * Settings → Vaults → Members: who shares a synced vault, and (for admins)
 * adding, promoting and removing them. Also your own key for the vault.
 */
export function MembersDialog({ vault, snapshot, onClose }: { vault: VaultView; snapshot: VaultSnapshot; onClose: () => void }) {
  const [members, setMembers] = useState<MemberView[] | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const { busy, error, run } = useAction()
  const load = () => run(async () => setMembers(await api.vaultMembers(vault.id)))
  useEffect(() => {
    void load()
  }, [vault.id, snapshot.activeVaultId === vault.id ? snapshot.sharedAs?.key?.publicKey : null])
  const admin = vault.role !== 'member'
  const me = members?.find((m) => m.you)
  return (
    <Modal title={`Members of ${vault.name}`} wide onClose={onClose}>
      {members && (
        <ul className="vault-list member-list" aria-label="Members">
          {members.map((m) => (
            <li key={m.username} aria-label={m.username}>
              <div className="server-head">
                <span>
                  <strong>{m.username}</strong>
                  {m.you && <span className="muted"> · you</span>}
                  <br />
                  <small className="muted mono">{m.fingerprint ?? 'no key pair yet'}</small>
                </span>
                <span className="vault-actions">
                  {admin && !m.you ? (
                    <>
                      <select
                        aria-label={`Role of ${m.username}`}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) => void run(async () => {
                          await api.setMemberRole(vault.id, m.username, e.target.value as 'admin' | 'member')
                          setMembers(await api.vaultMembers(vault.id))
                        })}
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                      <button className="icon-btn" aria-label={`Remove ${m.username}`} title="Remove" onClick={() => setRemoving(m.username)}>
                        <UserMinus size={15} />
                      </button>
                    </>
                  ) : (
                    <span className="muted">{m.role === 'admin' ? 'Admin' : 'Member'}</span>
                  )}
                </span>
              </div>
              {m.key && (
                <details>
                  <summary>Own key ({m.key.keyType.replace(/^ssh-/, '')}{m.key.certificate ? ', with certificate' : ''})</summary>
                  <textarea className="mono" rows={3} readOnly value={m.key.publicKey} aria-label={`Public key of ${m.username}`} />
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Admins change hosts, logins and members. Members connect only. Each person’s fingerprint is shown on their Sync
        page.
      </p>
      <ErrorText error={error} />
      {admin && members && <AddMember vaultId={vault.id} onAdded={() => void load()} />}
      {me && snapshot.activeVaultId === vault.id && <OwnKey snapshot={snapshot} />}
      {me && snapshot.activeVaultId !== vault.id && (
        <p className="field-hint">To set your own key for this vault, switch to it first.</p>
      )}
      {removing && (
        <Modal title={`Remove ${removing}?`} tone="danger" onClose={() => setRemoving(null)}>
          <p>
            {removing} loses access, and the vault gets a new key, so later changes do not reach them. But their device
            keeps what it already had.
          </p>
          <p className="warning">
            <TriangleAlert size={16} />
            <span>Change the passwords and keys {removing} could use on your servers.</span>
          </p>
          <div className="modal-actions">
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.removeMember(vault.id, removing)
                  setRemoving(null)
                  setMembers(await api.vaultMembers(vault.id))
                })
              }
            >
              Remove and change the vault key
            </Button>
          </div>
        </Modal>
      )}
      <div className="modal-actions">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  )
}

function AddMember({ vaultId, onAdded }: { vaultId: string; onAdded: () => void }) {
  const [username, setUsername] = useState('')
  const [found, setFound] = useState<{ username: string; fingerprint: string } | null>(null)
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const { busy, error, run } = useAction()
  const find = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => setFound(await api.lookupMember(vaultId, username)))
  }
  if (!found) {
    return (
      <form onSubmit={find} aria-label="Add a member">
        <h3 className="group-title">Add a member</h3>
        <Field label="Their username on this server">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" disabled={busy || !username.trim()}>
          Find
        </Button>
      </form>
    )
  }
  return (
    <section aria-label="Add a member">
      <h3 className="group-title">Add {found.username}</h3>
      <p className="warning">
        <TriangleAlert size={16} />
        <span>
          Ask {found.username} to read out the fingerprint on their Sync page (by phone or in person, not by a message on
          this server). Add them only if it is the same:
        </span>
      </p>
      <p className="fingerprint mono" aria-label="Fingerprint">
        {found.fingerprint}
      </p>
      <Field label="Role">
        <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
          <option value="member">Member: connects only</option>
          <option value="admin">Admin: changes hosts, logins and members</option>
        </select>
      </Field>
      <ErrorText error={error} />
      <div className="panel-actions">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.addMember(vaultId, { username: found.username, role, fingerprint: found.fingerprint })
              setFound(null)
              setUsername('')
              onAdded()
            })
          }
        >
          It matches: add {found.username}
        </Button>
        <Button variant="ghost" onClick={() => setFound(null)}>
          Cancel
        </Button>
      </div>
    </section>
  )
}

/** Your own key for the shared vault shown: only your devices can use it; the admins see its public half. */
function OwnKey({ snapshot }: { snapshot: VaultSnapshot }) {
  const key = snapshot.sharedAs?.key
  const [importing, setImporting] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [certificate, setCertificate] = useState('')
  const { busy, error, run } = useAction()
  return (
    <section aria-label="Your own key">
      <h3 className="group-title">Your own key</h3>
      <p className="field-hint">
        Used with your personal login on hosts that use personal logins. Its private key stays on your devices; the admins
        see its public key, to put on the servers (or sign a certificate for it).
      </p>
      {key ? (
        <>
          <textarea className="mono" rows={3} readOnly value={key.publicKey} aria-label="Your public key" />
          <p className="field-hint">
            {key.fingerprint}
            {key.certificate ? ' · with a certificate' : ''}
          </p>
          {!key.certificate && (
            <Field label="Certificate" hint="If your servers trust a certificate authority: the -cert.pub line it signed for this key.">
              <textarea className="mono" rows={3} value={certificate} onChange={(e) => setCertificate(e.target.value)} />
            </Field>
          )}
          <div className="panel-actions">
            {!key.certificate && (
              <Button disabled={busy || !certificate.trim()} onClick={() => void run(() => api.setMemberKeyCertificate(certificate))}>
                Add certificate
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.removeMemberKey())}>
              Remove your key
            </Button>
          </div>
        </>
      ) : importing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api.importMemberKey({ label: 'own key', privateKey, passphrase: passphrase || undefined })
              if (certificate.trim()) await api.setMemberKeyCertificate(certificate)
              setImporting(false)
            })
          }}
        >
          <Field label="Private key">
            <textarea className="mono" rows={5} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
          </Field>
          <Field label="Passphrase" hint="Only if the key has one.">
            <PasswordInput value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          <Field label="Certificate" hint="Optional: the -cert.pub line for this key, if you have one.">
            <textarea className="mono" rows={3} value={certificate} onChange={(e) => setCertificate(e.target.value)} />
          </Field>
          <div className="panel-actions">
            <Button type="submit" disabled={busy || !privateKey.trim()}>
              Import key
            </Button>
            <Button variant="ghost" onClick={() => setImporting(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="panel-actions">
          <Button disabled={busy} onClick={() => void run(() => api.generateMemberKey('ed25519'))}>
            Make a new key
          </Button>
          <Button variant="ghost" onClick={() => setImporting(true)}>
            Import a key you have
          </Button>
        </div>
      )}
      <ErrorText error={error} />
    </section>
  )
}
