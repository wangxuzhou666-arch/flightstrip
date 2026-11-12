// Always in the right rail: where the memory goes. A segmented bar on top, its segments in the order of the rows below;
// hovering a row darkens its segment. The first 6 rows show, the rest behind a toggle.
// When memory is tight the panel gets an amber ring and the row to handle first is marked. The dashboard never acts on
// another process by itself; it only suggests and offers the buttons.
// Tasks a session started can be paused and resumed (no progress lost); apps can only be ended.
import { useEffect, useState } from 'react'
import { suggested } from '../../shared/hogs.ts'
import type { Hog, MachineReading } from '../../shared/types.ts'
import { hogAction } from './api.ts'
import { formatBytes } from './format.ts'
import { type I18n, useI18n } from './i18n.tsx'

// This long after asking it to end, a row that is still there offers a force end instead
const STUBBORN_MS = 8_000
// After this long a request to end no longer counts as recent: an app of the same name started again must not open
// straight on Force end
const ASK_TTL_MS = 60_000
// Rows shown before the toggle
const SHOWN = 6
const mem = (bytes: number) => formatBytes(bytes, 1024)

function metaOf(hog: Hog, t: I18n['t']): string | null {
  const from = hog.kind === 'job' ? (hog.owner === null ? t('hogs.meta.background') : t('hogs.meta.jobOf', { owner: hog.owner }))
    : hog.kind === 'sessions' ? t('hogs.meta.sessions', { n: hog.hostedSessions })
    : hog.kind === 'app' && hog.hostedSessions > 0 ? t('hogs.meta.hosts', { n: hog.hostedSessions })
    : null
  if (hog.stopped === 0) return from
  // Only some processes stopped (new ones started after pausing, or some didn't stop): say so, not "paused"
  if (hog.stopped < hog.processes) {
    const counts = { stopped: hog.stopped, total: hog.processes }
    return from === null ? t('hogs.meta.partlyPausedAlone', counts) : t('hogs.meta.partlyPaused', { from, ...counts })
  }
  return from === null ? t('hogs.meta.pausedAlone') : t('hogs.meta.paused', { from })
}

function warningOf(hog: Hog, force: boolean, t: I18n['t']): string {
  if (hog.hostedSessions > 0) return t('hogs.warn.hosted', { n: hog.hostedSessions })
  if (force) return t('hogs.warn.force')
  return hog.kind === 'job' ? t('hogs.warn.job') : t('hogs.warn.app')
}

function HogRow({ hog, askedAt, now, first, onAsked, onHover }: {
  hog: Hog
  /** When it was last asked to end */
  askedAt: number | undefined
  now: number
  /** Memory is tight and this is the row to handle first */
  first: boolean
  /** at null: drop "recently asked to end", the button goes back to a plain End */
  onAsked: (key: string, at: number | null) => void
  onHover: (key: string | null) => void
}) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const recent = askedAt !== undefined && now - askedAt < ASK_TTL_MS
  const stubborn = recent && now - (askedAt as number) >= STUBBORN_MS
  const waiting = recent && !stubborn
  const verb = stubborn ? t('hogs.forceEnd') : t('hogs.end')
  const act = (action: 'end' | 'pause' | 'resume') => {
    setConfirming(false)
    setFailure(null)
    if (action === 'end') onAsked(hog.key, Date.now())
    hogAction(hog.key, hog.name, action, stubborn).catch((err: Error) => {
      setFailure(err.message)
      // The request didn't go through (no permission, a different program now): nothing is ending, so it must not turn
      // into Force end 8 seconds later
      if (action === 'end') onAsked(hog.key, null)
    })
  }
  const meta = metaOf(hog, t)
  const hasButtons = hog.pausable || hog.killable
  return (
    <li className="hog" data-paused={hog.paused || undefined} onMouseEnter={() => onHover(hog.key)} onMouseLeave={() => onHover(null)}>
      <span className="hog-title" title={hog.name}>{hog.name}{first && <span className="hog-first">{t('hogs.first')}</span>}</span>
      <span className="hog-cpu" data-busy={hog.cpuPercent >= 100 || undefined} title={t('hogs.cpuHint')}>{t('hogs.cpu', { percent: Math.round(hog.cpuPercent) })}</span>
      <span className="hog-mem" title={t('hogs.memoryHint')}>{mem(hog.memoryBytes)}</span>
      {(meta !== null || hasButtons) && (
        <span className="hog-foot">
          {meta !== null && <span className="hog-meta">{meta}</span>}
          <span className="hog-side">
            {confirming ? (
              <>
                <span className="hog-ask">{t('hogs.confirm', { verb, name: hog.name, warning: warningOf(hog, stubborn, t) })}</span>
                <button type="button" className="btn btn--danger btn--small" onClick={() => act('end')}>{verb}</button>
                <button type="button" className="btn btn--outline btn--small" onClick={() => setConfirming(false)}>{t('hogs.keep')}</button>
              </>
            ) : waiting ? (
              <span className="hog-meta">{t('hogs.ending')}</span>
            ) : (
              <>
                {hog.pausable && (hog.paused
                  ? <button type="button" className="btn btn--outline btn--small" title={t('hogs.resumeHint')} onClick={() => act('resume')}>{t('hogs.resume')}</button>
                  : <button type="button" className="btn btn--outline btn--small" title={t('hogs.pauseHint')} onClick={() => act('pause')}>{t('hogs.pause')}</button>)}
                {hog.killable && <button type="button" className="btn btn--outline btn--small" onClick={() => setConfirming(true)}>{verb}</button>}
              </>
            )}
          </span>
        </span>
      )}
      {failure !== null && <p className="error hog-error" role="alert">{t('hogs.failed', { name: hog.name, error: failure })}</p>}
    </li>
  )
}

