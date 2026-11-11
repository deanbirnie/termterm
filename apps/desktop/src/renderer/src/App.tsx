import { Lock, Plus, Server, Terminal as TerminalIcon, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AppPhase, ConnectTarget, SshPrompt, VaultSnapshot } from '../../shared/api'
import { api } from './api'
import { Onboarding, Unlock } from './Auth'
import { PromptDialog } from './Prompts'
import { TerminalTab } from './TerminalTab'
import { VaultView } from './VaultView'

export interface SessionTab {
  id: string
  title: string
  target: ConnectTarget
}

export function App() {
  const [phase, setPhase] = useState<AppPhase | null>(null)

  useEffect(() => {
    void api.phase().then(setPhase)
    return api.onPhase(setPhase)
  }, [])

  if (phase === null) return null
  if (phase === 'new') return <Onboarding />
  // The workspace stays mounted while locked so open sessions survive; it is
  // hidden and holds no vault data until the vault is unlocked again.
  return <Workspace locked={phase === 'locked'} />
}

function Workspace({ locked }: { locked: boolean }) {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [tabs, setTabs] = useState<SessionTab[]>([])
  const [active, setActive] = useState('vault')
  const [prompts, setPrompts] = useState<SshPrompt[]>([])

  useEffect(() => {
    if (locked) {
      setSnapshot(null)
      return
    }
    let current = true
    void api.snapshot().then((s) => current && setSnapshot(s))
    const off = api.onSnapshot(setSnapshot)
    return () => {
      current = false
      off()
    }
  }, [locked])

  useEffect(() => api.onSshPrompt((p) => setPrompts((q) => [...q, p])), [])

  const connect = useCallback((target: ConnectTarget, title: string) => {
    const id = crypto.randomUUID()
    setTabs((t) => [...t, { id, title, target }])
    setActive(id)
  }, [])

  const closeTab = useCallback((id: string) => {
    api.sshClose(id)
    setPrompts((q) => q.filter((p) => p.sessionId !== id))
    setTabs((t) => {
      const index = t.findIndex((x) => x.id === id)
      const next = t.filter((x) => x.id !== id)
      setActive((a) => (a === id ? (next[Math.min(index, next.length - 1)]?.id ?? 'vault') : a))
      return next
    })
  }, [])

  const ready = !locked && snapshot !== null
  const prompt = ready ? prompts[0] : undefined

  return (
    <>
    {locked && <Unlock sessions={tabs.length} />}
    <div className="app" hidden={!ready}>
      <header className="tabbar">
        <button
          className={`tab tab-vault ${active === 'vault' ? 'active' : ''}`}
          onClick={() => setActive('vault')}
        >
          <Server size={15} /> Vault
        </button>
        <div className="tabs" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active === tab.id}
              className={`tab ${active === tab.id ? 'active' : ''}`}
              onClick={() => setActive(tab.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
              title={tab.title}
            >
              <TerminalIcon size={14} />
              <span className="tab-title">{tab.title}</span>
              <button
                className="tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          {tabs.length > 0 && (
            <button className="tab-new" aria-label="New connection" onClick={() => setActive('vault')}>
              <Plus size={16} />
            </button>
          )}
        </div>
        <button className="icon-btn" title="Lock vault" aria-label="Lock vault" onClick={() => void api.lock()}>
          <Lock size={16} />
        </button>
      </header>

      <main className="content">
        <div className="pane" hidden={active !== 'vault'}>
          {snapshot && <VaultView snapshot={snapshot} onConnect={connect} />}
        </div>
        {tabs.map((tab) => (
          <div key={tab.id} className="pane" hidden={active !== tab.id}>
            <TerminalTab
              tab={tab}
              active={active === tab.id}
              snippets={snapshot?.snippets ?? []}
              onClose={() => closeTab(tab.id)}
            />
          </div>
        ))}
      </main>

      {prompt && (
        <PromptDialog
          key={prompt.promptId}
          prompt={prompt}
          onReply={(reply) => {
            api.sshPromptReply(prompt.promptId, reply)
            setPrompts((q) => q.filter((p) => p.promptId !== prompt.promptId))
          }}
        />
      )}
    </div>
    </>
  )
}
