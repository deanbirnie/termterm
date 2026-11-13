import {
  cloneElement,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { errorMessage } from './api'

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
}) {
  return <button type="button" {...props} className={`btn btn-${variant} ${className}`} />
}

/**
 * A password input with a button to show what has been typed. Use it like an
 * input (inside a Field it takes the label's id). Hidden again whenever the
 * field is emptied, so a revealed password does not carry over to the next one.
 */
export function PasswordInput({
  id,
  'aria-describedby': describedBy,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { id?: string; 'aria-describedby'?: string }) {
  const [shown, setShown] = useState(false)
  const empty = props.value === undefined || props.value === ''
  useEffect(() => {
    if (empty) setShown(false)
  }, [empty])
  return (
    <div className="password-input">
      <input
        {...props}
        id={id}
        aria-describedby={describedBy}
        type={shown ? 'text' : 'password'}
        // Revealed text is still a password: no autocorrect or capitals on phones.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="password-toggle"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-controls={id}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
        // Keeps the focus (and the phone keyboard) in the field.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  )
}

/** Labels its single form control; the hint is linked as a description, not part of the name. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  )
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null
}

export function Modal({
  title,
  tone,
  children,
  onClose,
}: {
  title: string
  tone?: 'danger'
  children: ReactNode
  onClose?: () => void
}) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop">
      <div className={`modal ${tone ?? ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  )
}

/** Runs an async action, tracking its busy state and the error to show. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

/** Shown under a sync server field when the address would send the sign-in unencrypted. */
export function InsecureUrlHint({ url }: { url: string }) {
  const value = url.trim().toLowerCase()
  if (!value.startsWith('http://')) return null
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(value)) return null
  return (
    <p className="warning" role="note">
      <span>
        This address uses plain HTTP. Your vault contents stay encrypted, but anyone on the same
        network could intercept your sign-in. Use an https:// address if the server is reachable
        from outside your home network.
      </span>
    </p>
  )
}
