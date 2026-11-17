import { ArrowLeftRight, Braces, Fingerprint, KeyRound, RefreshCw, Server, Settings } from 'lucide-react'
import { useState } from 'react'
import type { ConnectTarget, VaultSnapshot } from '@termterm/app'
import { ForwardingPage } from './pages/Forwarding'
import { HostsPage } from './pages/Hosts'
import { KeychainPage } from './pages/Keychain'
import { KnownHostsPage } from './pages/KnownHosts'
import { SettingsPage } from './pages/Settings'
import { SnippetsPage } from './pages/Snippets'
import { SyncPage } from './pages/Sync'
import { useAppInfo } from './Update'

const PAGES = [
  { id: 'hosts', label: 'Hosts', icon: Server },
  { id: 'keychain', label: 'Keychain', icon: KeyRound },
  { id: 'snippets', label: 'Snippets', icon: Braces },
  { id: 'known', label: 'Known Hosts', short: 'Known', icon: Fingerprint },
  { id: 'forwarding', label: 'Forwarding', short: 'Ports', icon: ArrowLeftRight },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'settings', label: 'Settings', icon: Settings },
] as const

const SYNC_LABEL = { off: 'not set up', ok: 'up to date', busy: 'syncing', error: 'needs attention' }

type PageId = (typeof PAGES)[number]['id']

export function VaultView({
  snapshot,
  onConnect,
}: {
  snapshot: VaultSnapshot
  onConnect: (target: ConnectTarget, title: string, kind?: 'files') => void
}) {
  const [page, setPage] = useState<PageId>('hosts')
  const { sync } = snapshot
  const info = useAppInfo()
  const syncDot = !sync.configured ? 'off' : sync.state === 'error' || sync.rollback ? 'error' : sync.state === 'syncing' ? 'busy' : 'ok'

  return (
    <div className="vault">
      <nav className="sidebar" aria-label="Vault">
        {PAGES.map((p) => {
          const { id, label, icon: Icon } = p
          const short = 'short' in p ? p.short : undefined
          return (
          <button
            key={id}
            aria-label={label}
            className={`nav-item ${page === id ? 'active' : ''}`}
            aria-current={page === id ? 'page' : undefined}
            title={id === 'sync' ? `Sync: ${SYNC_LABEL[syncDot]}` : undefined}
            onClick={() => setPage(id)}
          >
            <Icon size={16} />
            {/* The phone's bottom bar has room for short names only. */}
            <span className={short ? 'nav-long' : undefined}>{label}</span>
            {short && <span className="nav-short">{short}</span>}
            {id === 'sync' && <i className={`dot dot-${syncDot}`} aria-hidden="true" />}
          </button>
          )
        })}
        {info && <span className="sidebar-version">v{info.version}</span>}
      </nav>
      <section className="page">
        {page === 'hosts' && <HostsPage snapshot={snapshot} onConnect={onConnect} />}
        {page === 'keychain' && <KeychainPage snapshot={snapshot} />}
        {page === 'snippets' && <SnippetsPage snapshot={snapshot} />}
        {page === 'known' && <KnownHostsPage snapshot={snapshot} />}
        {page === 'forwarding' && <ForwardingPage snapshot={snapshot} />}
        {page === 'sync' && <SyncPage sync={sync} />}
        {page === 'settings' && <SettingsPage synced={sync.configured} />}
      </section>
    </div>
  )
}