export function Hogs({ hogs, machine, briefsHeld, briefsEnabled, now }: {
  hogs: Hog[]; machine: MachineReading | null; briefsHeld: boolean; briefsEnabled: boolean; now: number
}) {
  const { t } = useI18n()
  const tight = machine?.memory.pressure === 'warn' || machine?.memory.pressure === 'critical'
  const [showAll, setShowAll] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [asked, setAsked] = useState<Record<string, number>>({})
  // Rows that left the ranking need no record
  useEffect(() => {
    setAsked((before) => {
      const kept = Object.fromEntries(Object.entries(before).filter(([key]) => hogs.some((hog) => hog.key === key)))
      return Object.keys(kept).length === Object.keys(before).length ? before : kept
    })
  }, [hogs])
  if (hogs.length === 0) return null
  const first = tight ? suggested(hogs) : null
  // A paused task and the row to handle first stay visible while the rest is folded
  const shown = showAll ? hogs : hogs.filter((hog, i) => i < SHOWN || hog.paused || hog.key === first?.key)
  const total = machine?.memory.totalBytes ?? 0
  const used = machine?.memory.usedBytes ?? 0
  const listed = shown.reduce((sum, hog) => sum + hog.memoryBytes, 0)
  // The ranking and "memory used" are measured differently (the ranking includes swapped-out pages): the segments are
  // scaled so the bar never runs past the machine's memory
  const scale = total > 0 && listed > total ? total / listed : 1
  const rest = Math.max(0, used - listed * scale)
  const free = Math.max(0, total - Math.max(used, listed * scale))
  const note = first === null
    ? t('hogs.tight')
    : t(first.pausable ? 'hogs.tightPause' : 'hogs.tightEnd', { name: first.name, size: mem(first.memoryBytes) })
  return (
    <section className="panel hogs" data-tight={tight || undefined} aria-label={t('hogs.label')}>
      <h2 className="panel-title">{total > 0 ? t('hogs.titleOf', { total: mem(total) }) : t('hogs.title')}<span>{t('hogs.count', { n: hogs.length })}</span></h2>
      {total > 0 && (
        <>
          <div className="split" role="img" aria-label={t('hogs.splitLabel', { free: mem(free) })}>
            {shown.map((hog) => (
              <i key={hog.key} style={{ flex: hog.memoryBytes * scale }} data-hot={hovered === hog.key || undefined} data-first={first?.key === hog.key || undefined}
                title={`${hog.name} ${mem(hog.memoryBytes)}`} />
            ))}
            {rest > 0 && <i style={{ flex: rest }} title={t('hogs.rest', { size: mem(rest) })} />}
            {free > 0 && <i data-free="" style={{ flex: free }} title={t('hogs.free', { size: mem(free) })} />}
          </div>
          <p className="split-note"><span>{t('hogs.order')}</span><span>{t('hogs.free', { size: mem(free) })}</span></p>
        </>
      )}
      {tight && (
        <p className="hogs-note">
          {note}
          {briefsHeld && briefsEnabled && ` ${t('hogs.briefsHeld')}`}
        </p>
      )}
      <ul className="hog-list">
        {shown.map((hog) => (
          <HogRow key={hog.key} hog={hog} askedAt={asked[hog.key]} now={now} first={first?.key === hog.key} onHover={setHovered}
            onAsked={(key, at) => setAsked((before) => {
              const { [key]: _dropped, ...rest } = before
              return at === null ? rest : { ...rest, [key]: at }
            })} />
        ))}
      </ul>
      {hogs.length > shown.length || showAll ? (
        <button type="button" className="text-btn hogs-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? t('hogs.less') : t('hogs.more', { n: hogs.length - shown.length })}
        </button>
      ) : null}
    </section>
  )
}
