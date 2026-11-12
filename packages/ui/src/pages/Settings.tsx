import { TriangleAlert } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { Settings, LocalShell } from '@termterm/app'
import { api } from '../api'
import {
  DEFAULT_LINE_HEIGHT,
  FONT_MAX,
  FONT_MIN,
  LINE_HEIGHTS,
  getTerminalPrefs,
  onTerminalPrefs,
  setTerminalPrefs,
} from '../terminal-prefs'
import { notePasswordUsed, REMINDER_DAYS } from '../password-reminder'
import { AboutCard, useAppInfo } from '../Update'
import { Button, ErrorText, Field, useAction } from '../ui'

const AUTO_LOCK = [
  { minutes: 5, label: 'After 5 minutes' },
  { minutes: 15, label: 'After 15 minutes' },
  { minutes: 30, label: 'After 30 minutes' },
  { minutes: 60, label: 'After 1 hour' },
  { minutes: 0, label: 'Never' },
]

export function SettingsPage({ synced }: { synced: boolean }) {
  return (
    <div className="split-main narrow-page">
      <h2 className="section-title">Settings</h2>
      <AutoLock />
      <h2 className="section-title spaced">Terminal</h2>
      <TerminalAppearance />
      <DefaultShell />
      <h2 className="section-title spaced">Master password</h2>
      <ChangePassword synced={synced} />
      <h2 className="section-title spaced">About</h2>
      <AboutCard />
      <UpdatePreference />
    </div>
  )
}

function UpdatePreference() {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void api.settings().then(setSettings)
  }, [])
  if (!settings) return null
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={settings.autoCheckUpdates}
        onChange={(e) => {
          const patch = { autoCheckUpdates: e.target.checked }
          setSettings({ ...settings, ...patch })
          void api.saveSettings(patch).then(setSettings, () => setSettings(settings))
        }}
      />
      <span>Check for updates when the app starts</span>
    </label>
  )
}

/** Which shell the Terminal button opens, on platforms that have local terminals. */
function DefaultShell() {
  const info = useAppInfo()
  const [shells, setShells] = useState<LocalShell[]>([])
  const [chosen, setChosen] = useState('')
  const { error, run } = useAction()
  useEffect(() => {
    if (!info?.capabilities.localTerminal) return
    void api.localShells().then(setShells)
    void api.settings().then((s) => setChosen(s.defaultShell ?? ''))
  }, [info?.capabilities.localTerminal])
  if (!info?.capabilities.localTerminal || shells.length === 0) return null
  // Sorted by name, so the list does not reorder when the default changes.
  const sorted = [...shells].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className="form-card spaced-card">
      <Field label="Terminal on this computer" hint="What the Terminal button and Ctrl+Shift+T open. The arrow next to the button opens any of the others.">
        <select
          value={chosen}
          onChange={(e) => {
            const value = e.target.value
            setChosen(value)
            void run(() => api.saveSettings({ defaultShell: value }))
          }}
        >
          <option value="">System default</option>
          {sorted.map((shell) => (
            <option key={shell.id} value={shell.id}>
              {shell.name}
            </option>
          ))}
        </select>
      </Field>
      <ErrorText error={error} />
    </div>
  )
}

