import { Fingerprint, Trash2 } from 'lucide-react'
import type { VaultSnapshot } from '@termterm/app'
import { api } from '../api'
import { Empty } from '../ui'

export function KnownHostsPage({ snapshot }: { snapshot: VaultSnapshot }) {
  if (snapshot.knownHosts.length === 0) {
    return (
      <Empty icon={<Fingerprint size={28} />} title="No known hosts yet">
        The first time you connect to a server you confirm its key fingerprint. It is saved here
        so every device warns you if that key ever changes.
      </Empty>
    )
  }
  return (
    <div className="split-main">
      <h2 className="section-title">Known hosts</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Host</th>
            <th>Key type</th>
            <th>Fingerprint</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {snapshot.knownHosts.map((k) => (
            <tr key={k.id}>
              <td>{k.port === 22 ? k.host : `${k.host}:${k.port}`}</td>
              <td>{k.keyType}</td>
              <td className="mono">{k.fingerprint}</td>
              <td>
                <button
                  className="icon-btn"
                  title="Forget this host key"
                  aria-label={`Forget key for ${k.host}`}
                  onClick={() => void api.deleteItem(k.id)}
                >
                  <Trash2 size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
