// The overview is laid out by the groups you created: groups run top to bottom and are collapsible; press and hold the
// handle left of a group header and drag up or down to reorder groups.
// A group holds equal-height tiles, in the order the server set (waiting → running → just finished → idle). How many
// sessions need you is in the readings band at the top of the page, which opens the first one. Retired strips fold at
// the very bottom
import { type FormEvent, useEffect, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/index.ts'
import type { AgentStrip, Bay, SessionGroup, Snapshot } from '../../shared/types.ts'
import { postGroup } from './api.ts'
import { useI18n } from './i18n.tsx'
import { CaretIcon, GripIcon, PencilIcon, TrashIcon } from './icons.tsx'
import { RetiredFold } from './Retired.tsx'
import { SessionTile } from './SessionCard.tsx'
import { type GripHandlers, useGroupDrag } from './useGroupDrag.ts'

/** The code for "ungrouped" in the ordering; same as UNGROUPED in the server's groups.ts */
const UNGROUPED = 'none'
const COLLAPSED_KEY = 'flightstrip.collapsedGroups'
const NAME_LIMIT = 30

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY)
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]))
  } catch {
    return new Set()
  }
}

/** Which groups are collapsed: just this browser's preference kept in localStorage; if it can't be stored, everything is expanded on every load */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const save = (next: Set<string>) => {
    setCollapsed(next)
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    } catch {
      // Private mode etc. can't store it: this time it still takes effect, the next load is fully expanded again
    }
  }
  const toggle = (key: string) => {
    const next = new Set(collapsed)
    if (!next.delete(key)) next.add(key)
    save(next)
  }
  const expand = (key: string) => {
    if (!collapsed.has(key)) return
    const next = new Set(collapsed)
    next.delete(key)
    save(next)
  }
  return { collapsed, toggle, expand }
}

/** One line per group: even when collapsed you can tell whether something inside needs attention */
const SUMMARY = [
  { bay: 'needs', tone: 'warn', key: 'group.summary.needs' },
  { bay: 'working', tone: 'ongoing', key: 'group.summary.working' },
  { bay: 'done', tone: 'ok', key: 'group.summary.done' },
  { bay: 'idle', tone: 'idle', key: 'group.summary.idle' },
] as const satisfies { bay: Bay; tone: string; key: MessageKey }[]

function useBusy() {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = (action: () => Promise<void>, onDone?: () => void) => {
    setBusy(true)
    setFailure(null)
    action()
      .then(() => onDone?.())
      .catch((err: Error) => setFailure(err.message))
      .finally(() => setBusy(false))
  }
  return { busy, failure, run }
}

function NameForm({ initial, label, submitLabel, onSubmit, onCancel, busy }: {
  initial: string; label: string; submitLabel: string; busy: boolean; onSubmit: (name: string) => void; onCancel: () => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(initial)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit(draft)
  }
  return (
    <form className="rename" onSubmit={submit}>
      <input className="input" value={draft} maxLength={NAME_LIMIT} autoFocus aria-label={label} placeholder={t('group.namePlaceholder')}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <button type="submit" className="btn btn--primary" disabled={busy || draft.trim() === ''}>{submitLabel}</button>
      <button type="button" className="btn btn--outline" onClick={onCancel}>{t('common.cancel')}</button>
    </form>
  )
}

function GroupSection({ group, strips, snapshot, collapsed, onToggle, grip, offset = 0, lifted = false, hint, openId, onOpen }: {
  group: SessionGroup | null; strips: AgentStrip[]; snapshot: Snapshot; collapsed: boolean; onToggle: () => void
  grip?: GripHandlers; offset?: number; lifted?: boolean; hint?: string; openId: string | null; onOpen: (strip: AgentStrip) => void
}) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'view' | 'renaming' | 'confirmDelete'>('view')
  const { busy, failure, run } = useBusy()
  const key = group?.id ?? UNGROUPED
  const name = group?.name ?? t('group.ungrouped')
  const summary = SUMMARY.map((item) => ({ ...item, n: strips.filter((s) => s.bay === item.bay).length })).filter((item) => item.n > 0)

  return (
    <section className="group" aria-label={name} data-group={key} data-lifted={lifted || undefined}
      style={offset === 0 ? undefined : { transform: `translateY(${offset}px)` }}>
      <div className="group-head">
        {grip !== undefined && (
          <button type="button" className="group-grip" data-grip={key} aria-label={t('group.dragLabel', { name })}
            title={t('group.dragTitle')} {...grip}>
            <GripIcon />
          </button>
        )}
        {mode === 'renaming' && group !== null ? (
          <NameForm initial={group.name} label={t('group.nameLabel')} submitLabel={t('common.save')} busy={busy} onCancel={() => setMode('view')}
            onSubmit={(next) => run(() => postGroup('rename', { id: group.id, name: next }), () => setMode('view'))} />
        ) : (
          <button type="button" className="group-toggle" aria-expanded={!collapsed} aria-controls={`group-${key}`} onClick={onToggle}>
            <CaretIcon />
            <span className="group-name">{name}</span>
            <span className="count">{strips.length}</span>
            {summary.length > 0 && (
              <span className="group-sum">
                {summary.map((item) => <span key={item.bay} data-tone={item.tone}>{t(item.key, { n: item.n })}</span>)}
              </span>
            )}
          </button>
        )}
        {group !== null && mode !== 'renaming' && (
          <span className="group-tools">
            <button type="button" className="icon-btn" aria-label={t('group.rename')} title={t('group.rename')} onClick={() => setMode('renaming')}><PencilIcon /></button>
            <button type="button" className="icon-btn" aria-label={t('group.delete')} title={t('group.delete')} onClick={() => setMode('confirmDelete')}><TrashIcon /></button>
          </span>
        )}
      </div>
      {mode === 'confirmDelete' && group !== null && (
        <div className="banner">
          <p>{strips.length > 0 ? t('group.confirmDeleteWith', { name: group.name, n: strips.length }) : t('group.confirmDelete', { name: group.name })}</p>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => run(() => postGroup('delete', { id: group.id }))}>{t('group.delete')}</button>
          <button type="button" className="btn btn--outline" onClick={() => setMode('view')}>{t('common.cancel')}</button>
        </div>
      )}
      {failure !== null && <p className="error" role="alert">{failure}</p>}
      <div id={`group-${key}`} className="group-body" hidden={collapsed}>
        {!collapsed && (
          <>
            {hint !== undefined && <p className="hint group-hint">{hint}</p>}
            {strips.length > 0 && (
              <ol className="tiles">
                {strips.map((strip) => (
                  <SessionTile key={strip.sessionId} strip={strip} now={snapshot.takenAt} windowMs={snapshot.windowMs}
                    briefsEnabled={snapshot.briefsEnabled} contextLine={snapshot.contextLine}
                    open={openId === strip.sessionId} onOpen={() => onOpen(strip)} />
                ))}
              </ol>
            )}
            {strips.length === 0 && group !== null && <p className="hint group-hint">{t('group.empty', { name: group.name })}</p>}
          </>
        )}
      </div>
    </section>
  )
}

