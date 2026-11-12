// A session is one tile on the overview: its stage, name, one line on how far it got, one running job or the next to-do,
// and three figures (to-dos, context, memory). Clicking the name slides the details in from the right: the full to-do
// list, progress, background jobs, the timeline and recent activity, with rename, regroup and retire up top
import { useEffect, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/index.ts'
import type { AgentStrip, BackgroundJob, SessionGroup } from '../../shared/types.ts'
import { postAction, postGroup } from './api.ts'
import { formatBytes } from './format.ts'
import { type I18n, useI18n } from './i18n.tsx'
import { FolderIcon, RetireIcon } from './icons.tsx'
import { JobProgressRow, JobSignals, showsTail } from './JobSignals.tsx'
import { Timeline } from './Timeline.tsx'

const CHECK_KEYS = { pass: 'ci.pass', fail: 'ci.fail', pending: 'ci.pending' } as const satisfies Record<'pass' | 'fail' | 'pending', MessageKey>

export interface Stage {
  tone: 'ongoing' | 'warn' | 'err' | 'ok' | 'idle'
  label: string
  sub: string
}

/** The stage is written as "who waits for whom, for how long", never as an internal state code */
export function stageOf(strip: AgentStrip, now: number, { t, fmt }: Pick<I18n, 't' | 'fmt'>): Stage {
  const since = strip.stateSince ?? strip.updatedAt
  if (strip.stateKind === 'failed') return { tone: 'err', label: t('stage.failed'), sub: fmt.ago(strip.updatedAt, now) }
  if (strip.stateKind === 'needs') return { tone: 'warn', label: t('stage.needs'), sub: since === null ? '' : t('stage.needsSince', { span: fmt.span(since, now) }) }
  if (strip.bay === 'needs') return { tone: 'err', label: t('stage.jobFailed'), sub: t('stage.jobFailedSub') }
  if (strip.stateKind === 'working') return { tone: 'ongoing', label: t('stage.working'), sub: since === null ? '' : t('stage.workingSince', { span: fmt.span(since, now) }) }
  if (strip.bay === 'working') return { tone: 'ongoing', label: t('stage.jobsRunning'), sub: fmt.joinAgo(t('stage.chatStopped'), strip.updatedAt, now) }
  if (strip.stateKind === 'done') return { tone: 'ok', label: t('stage.done'), sub: fmt.ago(strip.updatedAt, now) }
  if (strip.bay === 'done') return { tone: 'ok', label: t('stage.turnDone'), sub: fmt.ago(strip.updatedAt, now) }
  return { tone: 'idle', label: t('stage.idle'), sub: fmt.ago(strip.updatedAt, now) }
}

/** One shape per stage, so color is never the only cue: spinner = working, speech bubble = waiting for you,
 *  check = done, triangle = failed, hollow ring = idle */
export function StageIcon({ tone }: { tone: Stage['tone'] }) {
  if (tone === 'ongoing') {
    return (
      <svg className="stage-icon spinner" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <g><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /></g>
      </svg>
    )
  }
  if (tone === 'warn') {
    return (
      <svg className="stage-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.2 2.5h9.6a1.7 1.7 0 0 1 1.7 1.7v5.1a1.7 1.7 0 0 1-1.7 1.7H8.3l-3.4 2.7V11H3.2a1.7 1.7 0 0 1-1.7-1.7V4.2a1.7 1.7 0 0 1 1.7-1.7z" fill="currentColor" />
      </svg>
    )
  }
  if (tone === 'ok') {
    return (
      <svg className="stage-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.8 8.2l2.1 2.1 4.2-4.5" fill="none" stroke="var(--panel)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (tone === 'err') {
    return (
      <svg className="stage-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.6l6.8 12H1.2z" fill="currentColor" />
        <path d="M8 6v3.6M8 11.6v.2" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className="stage-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function StageMark({ stage, withSub = true }: { stage: Stage; withSub?: boolean }) {
  return (
    <span className="stage" data-tone={stage.tone}>
      <StageIcon tone={stage.tone} />
      {stage.label}
      {withSub && stage.sub && <small>{stage.sub}</small>}
    </span>
  )
}

/** A background job squeezed into one line: icon, name, how long it has run or that it failed */
export function JobLine({ job, now }: { job: BackgroundJob; now: number }) {
  const { t, fmt } = useI18n()
  const running = job.status === 'running'
  return (
    <p className="tile-line" data-tone={running ? 'ongoing' : 'err'}>
      <StageIcon tone={running ? 'ongoing' : 'err'} />
      <span className="clamp1" title={job.description}>{job.name}</span>
      <small>{running ? t('jobs.runningFor', { span: fmt.span(job.startedAt, now) }) : t('jobs.stage.failed')}</small>
    </p>
  )
}

// The context meter is full at the session-switch line from the snapshot (FLIGHTSTRIP_CONTEXT_LINE): past it,
// reasoning quality drops. The transcript has no window limit (the model name carries no 1m marker), so no window
// percentage is computed. Amber from 75% of the line
const CONTEXT_WARN_RATIO = 0.75
// A session holding this much memory with everything it started is marked: on a 16 GB machine that is an eighth
const HEAVY_BYTES = 2 * 1024 ** 3

type FigLevel = 'ok' | 'warn' | 'high' | 'full' | undefined

/** A thin bar whose track is a light step of its own fill, so the whole bar reads as its state */
export function Meter({ fraction, level }: { fraction: number; level?: FigLevel }) {
  return (
    <span className="meter" data-level={level} aria-hidden="true">
      <i style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%` }} />
    </span>
  )
}

function tokensLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}K`
}

function todoCount(strip: AgentStrip): { done: number; total: number } | null {
  if (strip.todos === null) return null
  // Finished items todo.mjs no longer lists still count, so the tally never drops when an old one falls off
  const earlier = strip.todosDoneEarlier
  return { done: earlier + strip.todos.filter((todo) => todo.done).length, total: earlier + strip.todos.length }
}

/** The three figures at the bottom of a tile: to-dos done, how close the context is to the switch line, and the memory
 *  of the session with everything it started */
function Figures({ strip, briefsEnabled, contextLine }: { strip: AgentStrip; briefsEnabled: boolean; contextLine: number }) {
  const { t } = useI18n()
  const todos = todoCount(strip)
  const tokens = strip.contextTokens
  const ctxLevel = tokens === null ? undefined : tokens >= contextLine ? 'high' : tokens >= contextLine * CONTEXT_WARN_RATIO ? 'warn' : undefined
  const heavy = strip.memoryBytes !== null && strip.memoryBytes >= HEAVY_BYTES
  // todos === null only means "still being extracted" while briefs are on; with briefs off nothing is coming
  const todoValue = todos !== null ? `${todos.done}/${todos.total}` : briefsEnabled ? t('goals.summarizing') : '—'
  return (
    <div className="tile-figs">
      <span className="fig" title={strip.todoSource === 'session' ? t('goals.sourceSession') : t('goals.sourceBrief')}>
        <span className="fig-top"><i>{t('fig.todos')}</i><b>{todoValue}</b></span>
        {todos !== null && <Meter fraction={todos.total === 0 ? 0 : todos.done / todos.total} level={todos.total > 0 && todos.done === todos.total ? 'full' : undefined} />}
      </span>
      <span className="fig" data-level={ctxLevel}
        title={tokens === null ? t('ctx.unknown') : t('ctx.title', { tokens: tokens.toLocaleString('en-US'), line: tokensLabel(contextLine) })}>
        <span className="fig-top"><i>{t('fig.context')}</i><b>{tokens === null ? '—' : tokensLabel(tokens)}</b></span>
        {tokens !== null && <Meter fraction={tokens / contextLine} level={ctxLevel} />}
      </span>
      <span className="fig" data-level={heavy ? 'warn' : undefined} title={strip.memoryBytes === null ? t('fig.memoryNone') : t('fig.memoryHint')}>
        <span className="fig-top"><i>{t('fig.memory')}</i><b>{strip.memoryBytes === null ? '—' : formatBytes(strip.memoryBytes, 1024)}</b></span>
      </span>
    </div>
  )
}

/** One line on a tile: a running or just-failed job first, otherwise the next unfinished to-do */
function TileLine({ strip, now, windowMs }: { strip: AgentStrip; now: number; windowMs: number }) {
  const { t } = useI18n()
  const job = strip.jobs.find((j) => j.status === 'running') ?? strip.jobs.find((j) => j.status === 'failed' && (j.endedAt ?? 0) >= now - windowMs)
  if (job !== undefined) return <JobLine job={job} now={now} />
  const next = strip.todos?.find((todo) => !todo.done)
  if (next === undefined) return null
  return (
    <p className="tile-line" data-next="">
      <StageIcon tone="idle" />
      <span className="clamp1" title={t('tile.nextTodo', { text: next.text })}>{next.text}</span>
    </p>
  )
}

export function SessionTile({ strip, now, windowMs, briefsEnabled, contextLine, open, onOpen }: {
  strip: AgentStrip; now: number; windowMs: number; briefsEnabled: boolean; contextLine: number; open: boolean; onOpen: () => void
}) {
  const i18n = useI18n()
  const stage = stageOf(strip, now, i18n)
  const summary = strip.progress ?? strip.goal ?? strip.now
  return (
    <li className="tile" id={`card-${strip.sessionId}`} data-tone={stage.tone} data-attn={strip.bay === 'needs' ? stage.tone : undefined}
      data-open={open || undefined} style={{ viewTransitionName: `card-${strip.sessionId.slice(0, 8)}` }}>
      <div className="tile-head">
        <StageMark stage={stage} withSub={false} />
        {strip.pr !== null && (
          <a className={`tag tag--${strip.pr.checks ?? 'none'}`} href={strip.pr.url} target="_blank" rel="noreferrer">
            PR #{strip.pr.number}{strip.pr.checks && ` ${i18n.t(CHECK_KEYS[strip.pr.checks])}`}
          </a>
        )}
        <span className="tile-sub">{stage.sub}</span>
      </div>
      <h3 className="tile-name">
        <button type="button" className="tile-open clamp1" title={strip.name} aria-expanded={open} aria-controls="session-drawer" onClick={onOpen}>
          {strip.name}
        </button>
      </h3>
      <p className="tile-progress clamp3">{summary}</p>
      <TileLine strip={strip} now={now} windowMs={windowMs} />
      <Figures strip={strip} briefsEnabled={briefsEnabled} contextLine={contextLine} />
    </li>
  )
}

/* ---------------- details ---------------- */

function TodoBox({ done }: { done: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true">
      {done ? (
        <><rect x="0.5" y="0.5" width="11" height="11" rx="2.5" fill="currentColor" />
          <path d="M3.3 6.2l1.8 1.8 3.6-4" fill="none" stroke="var(--panel)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>
      ) : (
        <rect x="1.25" y="1.25" width="9.5" height="9.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      )}
    </svg>
  )
}

function Goals({ strip, briefsEnabled }: { strip: AgentStrip; briefsEnabled: boolean }) {
  const { t } = useI18n()
  const todos = strip.todos
  const count = todoCount(strip)
  const note = count !== null ? t('goals.count', count) : briefsEnabled ? t('goals.summarizing') : null
  return (
    <section aria-label={t('goals.title')}>
      <h4>{t('goals.title')}{note !== null && <small title={strip.todoSource === 'session' ? t('goals.sourceSession') : t('goals.sourceBrief')}>{note}</small>}</h4>
      {todos !== null ? (
        <ul className="todos">
          {strip.todosDoneEarlier > 0 && (
            <li className="todo todo--done todo--earlier"><TodoBox done /><span>{t('goals.earlier', { n: strip.todosDoneEarlier })}</span></li>
          )}
          {todos.map((todo, i) => (
            <li key={`${i}-${todo.text}`} className={todo.done ? 'todo todo--done' : 'todo'}>
              <TodoBox done={todo.done} />
              <span>{todo.text}</span>
            </li>
          ))}
        </ul>
      ) : strip.goal !== null ? (
        <p className="goal-raw">{t('goals.opening', { goal: strip.goal })}</p>
      ) : (
        <p className="muted">{t('goals.empty')}</p>
      )}
    </section>
  )
}

function JobRow({ job, now }: { job: BackgroundJob; now: number }) {
  const { t, fmt } = useI18n()
  const running = job.status === 'running'
  return (
    <li className={`job job--${job.status}`}>
      <span className="job-name" title={job.description}>
        <StageIcon tone={running ? 'ongoing' : 'err'} />
        <span>{job.name}</span>
      </span>
      <span className="job-time">
        {running
          ? t('jobline.running', { time: fmt.clock(job.startedAt), span: fmt.span(job.startedAt, now) })
          : t('jobline.failed', { time: fmt.clock(job.endedAt ?? job.startedAt) })}
      </span>
      {job.progress !== null && <JobProgressRow progress={job.progress} />}
      <JobSignals job={job} now={now} />
      {showsTail(job) && <code className="job-tail" title={t('jobline.tail')}>{job.tail}</code>}
    </li>
  )
}

function Updates({ strip, now, windowMs }: { strip: AgentStrip; now: number; windowMs: number }) {
  const { t, fmt } = useI18n()
  // Only running and failed jobs here; finished or stopped ones are on the "background jobs" page
  const shown = strip.jobs.filter((job) => job.status === 'running' || (job.status === 'failed' && (job.endedAt ?? 0) >= now - windowMs))
  const quiet = strip.jobs.length - shown.length
  const nowLabel = strip.stateKind === 'working' ? t('progress.nowWorking') : strip.stateKind === 'needs' ? t('progress.nowNeeds') : t('progress.nowOther')
  return (
    <section className="updates" aria-label={t('progress.title')}>
      <h4>{t('progress.title')}{strip.progressAt !== null && <small>{t('progress.summarizedAt', { time: fmt.clock(strip.progressAt) })}</small>}</h4>
      {strip.progress !== null && <p className="progress">{strip.progress}</p>}
      <p className="now"><span className="now-label">{nowLabel}</span>{strip.now}</p>
      {shown.length > 0 && (
        <ul className="jobs" aria-label={t('tabs.jobs')}>
          {shown.map((job) => <JobRow key={job.id} job={job} now={now} />)}
        </ul>
      )}
      {quiet > 0 && <a className="text-link" href="#/jobs">{t('progress.moreJobs', { n: quiet })}</a>}
      <Timeline strip={strip} now={now} windowMs={windowMs} />
    </section>
  )
}

function Chips({ strip }: { strip: AgentStrip }) {
  const { t, fmt } = useI18n()
  const trees = strip.worktrees.filter((tree) => tree.exists)
  const where = strip.project !== null || strip.kind === 'background'
  if (strip.pages.length === 0 && trees.length === 0 && !where) return null
  return (
    <div className="chips">
      {where && (
        <span className="chip"><span className="chip-src">{strip.surface}</span><span className="chip-fact">{strip.project ?? t('project.none')}</span></span>
      )}
      {strip.pages.map((page) => page.live ? (
        <a key={page.url} className="chip chip--link" href={page.url} target="_blank" rel="noreferrer" title={t('chip.pageLive', { time: fmt.clock(page.lastAt) })}>
          <span className="chip-src">{t('chip.page')}</span><span className="chip-fact"><i className="live-dot" aria-hidden="true" />{page.label}</span>
          <span className="chip-open" aria-hidden="true">↗</span>
        </a>
      ) : (
        <span key={page.url} className="chip" title={t('chip.pageGone', { time: fmt.clock(page.lastAt) })}>
          <span className="chip-src">{t('chip.page')}</span><span className="chip-fact chip-fact--gone">{page.label}</span><span className="chip-fact chip-fact--quiet">{t('chip.pageClosed')}</span>
        </span>
      ))}
      {trees.length > 0 && (
        <span className="chip" title={trees.map((tree) => t('chip.worktreeTip', { path: tree.path, time: fmt.clock(tree.lastAt) })).join('\n')}>
          <span className="chip-src">worktree</span>
          {trees.map((tree) => <span key={tree.path} className="chip-fact">{tree.name}</span>)}
        </span>
      )}
    </div>
  )
}

function CopyCommand({ command }: { command: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  return <button type="button" className="btn btn--outline" onClick={copy}>{copied ? t('copy.done') : t('copy.action', { command })}</button>
}

function More({ strip }: { strip: AgentStrip }) {
  const { t, fmt } = useI18n()
  return (
    <section aria-label={t('drawer.more')}>
      {strip.lastPrompt && (
        <>
          <h5>{t('detail.lastSaid')}</h5>
          <p className="detail-text">{strip.lastPrompt}</p>
        </>
      )}
      <h5>{t('detail.recent')}</h5>
      {strip.events.length === 0 ? (
        <p className="detail-text muted">{t('detail.noEvents')}</p>
      ) : (
        <ol className="events">
          {strip.events.map((event) => (
            <li key={`${event.at}-${event.actor}`}>
              <span className="event-time">{fmt.clock(event.at)}</span>
              <span className="event-actor">{event.actor === 'you' ? t('detail.you') : t('detail.ai')}</span>
              <span className="event-text">{event.text || t('detail.noText')}</span>
            </li>
          ))}
        </ol>
      )}
      {strip.subagents.length > 0 && (
        <>
          <h5>{t('detail.subagents')}</h5>
          <ul className="subagents">
            {strip.subagents.map((sub) => (
              <li key={sub.id}><span className="muted">{sub.agentType}</span> {sub.description}{sub.running && <small> {t('detail.subRunning')}</small>}</li>
            ))}
          </ul>
        </>
      )}
      <h5>{t('detail.location')}</h5>
      <p className="detail-text mono">{strip.cwd}</p>
      {strip.branch && strip.branch !== 'HEAD' && <p className="detail-text">{t('detail.branch', { branch: strip.branch })}</p>}
      <h5>{t('detail.takeOver')}</h5>
      {strip.kind === 'background' ? (
        <CopyCommand command={`claude attach ${strip.shortId}`} />
      ) : (
        <p className="detail-text">{t('detail.openElsewhere', { surface: strip.surface })}</p>
      )}
    </section>
  )
}

const NEW_GROUP = '__new__'

/** Shows which group it is in; opening it gives a native dropdown whose last item creates a group */
function GroupPicker({ strip, groups, disabled, onPick }: {
  strip: AgentStrip; groups: SessionGroup[]; disabled: boolean; onPick: (value: string) => void
}) {
  const { t } = useI18n()
  const current = groups.find((group) => group.id === strip.groupId)
  return (
    <span className="group-pick">
      <FolderIcon />
      <span className="group-pick-name">{current?.name ?? t('group.ungrouped')}</span>
      <select aria-label={t('picker.moveTo')} title={t('picker.moveTo')} value={strip.groupId ?? ''} disabled={disabled}
        onChange={(e) => onPick(e.target.value)}>
        <option value="">{t('group.ungrouped')}</option>
        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        <option value={NEW_GROUP}>{t('picker.newGroup')}</option>
      </select>
    </span>
  )
}

type Mode = 'view' | 'renaming' | 'newGroup' | 'confirmRetire' | 'busy'

export function SessionDrawer({ strip, groups, now, windowMs, briefsEnabled, onClose }: {
  strip: AgentStrip; groups: SessionGroup[]; now: number; windowMs: number; briefsEnabled: boolean; onClose: () => void
}) {
  const i18n = useI18n()
  const { t } = i18n
  const [mode, setMode] = useState<Mode>('view')
  const [draft, setDraft] = useState(strip.name)
  const [groupDraft, setGroupDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  // Retiring a live background session needs claude stop first, hence one extra confirmation; otherwise it just
  // collapses and can be restored any time under "Retired"
  const stopsProcess = strip.kind === 'background' && (strip.stateKind === 'working' || strip.stateKind === 'needs')
  const stage = stageOf(strip, now, i18n)

  // Another session opened: back to viewing
  useEffect(() => {
    setMode('view')
    setFailure(null)
  }, [strip.sessionId])

  useEffect(() => {
    // Esc closes the details; while renaming or naming a group, Esc only cancels that step
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode === 'view') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onClose])

  const run = (action: () => Promise<void>, after?: () => void) => {
    setMode('busy')
    setFailure(null)
    action()
      .then(() => {
        setMode('view')
        after?.()
      })
      .catch((err: Error) => {
        setFailure(err.message)
        setMode('view')
      })
  }
  const saveName = () => run(() => postAction(strip.sessionId, 'rename', { name: draft }))
  // A retired tile leaves the overview, so the details close with it
  const retireNow = () => run(() => postAction(strip.sessionId, 'retire'), onClose)
  const pickGroup = (value: string) => {
    if (value === NEW_GROUP) {
      setGroupDraft('')
      setMode('newGroup')
    } else {
      run(() => postAction(strip.sessionId, 'group', { groupId: value === '' ? null : value }))
    }
  }
  const createGroup = () => run(() => postGroup('create', { name: groupDraft, sessionId: strip.sessionId }))
  const retireTitle = stopsProcess ? t('card.retireStop') : t('card.retireHide')

  return (
    <aside className="drawer" id="session-drawer" aria-label={t('drawer.label', { name: strip.name })}>
      <div className="drawer-head">
        {mode === 'renaming' ? (
          <form className="rename" onSubmit={(e) => { e.preventDefault(); saveName() }}>
            <label className="visually-hidden" htmlFor={`name-${strip.sessionId}`}>{t('card.newName')}</label>
            <input id={`name-${strip.sessionId}`} className="input" value={draft} maxLength={80} autoFocus
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setMode('view')} />
            <button type="submit" className="btn btn--primary">{t('common.save')}</button>
            <button type="button" className="btn btn--outline" onClick={() => setMode('view')}>{t('common.cancel')}</button>
          </form>
        ) : (
          <h3 className="drawer-name">
            <button type="button" className="drawer-name-btn" title={t('card.renameTitle', { name: strip.name })} disabled={mode === 'busy'}
              onClick={() => { setDraft(strip.name); setMode('renaming') }}>
              {strip.name}
            </button>
          </h3>
        )}
        <button type="button" className="btn btn--outline" onClick={onClose}>{t('drawer.close')}</button>
      </div>
      <div className="drawer-state">
        <StageMark stage={stage} />
        {strip.pr !== null && (
          <a className={`tag tag--${strip.pr.checks ?? 'none'}`} href={strip.pr.url} target="_blank" rel="noreferrer">
            PR #{strip.pr.number}{strip.pr.checks && ` ${t(CHECK_KEYS[strip.pr.checks])}`}
          </a>
        )}
        <span className="drawer-tools">
          <GroupPicker strip={strip} groups={groups} disabled={mode === 'busy'} onPick={pickGroup} />
          <button type="button" className="icon-btn" aria-label={retireTitle} title={retireTitle} disabled={mode === 'busy'}
            onClick={() => (stopsProcess ? setMode('confirmRetire') : retireNow())}>
            <RetireIcon />
          </button>
        </span>
      </div>
      {mode === 'newGroup' && (
        <form className="banner banner--plain" onSubmit={(e) => { e.preventDefault(); createGroup() }}>
          <label className="visually-hidden" htmlFor={`group-${strip.sessionId}`}>{t('group.newName')}</label>
          <input id={`group-${strip.sessionId}`} className="input" value={groupDraft} maxLength={30} autoFocus placeholder={t('group.namePlaceholder')}
            onChange={(e) => setGroupDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setMode('view')} />
          <button type="submit" className="btn btn--primary" disabled={groupDraft.trim() === ''}>{t('card.createAndMove')}</button>
          <button type="button" className="btn btn--outline" onClick={() => setMode('view')}>{t('common.cancel')}</button>
        </form>
      )}
      {mode === 'confirmRetire' && (
        <div className="banner">
          <p>{t('card.confirmRetire', { id: strip.shortId })}</p>
          <button type="button" className="btn btn--primary" onClick={retireNow}>{t('card.stopAndRetire')}</button>
          <button type="button" className="btn btn--outline" onClick={() => setMode('view')}>{t('common.cancel')}</button>
        </div>
      )}
      {failure !== null && <p className="error" role="alert">{failure}</p>}
      <Updates strip={strip} now={now} windowMs={windowMs} />
      <Goals strip={strip} briefsEnabled={briefsEnabled} />
      <Chips strip={strip} />
      <More strip={strip} />
    </aside>
  )
}
