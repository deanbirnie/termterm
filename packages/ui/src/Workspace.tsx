import {
  Columns2,
  Laptop,
  Lock,
  Maximize2,
  Minimize2,
  Plus,
  Rows2,
  Server,
  SquareArrowOutUpRight,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import type { ConnectTarget, SshPrompt, VaultSnapshot } from '@termterm/app'
import { api } from './api'
import { Unlock } from './Auth'
import {
  dividers,
  equalize,
  insertBeside,
  nearestSide,
  neighbour,
  pane,
  panes,
  rects,
  remove,
  resize,
  splitRect,
  type Layout,
  type Rect,
  type Side,
} from './layout'
import { PromptDialog } from './Prompts'
import { TerminalTab } from './TerminalTab'
import { UpdateCard, UpdatePill, useAppInfo } from './Update'
import { VaultView } from './VaultView'

/** One terminal session: an SSH connection or a shell on this computer. */
export interface SessionTab {
  id: string
  title: string
  target: ConnectTarget
}

/** A tab: one or more sessions arranged in panes. */
interface Tab {
  id: string
  layout: Layout
  /** The pane that has the keyboard. */
  focus: string
  /** A pane shown alone, filling the tab, until zoomed out. */
  zoomed?: string
}

/** Panes are not split smaller than this, in pixels. */
const MIN_PANE = { w: 160, h: 90 }
const HEADER = 26

type Drag = { kind: 'tab'; tabId: string } | { kind: 'pane'; sessionId: string }

const pct = (r: Rect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
})