function NewGroup() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const { busy, failure, run } = useBusy()
  return (
    <div className="new-group">
      {open ? (
        <NameForm initial="" label={t('group.newName')} submitLabel={t('group.create')} busy={busy} onCancel={() => setOpen(false)}
          onSubmit={(name) => run(() => postGroup('create', { name }), () => setOpen(false))} />
      ) : (
        <button type="button" className="btn btn--outline" onClick={() => setOpen(true)}>{t('group.new')}</button>
      )}
      {failure !== null && <p className="error" role="alert">{failure}</p>}
    </div>
  )
}

/** The order of groups and "ungrouped" together. After a drag the new order shows first, and once the order pushed by the
 *  server changes it takes over, so there is no snap-back on release.
 *  showUngrouped: "ungrouped" is hidden while it has no sessions, and then doesn't take part in dragging */
function useGroupOrder(groups: SessionGroup[], ungroupedAt: number, showUngrouped: boolean) {
  const { t } = useI18n()
  const [pending, setPending] = useState<string[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const saved = groups.map((g) => g.id)
  saved.splice(ungroupedAt, 0, UNGROUPED)
  const savedKey = saved.join(',')
  useEffect(() => setPending(null), [savedKey])
  const full = pending ?? saved
  const order = full.filter((id) => (id === UNGROUPED ? showUngrouped : groups.some((g) => g.id === id)))
  /** `to` is the position among those shown on the page; what is sent to the server is "move before whom" */
  const move = (id: string, to: number) => {
    const before = order.filter((other) => other !== id)[to] ?? null
    const next = full.filter((other) => other !== id)
    next.splice(before === null ? next.length : next.indexOf(before), 0, id)
    setPending(next)
    setFailure(null)
    postGroup('move', { id, before }).catch((err: Error) => {
      setPending(null)
      setFailure(t('group.moveFailed', { error: err.message }))
    })
  }
  return { order, move, failure }
}

/** Opening a session: expand its group if it is collapsed, then scroll its tile into view */
export function useReveal() {
  const { collapsed, toggle, expand } = useCollapsed()
  const [revealing, setRevealing] = useState<string | null>(null)
  useEffect(() => {
    // Wait for the group to expand and the tile to render before scrolling
    if (revealing === null) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`card-${revealing}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' })
    setRevealing(null)
  }, [revealing])
  const reveal = (strip: AgentStrip) => {
    expand(strip.groupId ?? UNGROUPED)
    setRevealing(strip.sessionId)
  }
  return { collapsed, toggle, reveal }
}

export function GroupedOverview({ snapshot, collapsed, toggle, openId, onOpen }: {
  snapshot: Snapshot; collapsed: Set<string>; toggle: (key: string) => void; openId: string | null; onOpen: (strip: AgentStrip) => void
}) {
  const { t } = useI18n()
  const { groups, strips } = snapshot
  const ungrouped = strips.filter((s) => s.groupId === null)
  const { order, move, failure } = useGroupOrder(groups, snapshot.ungroupedAt, ungrouped.length > 0 || groups.length === 0)
  const { containerRef, dragging, grip, offsetOf } = useGroupDrag(order, move)
  // While dragging everything collapses to group headers; on release each group returns to its previous collapsed state
  const isCollapsed = (key: string) => dragging !== null || collapsed.has(key)

  return (
    <>
      <div className="groups" ref={containerRef} data-dragging={dragging !== null || undefined}>
        {order.map((key) => {
          const group = groups.find((g) => g.id === key) ?? null
          return (
            <GroupSection key={key} group={group} strips={strips.filter((s) => s.groupId === (group?.id ?? null))} snapshot={snapshot}
              collapsed={isCollapsed(key)} onToggle={() => toggle(key)}
              grip={order.length > 1 ? grip(key) : undefined} offset={offsetOf(key)} lifted={dragging === key}
              hint={group === null && groups.length === 0 ? t('overview.noGroupsHint') : undefined}
              openId={openId} onOpen={onOpen} />
          )
        })}
        {failure !== null && <p className="error" role="alert">{failure}</p>}
        <NewGroup />
      </div>
      {snapshot.retired.length > 0 && <RetiredFold rows={snapshot.retired} now={snapshot.takenAt} />}
    </>
  )
}
