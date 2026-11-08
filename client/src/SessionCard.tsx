// One card per session: on the left "what to achieve" holds all the todos, on the right "how far along" holds the
// progress, the current moment and background jobs, with pages and worktrees at the bottom
import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/index.ts'
import type { AgentStrip, BackgroundJob, SessionGroup } from '../../shared/types.ts'
import { postAction, postGroup } from './api.ts'
import { type I18n, useI18n } from './i18n.tsx'
import { FolderIcon, RetireIcon } from './icons.tsx'
import { Timeline } from './Timeline.tsx'

const CHECK_KEYS = { pass: 'ci.pass', fail: 'ci.fail', pending: 'ci.pending' } as const satisfies Record<'pass' | 'fail' | 'pending', MessageKey>

interface Stage {
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

function StageIcon({ tone }: { tone: Stage['tone'] }) {
  if (tone === 'ongoing') {
    return (
      <svg className="spinner" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <g><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /></g>
      </svg>
    )
  }
  if (tone === 'ok') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity=".15" />
        <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return <i className="stage-dot" aria-hidden="true" />
}

export function StageMark({ stage }: { stage: Stage }) {
  return (
    <span className="stage" data-tone={stage.tone}>
      <StageIcon tone={stage.tone} />
      {stage.label}
      {stage.sub && <small>{stage.sub}</small>}
    </span>
  )
}

function Goals({ strip, briefsEnabled }: { strip: AgentStrip; briefsEnabled: boolean }) {
  const { t } = useI18n()
  const todos = strip.todos
  // todos === null only means "still being extracted" while briefs are on; with briefs off nothing is coming
  const note = todos === null ? (briefsEnabled ? t('goals.summarizing') : null) : t('goals.count', { done: todos.filter((todo) => todo.done).length, total: todos.length })
  return (
    <section className="goals" aria-label={t('goals.title')}>
      <h4>{t('goals.title')}{note !== null && <small title={strip.todoSource === 'session' ? t('goals.sourceSession') : t('goals.sourceBrief')}>{note}</small>}</h4>
      {todos !== null ? (
        <ul className="todos">
          {todos.map((todo, i) => (
            <li key={`${i}-${todo.text}`} className={todo.done ? 'todo todo--done' : 'todo'}>
              <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true">
                {todo.done ? (
                  <><rect x="0.5" y="0.5" width="11" height="11" rx="2.5" fill="currentColor" />
                    <path d="M3.3 6.2l1.8 1.8 3.6-4" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>
                ) : (
                  <rect x="1.25" y="1.25" width="9.5" height="9.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                )}
              </svg>
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

function JobLine({ job, now }: { job: BackgroundJob; now: number }) {
  const { t, fmt } = useI18n()
  const running = job.status === 'running'
  return (
    <li className={`job job--${job.status}`}>
      <span className="job-name" title={job.description}>
        {running ? <StageIcon tone="ongoing" /> : <i className="stage-dot" aria-hidden="true" />}
        {job.name}
      </span>
      <span className="job-time">
        {running
          ? t('jobline.running', { time: fmt.clock(job.startedAt), span: fmt.span(job.startedAt, now) })
          : t('jobline.failed', { time: fmt.clock(job.endedAt ?? job.startedAt) })}
      </span>
      {job.tail && <code className="job-tail" title={t('jobline.tail')}>{job.tail}</code>}
    </li>
  )
}

function Updates({ strip, now, windowMs }: { strip: AgentStrip; now: number; windowMs: number }) {
  const { t, fmt } = useI18n()
  // The card only shows running and failed jobs; finished or stopped ones are on the "background jobs" page
  const shown = strip.jobs.filter((job) => job.status === 'running' || (job.status === 'failed' && (job.endedAt ?? 0) >= now - windowMs))
  const quiet = strip.jobs.length - shown.length
  const nowLabel = strip.stateKind === 'working' ? t('progress.nowWorking') : strip.stateKind === 'needs' ? t('progress.nowNeeds') : t('progress.nowOther')
  return (
    <section className="updates" aria-label={t('progress.title')}>
      <h4>{t('progress.title')}{strip.progressAt !== null && <small>{t('progress.summarizedAt', { time: fmt.clock(strip.progressAt) })}</small>}</h4>
      {strip.progress !== null && <p className="progress">{strip.progress}</p>}
      <p className="now" title={strip.now}><span className="now-label">{nowLabel}</span>{strip.now}</p>
      {shown.length > 0 && (
        <ul className="jobs" aria-label={t('tabs.jobs')}>
          {shown.map((job) => <JobLine key={job.id} job={job} now={now} />)}
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

function Detail({ strip }: { strip: AgentStrip }) {
  const { t, fmt } = useI18n()
  return (
    <div className="detail">
      <div>
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
      </div>
      <div>
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
      </div>
    </div>
  )
}

const NEW_GROUP = '__new__'

/** The group control at the top right: shows which group it is in; opening it gives a native dropdown whose last item creates a group */
function GroupPicker({ strip, groups, disabled, onPick }: {
  strip: AgentStrip; groups: SessionGroup[]; disabled: boolean; onPick: (value: string) => void
}) {
  const { t } = useI18n()
  const current = groups.find((group) => group.id === strip.groupId)
  return (
    <span className="group-pick" data-empty={current === undefined ? '' : undefined}>
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

// The session-switch line comes from the snapshot (FLIGHTSTRIP_CONTEXT_LINE): past it, reasoning quality degrades.
// The transcript has no window limit (the model name carries no 1m marker), so no window percentage is computed;
// a full bar is this line
const CONTEXT_WARN_RATIO = 0.75

function tokensLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}K`
}

/** Gray and unobtrusive normally; amber from 75% of the line, red and spelled out once past it */
function ContextMeter({ tokens, contextLine }: { tokens: number; contextLine: number }) {
  const { t } = useI18n()
  const line = tokensLabel(contextLine)
  const tone = tokens >= contextLine ? 'high' : tokens >= contextLine * CONTEXT_WARN_RATIO ? 'warn' : 'ok'
  const title = t('ctx.title', { tokens: tokens.toLocaleString('en-US'), line })
  return (
    <span className="ctx" data-tone={tone} title={title}>
      <span className="ctx-label">{tone === 'high' ? t('ctx.labelOver', { tokens: tokensLabel(tokens), line }) : t('ctx.label', { tokens: tokensLabel(tokens) })}</span>
      <span className="ctx-track" aria-hidden="true">
        <span className="ctx-fill" style={{ width: `${Math.min(100, (tokens / contextLine) * 100)}%` }} />
      </span>
    </span>
  )
}

export function SessionCard({ strip, groups, now, windowMs, briefsEnabled, contextLine }: {
  strip: AgentStrip; groups: SessionGroup[]; now: number; windowMs: number; briefsEnabled: boolean; contextLine: number
}) {
  const i18n = useI18n()
  const { t } = i18n
  const [mode, setMode] = useState<Mode>('view')
  const [draft, setDraft] = useState(strip.name)
  const [groupDraft, setGroupDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const detailId = `detail-${strip.sessionId}`
  // Retiring a live background session needs claude stop first, hence one extra confirmation; otherwise it just collapses and can be restored any time under "Retired"
  const stopsProcess = strip.kind === 'background' && (strip.stateKind === 'working' || strip.stateKind === 'needs')
  const stage = stageOf(strip, now, i18n)

  const run = (action: () => Promise<void>) => {
    setMode('busy')
    setFailure(null)
    action()
      .then(() => setMode('view'))
      .catch((err: Error) => {
        setFailure(err.message)
        setMode('view')
      })
  }
  const saveName = () => run(() => postAction(strip.sessionId, 'rename', { name: draft }))
  const retireNow = () => run(() => postAction(strip.sessionId, 'retire'))
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
    <li className="card" id={`card-${strip.sessionId}`} data-attn={strip.bay === 'needs' ? stage.tone : undefined}
      style={{ viewTransitionName: `card-${strip.sessionId.slice(0, 8)}` }}>
      <div className="card-head">
        {mode === 'renaming' ? (
          <form className="rename" onSubmit={(e) => { e.preventDefault(); saveName() }}>
            <label className="visually-hidden" htmlFor={`name-${strip.sessionId}`}>{t('card.newName')}</label>
            <input id={`name-${strip.sessionId}`} className="input" value={draft} maxLength={80} autoFocus
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setMode('view')} />
            <button type="submit" className="btn btn--primary">{t('common.save')}</button>
            <button type="button" className="btn btn--outline" onClick={() => setMode('view')}>{t('common.cancel')}</button>
          </form>
        ) : (
          <h3 className="card-name">
            <button type="button" className="card-name-btn" title={t('card.renameTitle', { name: strip.name })} disabled={mode === 'busy'}
              onClick={() => { setDraft(strip.name); setMode('renaming') }}>
              {strip.name}
            </button>
          </h3>
        )}
        {strip.pr !== null && (
          <a className={`tag tag--${strip.pr.checks ?? 'none'}`} href={strip.pr.url} target="_blank" rel="noreferrer">
            PR #{strip.pr.number}{strip.pr.checks && ` ${t(CHECK_KEYS[strip.pr.checks])}`}
          </a>
        )}
        {strip.contextTokens !== null && <ContextMeter tokens={strip.contextTokens} contextLine={contextLine} />}
        <StageMark stage={stage} />
        {mode !== 'renaming' && (
          <span className="card-tools">
            <GroupPicker strip={strip} groups={groups} disabled={mode === 'busy'} onPick={pickGroup} />
            <button type="button" className="icon-btn" aria-label={retireTitle} title={retireTitle} disabled={mode === 'busy'}
              onClick={() => (stopsProcess ? setMode('confirmRetire') : retireNow())}>
              <RetireIcon />
            </button>
          </span>
        )}
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
      <div className="card-grid">
        <Goals strip={strip} briefsEnabled={briefsEnabled} />
        <Updates strip={strip} now={now} windowMs={windowMs} />
      </div>
      <div className="card-foot">
        <Chips strip={strip} />
        <button type="button" className="text-btn" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
          {open ? t('card.hideDetails') : t('card.showDetails')}
        </button>
      </div>
      <div id={detailId} hidden={!open}>{open && <Detail strip={strip} />}</div>
    </li>
  )
}
