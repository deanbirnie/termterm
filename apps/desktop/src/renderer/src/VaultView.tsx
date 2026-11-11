import { Braces, Fingerprint, KeyRound, RefreshCw, Server, Settings } from 'lucide-react'
import { useState } from 'react'
import type { ConnectTarget, VaultSnapshot } from '../../shared/api'
import { HostsPage } from './pages/Hosts'
import { KeychainPage } from './pages/Keychain'
import { KnownHostsPage } from './pages/KnownHosts'
import { SettingsPage } from './pages/Settings'
import { SnippetsPage } from './pages/Snippets'
import { SyncPage } from './pages/Sync'

const PAGES = [
  { id: 'hosts', label: 'Hosts', icon: Server },
  { id: 'keychain', label: 'Keychain', icon: KeyRound },
  { id: 'snippets', label: 'Snippets', icon: Braces },
  { id: 'known', label: 'Known Hosts', icon: Fingerprint },
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
  onConnect: (target: ConnectTarget, title: string) => void
}) {
  const [page, setPage] = useState<PageId>('hosts')
  const { sync } = snapshot
  const syncDot = !sync.configured ? 'off' : sync.state === 'error' ? 'error' : sync.state === 'syncing' ? 'busy' : 'ok'

  return (
    <div className="vault">
      <nav className="sidebar" aria-label="Vault">
        {PAGES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${page === id ? 'active' : ''}`}
            aria-current={page === id ? 'page' : undefined}
            title={id === 'sync' ? `Sync: ${SYNC_LABEL[syncDot]}` : undefined}
            onClick={() => setPage(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
            {id === 'sync' && <i className={`dot dot-${syncDot}`} aria-hidden="true" />}
          </button>
        ))}
      </nav>
      <section className="page">
        {page === 'hosts' && <HostsPage snapshot={snapshot} onConnect={onConnect} />}
        {page === 'keychain' && <KeychainPage snapshot={snapshot} />}
        {page === 'snippets' && <SnippetsPage snapshot={snapshot} />}
        {page === 'known' && <KnownHostsPage snapshot={snapshot} />}
        {page === 'sync' && <SyncPage sync={sync} />}
        {page === 'settings' && <SettingsPage synced={sync.configured} />}
      </section>
    </div>
  )
}