function TerminalAppearance() {
  const [prefs, setPrefs] = useState(getTerminalPrefs)
  // Stay in step with the size buttons in an open terminal.
  useEffect(() => onTerminalPrefs(setPrefs), [])
  const sizes = Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => FONT_MIN + i)
  return (
    <div className="form-card">
      <Field label="Line spacing" hint="The space between rows of text. Applies to open sessions straight away.">
        <select
          value={prefs.lineHeight}
          onChange={(e) => setPrefs(setTerminalPrefs({ lineHeight: Number(e.target.value) }))}
        >
          {LINE_HEIGHTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.value === DEFAULT_LINE_HEIGHT ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Text size">
        <select
          value={prefs.fontSize ?? ''}
          onChange={(e) =>
            setPrefs(setTerminalPrefs({ fontSize: e.target.value === '' ? null : Number(e.target.value) }))
          }
        >
          <option value="">Default</option>
          {sizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

function AutoLock() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [canRemember, setCanRemember] = useState(false)
  const info = useAppInfo()
  const biometric = info?.capabilities.biometricUnlock ?? false
  const hello = info?.capabilities.biometricName
  const phone = info?.platform === 'mobile'
  const { error, run } = useAction()
  useEffect(() => {
    void api.settings().then(setSettings)
    void api.deviceUnlockAvailable().then(setCanRemember)
  }, [])
  if (!settings) return null
  // Show the change at once; fall back to what was saved if it is refused.
  const update = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch })
    void run(async () => setSettings(await api.saveSettings(patch))).then((ok) => {
      if (!ok) setSettings(settings)
    })
  }
  return (
    <div className="form-card">
      <Field
        label="Lock the vault automatically"
        hint={
          settings.autoLockMinutes > 0
            ? phone
              ? 'Locks after the app has been in the background this long. Open sessions keep running while locked.'
              : 'Also locks when the computer sleeps or its screen is locked. Open sessions keep running while locked.'
            : 'The vault stays unlocked until you lock it or quit.'
        }
      >
        <select
          value={settings.autoLockMinutes}
          onChange={(e) => update({ autoLockMinutes: Number(e.target.value) })}
        >
          {AUTO_LOCK.map((o) => (
            <option key={o.minutes} value={o.minutes}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.rememberDevice}
          disabled={!canRemember && !settings.rememberDevice}
          aria-describedby="remember-hint"
          onChange={(e) => update({ rememberDevice: e.target.checked })}
        />
        <span>
          {biometric ? `Unlock with ${hello ?? 'fingerprint or face'}` : 'Open unlocked on this device'}
        </span>
      </label>
      <p className="field-hint" id="remember-hint">
        {biometric && hello
          ? `Keeps the vault key locked by ${hello} (face, fingerprint or PIN), using this computer\u2019s security chip. The lock screen asks for it instead of your master password, which always still works.`
          : biometric
          ? canRemember
            ? 'Keeps the vault key in this phone\u2019s secure hardware, released only by your fingerprint or face. Your master password still works, and is needed again if you add a new fingerprint.'
            : 'Not available: set up a fingerprint or face unlock in this phone\u2019s settings first.'
          : canRemember
            ? 'Keeps the vault key in this computer\u2019s credential store, so the app starts without asking for the master password. Locking the vault, by hand or automatically, removes it until you next enter the password.'
            : 'Not available: this computer has no secure credential store.'}
      </p>
      {biometric && (canRemember || settings.rememberDevice) && (
        <p className="warning" role="note">
          <TriangleAlert size={16} />
          <span>
            {hello ?? 'Fingerprint unlock'} does not replace your master password. You still need it
            to set up new devices and sync, and if {hello ?? 'fingerprint unlock'} is reset. It
            cannot be recovered if forgotten, so keep it in a password manager. As a reminder, it
            is asked for if it has not been used here for {REMINDER_DAYS} days.
          </span>
        </p>
      )}
      <ErrorText error={error} />
    </div>
  )
}

function ChangePassword({ synced }: { synced: boolean }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)
  const { busy, error, run, setError } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setDone(false)
    if (next !== confirm) return setError('The new passwords do not match')
    void run(async () => {
      await api.changePassword(current, next)
      notePasswordUsed()
    }).then((ok) => {
      if (!ok) return
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
    })
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <p className="muted">
        {synced
          ? 'Your other devices will be signed out of sync and will ask for the new password. Nothing in the vault is lost.'
          : 'Changes the password that unlocks the vault on this device.'}
      </p>
      <Field label="Current master password">
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New master password">
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirm new master password" hint="There is no reset. If you forget it, the vault cannot be recovered.">
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      {done && <p className="success" role="status">Master password changed.</p>}
      <div className="panel-actions">
        <Button variant="primary" type="submit" disabled={busy || !current || !next || !confirm}>
          {busy ? 'Changing…' : 'Change master password'}
        </Button>
      </div>
    </form>
  )
}
