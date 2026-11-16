import { ArrowDownCircle, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppInfo, UpdateState } from '@termterm/app'
import { api } from './api'
import { Button } from './ui'

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    void api.updateState().then(setState)
    return api.onUpdateState(setState)
  }, [])
  return state
}

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void api.appInfo().then(setInfo)
  }, [])
  return info
}

const LATEST_RELEASE = 'https://github.com/deanbirnie/termterm/releases/latest'

/**
 * The one action that moves an update forward from its current state: a
 * button, or a link where the update is downloaded and installed by hand.
 */
function nextStep(state: UpdateState): { label: string; run?: () => void; href?: string } | null {
  switch (state.status) {
    case 'available':
      return state.downloadUrl
        ? { label: `Download ${state.version}`, href: state.downloadUrl }
        : { label: `Update to ${state.version}`, run: () => void api.updateDownload() }
    case 'ready':
      return { label: state.install ? 'Install update' : 'Restart to update', run: () => void api.updateInstall() }
    default:
      return null
  }
}

/** Shown in the title bar only while there is an update to act on. */
export function UpdatePill() {
  const state = useUpdateState()
  if (!state) return null
  if (state.status === 'downloading') {
    return (
      <span className="update-pill" role="status">
        Downloading update {state.percent}%
      </span>
    )
  }
  const step = nextStep(state)
  if (!step) return null
  if (step.href) {
    return (
      <a className="update-pill action" href={step.href} target="_blank" rel="noreferrer">
        <ArrowDownCircle size={14} /> {step.label}
      </a>
    )
  }
  return (
    <button className="update-pill action" onClick={step.run}>
      <ArrowDownCircle size={14} /> {step.label}
    </button>
  )
}

function describe(state: UpdateState): string {
  switch (state.status) {
    case 'unsupported':
      return state.reason
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'current':
      return `You have the latest version. Checked ${new Date(state.checkedAt).toLocaleTimeString()}.`
    case 'available':
      return state.downloadUrl
        ? `Version ${state.version} is available. Download it, then open the file to install it over this one; your vault is kept.`
        : `Version ${state.version} is available.`
    case 'downloading':
      return `Downloading version ${state.version}: ${state.percent}%`
    case 'ready':
      return state.install
        ? `Version ${state.version} is downloaded. Installing it closes the app; your vault is kept.`
        : `Version ${state.version} is downloaded. Restarting closes any open sessions.`
    case 'error':
      return state.message
  }
}

export function AboutCard() {
  const info = useAppInfo()
  const state = useUpdateState()
  if (!info || !state) return null
  const step = nextStep(state)
  const canCheck = ['idle', 'current', 'error'].includes(state.status)
  return (
    <div className="form-card">
      <dl className="facts">
        <dt>Version</dt>
        <dd>
          {info.version}
          {!info.packaged && ' (development build)'}
          {' · '}
          <a
            className="link"
            href={`https://github.com/deanbirnie/termterm/releases/tag/v${info.version}`}
            target="_blank"
            rel="noreferrer"
          >
            Release notes
          </a>
          {' · '}
          <a className="link" href={LATEST_RELEASE} target="_blank" rel="noreferrer">
            Latest release
          </a>
        </dd>
        <dt>Updates</dt>
        <dd className={state.status === 'error' ? 'error' : undefined} role="status">
          {describe(state)}
        </dd>
      </dl>
      <div className="panel-actions">
        {step?.href && (
          <a className="btn btn-primary" href={step.href} target="_blank" rel="noreferrer">
            {step.label}
          </a>
        )}
        {step?.run && (
          <Button variant="primary" onClick={step.run}>
            {step.label}
          </Button>
        )}
        {(canCheck || state.status === 'checking') && (
          <Button disabled={!canCheck} onClick={() => void api.updateCheck()}>
            Check for updates
          </Button>
        )}
      </div>
    </div>
  )
}

const DISMISSED_KEY = 'termterm.updateCardDismissed'

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

/** Changes listed per version in the card before it points to the release page. */
const MAX_CHANGES = 6

/**
 * "New update": shown once a newer version is found, with what changed since
 * the installed one. Update starts the download (the title bar then shows its
 * progress and the restart or install button); Not now hides the card for
 * that version, leaving the title bar button.
 */
export function UpdateCard() {
  const state = useUpdateState()
  const [dismissed, setDismissed] = useState(dismissedVersion)
  if (state?.status !== 'available' || dismissed === state.version) return null
  const version = state.version
  const notNow = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, version)
    } catch {
      // without storage it is hidden until the app restarts
    }
    setDismissed(version)
  }
  const notes = state.notes ?? []
  return (
    <section className="update-card" role="dialog" aria-labelledby="update-card-title">
      <h2 id="update-card-title">
        <Sparkles size={16} /> New update: version {version}
      </h2>
      <div className="update-notes">
        {notes.length === 0 && <p>A newer version of termterm is available.</p>}
        {notes.map((n) => (
          <div key={n.version}>
            {notes.length > 1 && <h3>{n.version}</h3>}
            {n.changes.length > 0 ? (
              <ul>
                {n.changes.slice(0, MAX_CHANGES).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            ) : null}
            {(n.changes.length === 0 || n.changes.length > MAX_CHANGES) && (
              <a className="link" href={n.url} target="_blank" rel="noreferrer">
                {n.changes.length > MAX_CHANGES ? `and ${n.changes.length - MAX_CHANGES} more` : `What's new in ${n.version}`}
              </a>
            )}
          </div>
        ))}
      </div>
      <div className="update-card-actions">
        <Button onClick={notNow}>Not now</Button>
        {state.downloadUrl ? (
          <a className="btn btn-primary" href={state.downloadUrl} target="_blank" rel="noreferrer" onClick={notNow}>
            Download
          </a>
        ) : (
          <Button variant="primary" onClick={() => void api.updateDownload()}>
            Update
          </Button>
        )}
      </div>
    </section>
  )
}
