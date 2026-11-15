import { useEffect, useState } from 'react'
import type { AppPhase } from '@termterm/app'
import { api } from './api'
import { Onboarding } from './Auth'
import { Workspace } from './Workspace'

export type { SessionTab } from './Workspace'

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
