import { Fingerprint, KeyRound } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from './api'
import { notePasswordUsed, passwordReminderDue, REMINDER_DAYS } from './password-reminder'
import { useAppInfo } from './Update'
import { Button, ErrorText, Field, InsecureUrlHint, PasswordInput, useAction } from './ui'

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
  /** Whether a fingerprint / face / Windows Hello unlock is set up; null while asking. */
  const [biometric, setBiometric] = useState<boolean | null>(null)
  /** With both options on offer, which one the user picked. Nothing happens until they pick. */
  const [mode, setMode] = useState<'choose' | 'password'>('choose')
  /** Set when the master password has not been used for a while, so it is asked for first. */
  const [reminder, setReminder] = useState(false)
  const info = useAppInfo()
  const biometricName = info?.capabilities.biometricName ?? 'fingerprint or face'
  const { busy, error, run, setError } = useAction()

  const unlockWithBiometrics = () =>
    void run(async () => {
      try {
        await api.biometricUnlock()
      } catch (e) {
        // Dismissing the system prompt is a choice, not an error to report.
        if (errorMessage(e) === 'Cancelled') return
        // For example "needs setting up again": the password is the way in now.
        setBiometric(await api.biometricUnlockAvailable().catch(() => false))
        setMode('password')
        throw e
      }
    })

  useEffect(() => {
    let current = true
    void api
      .biometricUnlockAvailable()
      .catch(() => false)
      .then((available) => {
        if (!current) return
        setBiometric(available)
        if (available && passwordReminderDue()) {
          setReminder(true)
          setMode('password')
          return
        }
        // On a phone the fingerprint prompt is expected straight away. On a
        // computer nothing pops up until the user chooses.
        if (available && info?.platform === 'mobile') unlockWithBiometrics()
      })
    return () => {
      current = false
    }
  }, [info?.platform])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api.unlock(password)
      notePasswordUsed()
    })
  }
  const choose = (next: 'choose' | 'password') => {
    setError(null)
    setMode(next)
  }

  const running =
    sessions > 0 ? ` ${sessions} open session${sessions > 1 ? 's are' : ' is'} still running.` : ''
  const choosing = biometric === true && mode === 'choose'

  return (
    <Shell
      title="Vault locked"
      subtitle={
        choosing
          ? `Choose how to unlock.${running}`
          : sessions > 0
            ? `Enter your master password to unlock.${running}`
            : 'Enter your master password to unlock your hosts and keys.'
      }
    >
      {biometric === null ? null : choosing ? (
        <div className="unlock-choices">
          <Button variant="primary" className="wide" disabled={busy} autoFocus onClick={unlockWithBiometrics}>
            <Fingerprint size={16} /> {busy ? 'Waiting for ' + biometricName + '…' : `Unlock with ${biometricName}`}
          </Button>
          <Button className="wide spaced" disabled={busy} onClick={() => choose('password')}>
            <KeyRound size={16} /> Use master password
          </Button>
          <ErrorText error={error} />
        </div>
      ) : (
        <form onSubmit={submit}>
          {reminder && (
            <p className="note reminder" role="note">
              <KeyRound size={16} />
              <span>
                You have not used your master password on this device for over {REMINDER_DAYS} days.
                Enter it this time so you do not forget it: it cannot be recovered, and you need
                it to set up new devices.
              </span>
            </p>
          )}
          <Field label="Master password">
            <PasswordInput
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorText error={error} />
          <Button variant="primary" type="submit" disabled={busy || !password} className="wide">
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
          {biometric && (
            <Button className="wide spaced" disabled={busy} onClick={unlockWithBiometrics}>
              <Fingerprint size={16} /> Use {biometricName} instead
            </Button>
          )}
        </form>
      )}
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
      void run(async () => {
        await api.createVault(password)
        notePasswordUsed()
      })
    } else {
      void run(async () => {
        await api.signIn({ serverUrl, username, password })
        notePasswordUsed()
      })
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
          <PasswordInput
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
            <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} />
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