export function Workspace({ locked }: { locked: boolean }) {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [sessions, setSessions] = useState<Record<string, SessionTab>>({})
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('vault')
  const [prompts, setPrompts] = useState<SshPrompt[]>([])
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<{ sessionId: string; side: Side } | null>(null)
  // Bumped after pane actions so the focused terminal takes the keyboard back
  // from whichever button was clicked.
  const [refocus, setRefocus] = useState(0)
  const takeKeyboard = () => setRefocus((n) => n + 1)
  const mainRef = useRef<HTMLElement>(null)
  const info = useAppInfo()
  // Panes need a screen and a pointer: desktop only.
  const canSplit = info?.platform === 'desktop'
  const localTerminal = info?.capabilities.localTerminal ?? false

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

  // Coming back to the app (switching to it, unlocking the phone, the network
  // returning) syncs straight away instead of waiting for the next minute.
  const syncConfigured = snapshot?.sync.configured ?? false
  useEffect(() => {
    if (locked || !syncConfigured) return
    let last = 0
    const syncNow = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 15_000) return
      last = Date.now()
      void api.syncNow().catch(() => undefined) // shown on the Sync page
    }
    const onVisible = () => document.visibilityState === 'visible' && syncNow()
    window.addEventListener('focus', syncNow)
    window.addEventListener('online', syncNow)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', syncNow)
      window.removeEventListener('online', syncNow)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [locked, syncConfigured])

  const activeTab = tabs.find((t) => t.id === active)
  const tabOf = useCallback((sessionId: string) => tabs.find((t) => panes(t.layout).includes(sessionId)), [tabs])

  // ---- tabs and panes ----------------------------------------------------------

  const newSession = (target: ConnectTarget, title: string): SessionTab => {
    const session = { id: crypto.randomUUID(), title, target }
    setSessions((s) => ({ ...s, [session.id]: session }))
    return session
  }

  const connect = useCallback((target: ConnectTarget, title: string) => {
    const session = newSession(target, title)
    const tab = { id: crypto.randomUUID(), layout: pane(session.id), focus: session.id }
    setTabs((t) => [...t, tab])
    setActive(tab.id)
  }, [])

  const updateTab = (tabId: string, change: (tab: Tab) => Tab | null) =>
    setTabs((all) => {
      const index = all.findIndex((t) => t.id === tabId)
      if (index < 0) return all
      const next = change(all[index]!)
      if (next) return all.map((t, i) => (i === index ? next : t))
      const rest = all.filter((_, i) => i !== index)
      setActive((a) => (a === tabId ? (rest[Math.min(index, rest.length - 1)]?.id ?? 'vault') : a))
      return rest
    })

  const forget = (sessionIds: string[]) => {
    for (const id of sessionIds) api.sshClose(id)
    setPrompts((q) => q.filter((p) => !sessionIds.includes(p.sessionId)))
    setSessions((s) => {
      const next = { ...s }
      for (const id of sessionIds) delete next[id]
      return next
    })
  }

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      forget(panes(tab.layout))
      updateTab(tabId, () => null)
    },
    [tabs],
  )

  /** Takes a pane out of its tab: the tab closes with its last pane. */
  const detach = (tab: Tab, sessionId: string): Tab | null => {
    const layout = remove(tab.layout, sessionId)
    if (!layout) return null
    const focus =
      tab.focus !== sessionId
        ? tab.focus
        : (['right', 'left', 'bottom', 'top'] as Side[])
            .map((side) => neighbour(tab.layout, sessionId, side))
            .find((id): id is string => !!id && panes(layout).includes(id)) ?? panes(layout)[0]!
    return { ...tab, layout, focus, zoomed: tab.zoomed === sessionId ? undefined : tab.zoomed }
  }

  const closePane = useCallback(
    (sessionId: string) => {
      const tab = tabOf(sessionId)
      if (!tab) return
      forget([sessionId])
      updateTab(tab.id, (t) => detach(t, sessionId))
      takeKeyboard()
    },
    [tabOf],
  )

  /** The pixel size of a pane, to refuse splits that would leave it unusably small. */
  const paneSize = (tab: Tab, sessionId: string) => {
    const box = mainRef.current?.getBoundingClientRect()
    const r = rects(tab.layout).get(sessionId)
    if (!box || !r) return { w: 0, h: 0 }
    if (tab.zoomed) return { w: box.width, h: box.height }
    return { w: r.w * box.width, h: r.h * box.height - (panes(tab.layout).length > 1 ? HEADER : 0) }
  }
  const canSplitPane = (tab: Tab, sessionId: string, side: Side) => {
    const size = paneSize(tab, sessionId)
    return side === 'right' || side === 'left' ? size.w >= MIN_PANE.w * 2 : size.h >= MIN_PANE.h * 2 + HEADER
  }

  /** Opens another session to the same host (or shell) beside a pane. */
  const split = useCallback(
    (sessionId: string, side: Side) => {
      const tab = tabOf(sessionId)
      const source = sessions[sessionId]
      if (!tab || !source || !canSplitPane(tab, sessionId, side)) return
      const session = newSession(source.target, source.title)
      updateTab(tab.id, (t) => ({
        ...t,
        layout: insertBeside(t.layout, sessionId, side, pane(session.id)),
        focus: session.id,
        zoomed: undefined,
      }))
      takeKeyboard()
    },
    [tabOf, sessions],
  )

  const focusPane = useCallback(
    (sessionId: string) => {
      const tab = tabOf(sessionId)
      if (tab && tab.focus !== sessionId) updateTab(tab.id, (t) => ({ ...t, focus: sessionId }))
    },
    [tabOf],
  )

  const toggleZoom = (sessionId: string) => {
    const tab = tabOf(sessionId)
    if (!tab || panes(tab.layout).length < 2) return
    updateTab(tab.id, (t) => ({ ...t, focus: sessionId, zoomed: t.zoomed ? undefined : sessionId }))
    takeKeyboard()
  }

  /** Moves a pane out into a tab of its own. */
  const breakOut = (sessionId: string) => {
    const tab = tabOf(sessionId)
    if (!tab || panes(tab.layout).length < 2) return
    const own = { id: crypto.randomUUID(), layout: pane(sessionId), focus: sessionId }
    setTabs((all) => {
      const index = all.findIndex((t) => t.id === tab.id)
      const rest = detach(all[index]!, sessionId)!
      return [...all.slice(0, index), rest, own, ...all.slice(index + 1)]
    })
    setActive(own.id)
    takeKeyboard()
  }

  /** Drops a dragged tab or pane beside the pane `target`. */
  const dropBeside = (source: Drag, target: string, side: Side) => {
    const into = tabOf(target)
    if (!into) return
    takeKeyboard()
    if (source.kind === 'tab') {
      const from = tabs.find((t) => t.id === source.tabId)
      if (!from || from.id === into.id) return
      setTabs((all) =>
        all
          .filter((t) => t.id !== from.id)
          .map((t) =>
            t.id === into.id
              ? { ...t, layout: insertBeside(t.layout, target, side, from.layout), focus: from.focus, zoomed: undefined }
              : t,
          ),
      )
      setActive(into.id)
      return
    }
    const sessionId = source.sessionId
    if (sessionId === target) return
    const from = tabOf(sessionId)
    if (!from) return
    setTabs((all) => {
      const detached = all.flatMap((t) => {
        if (t.id !== from.id) return [t]
        const rest = detach(t, sessionId)
        return rest ? [rest] : []
      })
      return detached.map((t) =>
        t.id === into.id
          ? { ...t, layout: insertBeside(t.layout, target, side, pane(sessionId)), focus: sessionId, zoomed: undefined }
          : t,
      )
    })
    setActive(into.id)
  }

  // ---- keyboard ----------------------------------------------------------------

  /** Shortcuts the workspace takes before the terminal sees them. */
  const isShortcut = useCallback(
    (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyT' || e.code === 'KeyW')) return true
      if (!canSplit || !e.altKey || e.ctrlKey || e.metaKey) return false
      if (e.shiftKey && ['Equal', 'Minus', 'KeyZ'].includes(e.code)) return true
      // Alt+arrows only once there are panes to move between; otherwise the shell gets them.
      const multi = activeTab ? panes(activeTab.layout).length > 1 && !activeTab.zoomed : false
      return multi && !e.shiftKey && e.code.startsWith('Arrow')
    },
    [canSplit, activeTab],
  )

  useEffect(() => {
    if (locked) return
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return
      e.preventDefault()
      if (e.code === 'KeyT') {
        if (localTerminal) void api.localShells().then((s) => connect({ local: null }, s[0]?.name ?? 'Terminal'))
        return
      }
      if (!activeTab) return
      const focus = activeTab.focus
      if (e.code === 'KeyW') closePane(focus)
      else if (e.code === 'Equal') split(focus, 'right')
      else if (e.code === 'Minus') split(focus, 'bottom')
      else if (e.code === 'KeyZ') toggleZoom(focus)
      else {
        const side = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' } as const)[
          e.code as 'ArrowLeft'
        ]
        const next = side && neighbour(activeTab.layout, focus, side)
        if (next) focusPane(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, isShortcut, activeTab, localTerminal, closePane, split, focusPane])

  // ---- dragging tabs and panes into place ------------------------------------------

  const startDrag = (e: DragEvent, source: Drag) => {
    if (!canSplit) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '') // Firefox needs data to start a drag
    // Changing the page during dragstart can cancel the drag in Chromium.
    setTimeout(() => setDrag(source), 0)
  }
  const endDrag = () => {
    setDrag(null)
    setDrop(null)
  }
  /** The pane under the pointer, and which of its edges it is nearest. */
  const dropAt = (e: DragEvent) => {
    const box = mainRef.current?.getBoundingClientRect()
    if (!box || !activeTab) return null
    const x = (e.clientX - box.left) / box.width
    const y = (e.clientY - box.top) / box.height
    const all = activeTab.zoomed ? new Map([[activeTab.zoomed, { x: 0, y: 0, w: 1, h: 1 }]]) : rects(activeTab.layout)
    for (const [sessionId, r] of all) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        return { sessionId, side: nearestSide(r, x, y) }
      }
    }
    return null
  }
  const dropAllowed = (target: { sessionId: string } | null) => {
    if (!drag || !target || !activeTab) return false
    if (drag.kind === 'tab') return drag.tabId !== activeTab.id
    return drag.sessionId !== target.sessionId
  }

  // ---- resizing --------------------------------------------------------------------

  const startResize = (e: PointerEvent, tab: Tab, path: number[], index: number) => {
    const box = mainRef.current?.getBoundingClientRect()
    if (!box) return
    e.preventDefault()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)
    const row = dividers(tab.layout).find((d) => d.index === index && d.path.join() === path.join())?.dir === 'row'
    const area = splitRect(tab.layout, path)
    const move = (ev: globalThis.PointerEvent) => {
      const length = row ? area.w * box.width : area.h * box.height
      const along = row ? ev.clientX - box.left - area.x * box.width : ev.clientY - box.top - area.y * box.height
      const min = (row ? MIN_PANE.w : MIN_PANE.h + HEADER) / length
      updateTab(tab.id, (t) => ({ ...t, layout: resize(t.layout, path, index, along / length, min) }))
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  // ---- rendering -------------------------------------------------------------------

  const placed = useMemo(() => {
    const out = new Map<string, { tab: Tab; rect: Rect; shown: boolean }>()
    for (const tab of tabs) {
      for (const [id, rect] of rects(tab.layout)) {
        const zoomed = tab.zoomed
        out.set(id, {
          tab,
          rect: zoomed ? { x: 0, y: 0, w: 1, h: 1 } : rect,
          shown: !zoomed || zoomed === id,
        })
      }
    }
    return out
  }, [tabs])

  const ready = !locked && snapshot !== null
  const prompt = ready ? prompts[0] : undefined
  const tabTitle = (tab: Tab) => sessions[tab.focus]?.title ?? ''
  const dropTarget = drop && placed.get(drop.sessionId)

  return (
    <>
      {locked && <Unlock sessions={Object.keys(sessions).length} />}
      <div className="app" hidden={!ready}>
        <header className="tabbar">
          <button
            className={`tab tab-vault ${active === 'vault' ? 'active' : ''}`}
            onClick={() => setActive('vault')}
          >
            <Server size={15} /> Vault
          </button>
          <div className="tabs" role="tablist">
            {tabs.map((tab) => {
              const count = panes(tab.layout).length
              const focused = sessions[tab.focus]
              const title = tabTitle(tab)
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={active === tab.id}
                  className={`tab ${active === tab.id ? 'active' : ''}`}
                  onClick={() => setActive(tab.id)}
                  onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
                  title={canSplit ? `${title}\nDrag onto a terminal to show them side by side` : title}
                  draggable={canSplit}
                  onDragStart={(e) => startDrag(e, { kind: 'tab', tabId: tab.id })}
                  onDragEnd={endDrag}
                  // Hovering another tab while dragging opens it, to drop into its panes
                  // (not the tab being dragged, which the pointer starts on).
                  onDragOver={() => {
                    if (!drag || active === tab.id) return
                    if (drag.kind === 'tab' && drag.tabId === tab.id) return
                    setActive(tab.id)
                  }}
                >
                  {focused && 'local' in focused.target ? <Laptop size={14} /> : <TerminalIcon size={14} />}
                  <span className="tab-title">{title}</span>
                  {count > 1 && (
                    <span className="tab-count" aria-label={`${count} panes`}>
                      {count}
                    </span>
                  )}
                  <button
                    className="tab-close"
                    aria-label={`Close ${title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}
            {tabs.length > 0 && (
              <button className="tab-new" aria-label="New connection" onClick={() => setActive('vault')}>
                <Plus size={16} />
              </button>
            )}
          </div>
          {canSplit && activeTab && (
            <div className="split-actions">
              <button
                className="icon-btn"
                title="Split right (Alt+Shift+=)"
                aria-label="Split right"
                disabled={!canSplitPane(activeTab, activeTab.focus, 'right')}
                onClick={() => split(activeTab.focus, 'right')}
              >
                <Columns2 size={16} />
              </button>
              <button
                className="icon-btn"
                title="Split down (Alt+Shift+-)"
                aria-label="Split down"
                disabled={!canSplitPane(activeTab, activeTab.focus, 'bottom')}
                onClick={() => split(activeTab.focus, 'bottom')}
              >
                <Rows2 size={16} />
              </button>
            </div>
          )}
          <UpdatePill />
          <button className="icon-btn" title="Lock vault" aria-label="Lock vault" onClick={() => void api.lock()}>
            <Lock size={16} />
          </button>
        </header>

        <main className="content" ref={mainRef}>
          <div className="pane" hidden={active !== 'vault'}>
            {snapshot && <VaultView snapshot={snapshot} onConnect={connect} />}
          </div>

          {/* Every session is rendered once, here, and only placed by its tab's
              layout: moving it between panes or tabs never restarts it. */}
          {Object.values(sessions).map((session) => {
            const place = placed.get(session.id)
            if (!place) return null
            const { tab, rect, shown } = place
            const visible = active === tab.id && shown
            const multi = panes(tab.layout).length > 1
            const focused = tab.focus === session.id
            return (
              <div
                key={session.id}
                className={`pane terminal-pane ${multi ? 'tiled' : ''} ${multi && focused ? 'focused' : ''}`}
                hidden={!visible}
                style={pct(rect)}
                data-session={session.id}
                onPointerDownCapture={() => focusPane(session.id)}
              >
                {multi && (
                  <div
                    className="pane-header"
                    draggable={canSplit}
                    onDragStart={(e) => startDrag(e, { kind: 'pane', sessionId: session.id })}
                    onDragEnd={endDrag}
                    onDoubleClick={() => toggleZoom(session.id)}
                    title="Drag to move this pane. Double-click to zoom."
                  >
                    {'local' in session.target ? <Laptop size={13} /> : <TerminalIcon size={13} />}
                    <span className="pane-title">{session.title}</span>
                    <span className="pane-actions">
                      <button
                        className="icon-btn"
                        aria-label={`Split ${session.title} right`}
                        title="Split right"
                        disabled={!canSplitPane(tab, session.id, 'right')}
                        onClick={() => split(session.id, 'right')}
                      >
                        <Columns2 size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Split ${session.title} down`}
                        title="Split down"
                        disabled={!canSplitPane(tab, session.id, 'bottom')}
                        onClick={() => split(session.id, 'bottom')}
                      >
                        <Rows2 size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={tab.zoomed ? `Unzoom ${session.title}` : `Zoom ${session.title}`}
                        title={tab.zoomed ? 'Show all panes (Alt+Shift+Z)' : 'Zoom (Alt+Shift+Z)'}
                        aria-pressed={!!tab.zoomed}
                        onClick={() => toggleZoom(session.id)}
                      >
                        {tab.zoomed ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Move ${session.title} to a new tab`}
                        title="Move to a new tab"
                        onClick={() => breakOut(session.id)}
                      >
                        <SquareArrowOutUpRight size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Close pane ${session.title}`}
                        title="Close pane (Ctrl+Shift+W)"
                        onClick={() => closePane(session.id)}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  </div>
                )}
                <TerminalTab
                  tab={session}
                  active={visible && focused}
                  refocus={refocus}
                  snippets={snapshot?.snippets ?? []}
                  closeLabel={multi ? 'Close pane' : 'Close tab'}
                  onClose={() => closePane(session.id)}
                  isShortcut={isShortcut}
                />
              </div>
            )
          })}

          {activeTab &&
            !activeTab.zoomed &&
            dividers(activeTab.layout).map((d) => (
              <div
                key={`${d.path.join('.')}:${d.index}`}
                className={`divider divider-${d.dir}`}
                role="separator"
                aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
                style={pct(d.rect)}
                onPointerDown={(e) => startResize(e, activeTab, d.path, d.index)}
                onDoubleClick={() => updateTab(activeTab.id, (t) => ({ ...t, layout: equalize(t.layout) }))}
                title="Drag to resize. Double-click to make all panes equal."
              />
            ))}

          {drag && activeTab && (
            <div
              className="drop-layer"
              onDragOver={(e) => {
                const at = dropAt(e)
                if (!dropAllowed(at)) {
                  setDrop(null)
                  return
                }
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (at!.sessionId !== drop?.sessionId || at!.side !== drop?.side) setDrop(at)
              }}
              onDragLeave={() => setDrop(null)}
              onDrop={(e) => {
                e.preventDefault()
                const at = dropAt(e)
                if (dropAllowed(at)) dropBeside(drag, at!.sessionId, at!.side)
                endDrag()
              }}
            >
              {dropTarget && drop && (
                <div className="drop-preview" style={pct(half(dropTarget.rect, drop.side))} />
              )}
            </div>
          )}
        </main>

        {ready && !prompt && <UpdateCard />}

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

/** The half of a pane a drop on that side would take. */
function half(r: Rect, side: Side): Rect {
  switch (side) {
    case 'left':
      return { ...r, w: r.w / 2 }
    case 'right':
      return { ...r, x: r.x + r.w / 2, w: r.w / 2 }
    case 'top':
      return { ...r, h: r.h / 2 }
    case 'bottom':
      return { ...r, y: r.y + r.h / 2, h: r.h / 2 }
  }
}
