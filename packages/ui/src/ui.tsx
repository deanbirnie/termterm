import {
  cloneElement,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
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
