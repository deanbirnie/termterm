import { useState, type FormEvent } from 'react'
import { api } from './api'
import { Button, ErrorText, Field, InsecureUrlHint, useAction } from './ui'

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark">&gt;_</span> termterm
        </div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
      </div>
    </div>
  )
}

export function Unlock({ sessions = 0 }: { sessions?: number }) {
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(() => api.unlock(password))
  }
  return (
    <Shell
      title="Vault locked"
      subtitle={
        sessions > 0
          ? `Enter your master password to unlock. ${sessions} open session${sessions > 1 ? 's are' : ' is'} still running.`
          : 'Enter your master password to unlock your hosts and keys.'
      }
    >
      <form onSubmit={submit}>
        <Field label="Master password">
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorText error={error} />
        <Button variant="primary" type="submit" disabled={busy || !password} className="wide">
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </Shell>
  )
}

export function Onboarding() {
  const [mode, setMode] = useState<'create' | 'signin'>('create')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const { busy, error, run, setError } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (mode === 'create') {
      if (password !== confirm) return setError('The passwords do not match')
      void run(() => api.createVault(password))
    } else {
      void run(() => api.signIn({ serverUrl, username, password }))
    }
  }

  return (
    <Shell
      title={mode === 'create' ? 'Create your vault' : 'Sign in to your vault'}
      subtitle={
        mode === 'create'
          ? 'Hosts, keys and passwords are encrypted on this device with your master password.'
          : 'Connect this device to a vault you already sync from another device.'
      }
    >
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === 'create'} onClick={() => { setMode('create'); setError(null) }}>
          New vault
        </button>
        <button role="tab" aria-selected={mode === 'signin'} onClick={() => { setMode('signin'); setError(null) }}>
          I already have one
        </button>
      </div>
      <form onSubmit={submit}>
        {mode === 'signin' && (
          <>
            <Field label="Sync server">
              <input
                autoFocus
                placeholder="https://sync.example.com"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
            </Field>
            <InsecureUrlHint url={serverUrl} />
            <Field label="Username">
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Master password">
          <input
            type="password"
            autoFocus={mode === 'create'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {mode === 'create' && (
          <Field
            label="Confirm master password"
            hint="There is no reset. If you forget it, the vault cannot be recovered."
          >
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        )}
        <ErrorText error={error} />
        <Button
          variant="primary"
          type="submit"
          className="wide"
          disabled={busy || !password || (mode === 'signin' && (!serverUrl || !username))}
        >
          {busy ? 'Working…' : mode === 'create' ? 'Create vault' : 'Sign in'}
        </Button>
      </form>
    </Shell>
  )
}
