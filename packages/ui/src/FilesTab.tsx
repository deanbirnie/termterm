import { ArrowDownToLine, ArrowUp, ArrowUpFromLine, File, Folder, FolderPlus, Link2, Pencil, RefreshCw, RotateCw, Trash2 } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import type { FileEntry, FolderListing, TransferState } from '@termterm/app'
import { api, errorMessage } from './api'
import { Button, ErrorText, Field, Modal, useAction } from './ui'
import { useAppInfo } from './Update'
import type { SessionTab } from './Workspace'

/**
 * Browsing a server's files over SFTP, beside this computer's: copy either
 * way with the buttons, by dragging between the sides, or by dropping files
 * from the system's file manager onto the server's side.
 */
export function FilesTab({ tab, active, onClose }: { tab: SessionTab; active: boolean; onClose: () => void }) {
  const [state, setState] = useState<'connecting' | 'connected' | 'failed'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [transfers, setTransfers] = useState<TransferState[]>([])
  const [refreshLocal, setRefreshLocal] = useState(0)
  const [refreshRemote, setRefreshRemote] = useState(0)
  const localRef = useRef<PaneHandle>(null)
  const remoteRef = useRef<PaneHandle>(null)
  // On a phone there is no file system to browse beside the server's: files
  // are saved and picked through the system's own file picker instead.
  const localFiles = useAppInfo()?.capabilities.localFiles ?? true
  const [pickError, setPickError] = useState<string | null>(null)
  const viaPicker = (work: () => Promise<unknown>) => {
    setPickError(null)
    void work().catch((e) => setPickError(errorMessage(e)))
  }

  useEffect(() => {
    let current = true
    setState('connecting')
    setError(null)
    api.sftpOpen(tab.id, tab.target).then(
      (r) => {
        if (!current) return
        setHome(r.home)
        setState('connected')
      },
      (e) => {
        if (!current) return
        setError(errorMessage(e))
        setState('failed')
      },
    )
    return () => {
      current = false
    }
  }, [tab.id, attempt])

  useEffect(
    () =>
      api.onTransfer((t) => {
        if (t.sessionId !== tab.id) return
        setTransfers((list) => [t, ...list.filter((x) => x.id !== t.id)].slice(0, 6))
        if (t.state === 'done') {
          if (t.direction === 'upload') setRefreshRemote((n) => n + 1)
          else setRefreshLocal((n) => n + 1)
        }
      }),
    [tab.id],
  )

  const copy = (direction: 'upload' | 'download', paths: string[], toFolder?: string) => {
    const folder = toFolder ?? (direction === 'upload' ? remoteRef.current?.folder() : localRef.current?.folder())
    if (!folder || paths.length === 0) return
    void api.transfer(tab.id, direction, paths, folder).catch(() => undefined) // shown in the transfer list
  }

  if (state !== 'connected' || !home) {
    return (
      <div className="files-tab">
        <div className={`session-bar ${state === 'failed' ? 'failed' : ''}`} role="status">
          <span>{state === 'connecting' ? `Opening files on ${tab.title}…` : `Could not open files: ${error}`}</span>
          {state === 'failed' && (
            <span className="session-actions">
              <Button onClick={() => setAttempt((a) => a + 1)}>
                <RotateCw size={14} /> Try again
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Close tab
              </Button>
            </span>
          )}
        </div>
      </div>
    )
  }

  const remotePane = (
    <FilePane
      ref={remoteRef}
      side="remote"
      title={tab.title}
      start={home}
      active={active}
      refresh={refreshRemote}
      tapToOpen={!localFiles}
      ops={{
        list: (p) => api.sftpList(tab.id, p ?? home),
        mkdir: (p) => api.sftpMkdir(tab.id, p),
        rename: (a, b) => api.sftpRename(tab.id, a, b),
        remove: (p) => api.sftpDelete(tab.id, p),
        join: (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`),
      }}
      copyLabel="Download"
      onCopy={(entries) =>
        localFiles
          ? copy('download', entries.map((e) => e.path))
          : viaPicker(async () => {
              for (const e of entries) {
                if (e.type === 'dir') throw new Error('Open a folder to download the files in it')
                if (!(await api.sftpDownloadPicked?.(tab.id, e.path, e.name, e.size))) break
              }
            })
      }
      onUploadHere={
        localFiles
          ? undefined
          : (folder) =>
              viaPicker(async () => {
                if (await api.sftpUploadPicked?.(tab.id, folder)) setRefreshRemote((n) => n + 1)
              })
      }
      onDropFrom={(paths, folder) => copy('upload', paths, folder)}
      onDropFiles={localFiles ? (paths, folder) => copy('upload', paths, folder) : undefined}
    />
  )

  if (!localFiles) {
    return (
      <div className="files-tab">
        <div className="files-panes single">{remotePane}</div>
        <ErrorText error={pickError} />
        <TransferList transfers={transfers} />
      </div>
    )
  }

  return (
    <div className="files-tab">
      <div className="files-panes">
        <FilePane
          ref={localRef}
          side="local"
          title="This computer"
          start={null}
          active={active}
          refresh={refreshLocal}
          ops={{
            list: (p) => api.localList(p),
            mkdir: api.localMkdir,
            rename: api.localRename,
            remove: api.localDelete,
            join: (dir, name) => joinLocal(dir, name),
          }}
          copyLabel="Upload"
          onCopy={(entries) => copy('upload', entries.map((e) => e.path))}
          onDropFrom={(paths, folder) => copy('download', paths, folder)}
          onDropFiles={undefined}
        />
        {remotePane}
      </div>
      <TransferList transfers={transfers} />
    </div>
  )
}

function TransferList({ transfers }: { transfers: TransferState[] }) {
  if (transfers.length === 0) return null
  return (
    <ul className="transfers" aria-label="Transfers">
      {transfers.map((t) => (
        <li key={t.id} className={t.state}>
          {t.direction === 'upload' ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />}
          <span className="transfer-name">{t.name}</span>
          {t.state === 'error' ? (
            <span className="error">{t.error}</span>
          ) : (
            <>
              <progress max={t.total || 1} value={t.state === 'done' ? t.total || 1 : t.done} />
              <span className="transfer-size">
                {t.state === 'done' ? `Done · ${size(t.total)}` : `${size(t.done)} of ${size(t.total)}`}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Joins a folder and a name on this computer, keeping its separator. */
function joinLocal(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

function size(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

interface PaneOps {
  list(path: string | null): Promise<FolderListing>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  join(dir: string, name: string): string
}

interface PaneHandle {
  folder(): string | null
}

/** Dragging between the two sides carries the paths and which side they came from. */
const DRAG_TYPE = 'application/x-termterm-files'

const FilePane = forwardRef<
  PaneHandle,
  {
    side: 'local' | 'remote'
    title: string
    start: string | null
    active: boolean
    refresh: number
    ops: PaneOps
    copyLabel: 'Upload' | 'Download'
    onCopy: (entries: FileEntry[]) => void
    /** Without this device's files beside it: an Upload button that picks files to copy here. */
    onUploadHere?: (folder: string) => void
    /** A tap on a folder opens it (touch screens, where double-tap is unreliable). */
    tapToOpen?: boolean
    /** Paths dragged in from the other side, to copy into `folder`. */
    onDropFrom: (paths: string[], folder: string) => void
    /** Files dropped from the system's file manager (server side only). */
    onDropFiles?: (paths: string[], folder: string) => void
  }
>(function FilePane({ side, title, start, refresh, ops, copyLabel, onCopy, onUploadHere, tapToOpen, onDropFrom, onDropFiles }, ref) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [path, setPath] = useState<string | null>(start)
  const [typed, setTyped] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | 'mkdir' | 'rename' | 'delete'>(null)
  const [dropping, setDropping] = useState(false)
  const { error, run } = useAction()
  const [loadError, setLoadError] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({ folder: () => listing?.path ?? null }), [listing])

  const load = (to: string | null) =>
    ops.list(to).then(
      (l) => {
        setListing(l)
        setPath(l.path)
        setTyped(l.path)
        setLoadError(null)
        setSelected((s) => new Set([...s].filter((p) => l.entries.some((e) => e.path === p))))
      },
      (e) => {
        setLoadError(errorMessage(e))
        setTyped(listing?.path ?? '')
      },
    )
  useEffect(() => void load(path), [refresh])

  const open = (entry: FileEntry) => {
    if (entry.type === 'dir') {
      setSelected(new Set())
      void load(entry.path)
    }
  }
  const up = () => listing?.parent && void load(listing.parent).then(() => setSelected(new Set([listing.path])))
  const chosen = listing?.entries.filter((e) => selected.has(e.path)) ?? []

  const click = (e: MouseEvent, entry: FileEntry) => {
    if (tapToOpen && entry.type === 'dir') return open(entry)
    if (e.shiftKey && anchor && listing) {
      const names = listing.entries.map((x) => x.path)
      const [a, b] = [names.indexOf(anchor), names.indexOf(entry.path)].sort((x, y) => x - y)
      setSelected(new Set(names.slice(a, b! + 1)))
      return
    }
    setAnchor(entry.path)
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
    } else {
      setSelected(new Set([entry.path]))
    }
  }
  const keys = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'Enter' && chosen.length === 1) open(chosen[0]!)
    else if (e.key === 'Backspace') up()
    else if (e.key === 'Delete' && chosen.length) setDialog('delete')
    else if (e.key === 'F2' && chosen.length === 1) setDialog('rename')
    else return
    e.preventDefault()
  }

  const dragStart = (e: DragEvent, entry: FileEntry) => {
    const paths = selected.has(entry.path) ? [...selected] : [entry.path]
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ side, paths }))
    e.dataTransfer.effectAllowed = 'copy'
  }
  const dragOver = (e: DragEvent) => {
    const internal = e.dataTransfer.types.includes(DRAG_TYPE)
    const files = !!onDropFiles && e.dataTransfer.types.includes('Files')
    if (!internal && !files) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDropping(false)
    if (!listing) return
    const internal = e.dataTransfer.getData(DRAG_TYPE)
    if (internal) {
      const { side: from, paths } = JSON.parse(internal) as { side: string; paths: string[] }
      if (from !== side) onDropFrom(paths, listing.path)
      return
    }
    if (onDropFiles) {
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
      if (paths.length) onDropFiles(paths, listing.path)
    }
  }

  return (
    <section
      className={`file-pane ${dropping ? 'dropping' : ''}`}
      aria-label={side === 'local' ? 'This computer' : 'Server'}
      onKeyDown={keys}
      onDragOver={dragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={drop}
    >
      <header className="file-pane-head">
        <strong>{title}</strong>
        <span className="file-tools">
          <button className="icon-btn" aria-label="Up one folder" title="Up (Backspace)" disabled={!listing?.parent} onClick={up}>
            <ArrowUp size={15} />
          </button>
          <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => void load(path)}>
            <RefreshCw size={15} />
          </button>
          <button className="icon-btn" aria-label="New folder" title="New folder" onClick={() => setDialog('mkdir')}>
            <FolderPlus size={15} />
          </button>
          <button
            className="icon-btn"
            aria-label="Rename"
            title="Rename (F2)"
            disabled={chosen.length !== 1}
            onClick={() => setDialog('rename')}
          >
            <Pencil size={15} />
          </button>
          <button
            className="icon-btn"
            aria-label="Delete"
            title="Delete"
            disabled={chosen.length === 0}
            onClick={() => setDialog('delete')}
          >
            <Trash2 size={15} />
          </button>
          <Button
            disabled={chosen.length === 0}
            onClick={() => onCopy(chosen)}
            title={copyLabel === 'Upload' ? 'Copy to the server, into the folder open there' : 'Copy to this computer, into the folder open there'}
          >
            {copyLabel === 'Upload' ? (
              <>
                Upload <ArrowUpFromLine size={14} />
              </>
            ) : (
              <>
                <ArrowDownToLine size={14} /> Download
              </>
            )}
          </Button>
          {onUploadHere && listing && (
            <Button onClick={() => onUploadHere(listing.path)} title="Pick files on this device to copy into this folder">
              Upload… <ArrowUpFromLine size={14} />
            </Button>
          )}
        </span>
      </header>
      <form
        className="file-path"
        onSubmit={(e) => {
          e.preventDefault()
          if (typed.trim()) void load(typed.trim())
        }}
      >
        <input aria-label={`Folder on ${side === 'local' ? 'this computer' : 'the server'}`} className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </form>
      <ErrorText error={loadError ?? (dialog ? null : error)} />
      <div className="file-list" role="listbox" aria-multiselectable="true" aria-label="Files" tabIndex={0}>
        {listing?.entries.length === 0 && <p className="muted pad">This folder is empty.</p>}
        {listing?.entries.map((entry) => (
          <div
            key={entry.path}
            role="option"
            aria-label={entry.name}
            aria-selected={selected.has(entry.path)}
            className={`file-row ${selected.has(entry.path) ? 'selected' : ''}`}
            draggable
            onDragStart={(e) => dragStart(e, entry)}
            onClick={(e) => click(e, entry)}
            onDoubleClick={() => open(entry)}
            title={entry.name}
          >
            {entry.type === 'dir' ? <Folder size={15} className="file-icon dir" /> : entry.type === 'link' ? <Link2 size={15} className="file-icon" /> : <File size={15} className="file-icon" />}
            <span className="file-name">{entry.name}</span>
            <span className="file-size">{entry.type === 'dir' ? '' : size(entry.size)}</span>
            <span className="file-date">{entry.modified ? new Date(entry.modified).toLocaleString() : ''}</span>
          </div>
        ))}
      </div>
      {dialog === 'mkdir' && listing && (
        <NameDialog
          title="New folder"
          action="Create"
          initial=""
          error={error}
          onCancel={() => setDialog(null)}
          onDone={(name) =>
            run(async () => {
              await ops.mkdir(ops.join(listing.path, name))
              setDialog(null)
              await load(listing.path)
            })
          }
        />
      )}
      {dialog === 'rename' && listing && chosen[0] && (
        <NameDialog
          title={`Rename ${chosen[0].name}`}
          action="Rename"
          initial={chosen[0].name}
          error={error}
          onCancel={() => setDialog(null)}
          onDone={(name) =>
            run(async () => {
              await ops.rename(chosen[0]!.path, ops.join(listing.path, name))
              setDialog(null)
              await load(listing.path)
            })
          }
        />
      )}
      {dialog === 'delete' && listing && (
        <Modal title={`Delete ${chosen.length === 1 ? chosen[0]!.name : `${chosen.length} items`}?`} tone="danger" onClose={() => setDialog(null)}>
          <p>
            {chosen.some((c) => c.type === 'dir') ? 'Folders are deleted with everything in them. ' : ''}
            This cannot be undone.
          </p>
          <ErrorText error={error} />
          <div className="modal-actions">
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() =>
                void run(async () => {
                  for (const c of chosen) await ops.remove(c.path)
                  setDialog(null)
                  setSelected(new Set())
                  await load(listing.path)
                })
              }
            >
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </section>
  )
})

function NameDialog({
  title,
  action,
  initial,
  error,
  onCancel,
  onDone,
}: {
  title: string
  action: string
  initial: string
  error: string | null
  onCancel: () => void
  onDone: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState(initial)
  const bad = !name.trim() || /[/\\]/.test(name) || name === '.' || name === '..'
  return (
    <Modal title={title} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!bad) void onDone(name.trim())
        }}
      >
        <Field label="Name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </Field>
        <ErrorText error={error} />
        <div className="modal-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={bad}>
            {action}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
