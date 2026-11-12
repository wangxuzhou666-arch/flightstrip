// Main page, laid out as a monitoring wall: a top bar, then a band of readings (sessions by state, this machine, the
// weekly limit), then the grouped tiles on the left with the memory ranking and the running jobs fixed in a rail on the
// right. Clicking a tile slides its details in from the right.
// Only two tabs: #/ overview (grouped the way you arranged it) and #/jobs background jobs. Retired sessions fold into
// the bottom of the overview. The language toggle sits at the right end of the top bar.
import { Fragment, useEffect, useState } from 'react'
import { type Lang, langFromLocale, type MessageKey } from '../../shared/i18n/index.ts'
import type { AgentStrip, BackgroundJob, Bay, Snapshot } from '../../shared/types.ts'
import { postLang } from './api.ts'
import { GroupedOverview, useReveal } from './Groups.tsx'
import { Hogs } from './Hogs.tsx'
import { I18nProvider, useI18n } from './i18n.tsx'
import { JobProgressRow, JobSignals, showsTail } from './JobSignals.tsx'
import { Machine } from './Machine.tsx'
import { JobLine, SessionDrawer, type Stage, StageIcon, StageMark } from './SessionCard.tsx'
import { Usage } from './Usage.tsx'
import { type Connection, useSnapshot } from './useSnapshot.ts'

type Tab = 'overview' | 'jobs'

const APP_NAME = 'flightstrip'
// Each language names itself, so the toggle reads the same whichever one is showing
const LANG_OPTIONS: { lang: Lang; label: string; htmlLang: string }[] = [
  { lang: 'en', label: 'EN', htmlLang: 'en' },
  { lang: 'zh', label: '中文', htmlLang: 'zh-CN' },
]

const COUNTS = [
  { bay: 'needs', tone: 'warn', word: 'counts.needs' },
  { bay: 'working', tone: 'ongoing', word: 'counts.working' },
  { bay: 'done', tone: 'ok', word: 'counts.done' },
  { bay: 'idle', tone: 'idle', word: 'counts.idle' },
] as const satisfies readonly { bay: Bay; tone: Stage['tone']; word: MessageKey }[]

/** A message with `commands` in backticks: the backticks go, the command is set in <code> */
function WithCode({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}</>
}

/** The status line, with the time of the snapshot set in bold */
function Status({ snapshot, connection }: { snapshot: Snapshot | null; connection: Connection }) {
  const { t, fmt } = useI18n()
  if (connection === 'lost') return <p className="status status--lost" role="status">{t('status.lost')}</p>
  if (snapshot === null) return <p className="status" role="status">{t('status.connecting')}</p>
  const time = fmt.clockWithSeconds(snapshot.takenAt)
  const [before, after = ''] = t('status.sessions', { n: snapshot.strips.length, time }).split(time)
  return <p className="status" role="status">{before}<b>{time}</b>{after}</p>
}

/** Left block of the band: how many sessions are in each state. When some need you, the number opens the first one */
function Counts({ snapshot, onOpen }: { snapshot: Snapshot; onOpen: (strip: AgentStrip) => void }) {
  const { t } = useI18n()
  const firstNeeds = snapshot.strips.find((strip) => strip.bay === 'needs') ?? null
  return (
    <section className="panel" aria-label={t('counts.label')}>
      <h2 className="panel-title">{t('counts.title')}<span>{t('counts.total', { n: snapshot.strips.length })}</span></h2>
      <div className="counts">
        {COUNTS.map(({ bay, tone, word }) => {
          const n = snapshot.strips.filter((strip) => strip.bay === bay).length
          const label = <span><StageIcon tone={tone} />{t(word)}</span>
          if (bay === 'needs' && firstNeeds !== null) {
            return (
              <button key={bay} type="button" className="count-cell count-cell--go" data-tone={tone} onClick={() => onOpen(firstNeeds)}
                title={t('session.open', { name: firstNeeds.name })}>
                <b>{n}</b>{label}
              </button>
            )
          }
          return <div key={bay} className="count-cell" data-tone={tone} data-zero={n === 0 || undefined}><b>{n}</b>{label}</div>
        })}
      </div>
    </section>
  )
}

/** Lower block of the rail: the background jobs running right now, and which session started each */
function Running({ snapshot, onOpen }: { snapshot: Snapshot; onOpen: (strip: AgentStrip) => void }) {
  const { t } = useI18n()
  const now = snapshot.takenAt
  const rows = snapshot.strips.flatMap((strip) => strip.jobs.filter((job) => job.status === 'running').map((job) => ({ job, strip })))
  rows.sort((a, b) => a.job.startedAt - b.job.startedAt)
  return (
    <section className="panel" aria-label={t('running.title')}>
      <h2 className="panel-title">{t('running.title')}<span>{t('running.count', { n: rows.length })}</span></h2>
      {rows.length === 0 ? (
        <p className="running-empty">{t('running.empty')}</p>
      ) : (
        <ul className="running">
          {rows.map(({ job, strip }) => (
            <li key={`${strip.sessionId}-${job.id}`}>
              <JobLine job={job} now={now} />
              <button type="button" className="text-link running-by" title={t('session.open', { name: strip.name })} onClick={() => onOpen(strip)}>{strip.name}</button>
              {job.progress !== null && <JobProgressRow progress={job.progress} />}
              <JobSignals job={job} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const JOB_STAGE = {
  running: { tone: 'ongoing', label: 'jobs.stage.running' },
  failed: { tone: 'err', label: 'jobs.stage.failed' },
  completed: { tone: 'ok', label: 'jobs.stage.completed' },
  stopped: { tone: 'idle', label: 'jobs.stage.stopped' },
} as const satisfies Record<BackgroundJob['status'], { tone: Stage['tone']; label: MessageKey }>

function Jobs({ snapshot }: { snapshot: Snapshot }) {
  const { t, fmt } = useI18n()
  const now = snapshot.takenAt
  const rows = snapshot.strips.flatMap((strip) => strip.jobs.map((job) => ({ job, strip })))
  const order = (job: BackgroundJob) => (job.status === 'running' ? 0 : job.status === 'failed' ? 1 : 2)
  rows.sort((a, b) => order(a.job) - order(b.job) || (b.job.endedAt ?? b.job.startedAt) - (a.job.endedAt ?? a.job.startedAt))
  return (
    <section className="panel jobs-panel" aria-label={t('tabs.jobs')}>
      <h2 className="panel-title">{t('tabs.jobs')}<span>{t('jobs.count', { n: rows.length })}</span></h2>
      {rows.length === 0 ? (
        <p className="running-empty">{t('jobs.empty')}</p>
      ) : (
        <ul className="rows">
          {rows.map(({ job, strip }) => {
            const stage = JOB_STAGE[job.status]
            const sub = job.status === 'running' ? t('jobs.runningFor', { span: fmt.span(job.startedAt, now) }) : job.endedAt === null ? '' : fmt.clock(job.endedAt)
            const meta = job.endedAt === null
              ? t('jobs.meta', { session: strip.name, time: fmt.clock(job.startedAt) })
              : t('jobs.metaTook', { session: strip.name, time: fmt.clock(job.startedAt), span: fmt.span(job.startedAt, job.endedAt) })
            return (
              <li key={`${strip.sessionId}-${job.id}`} className="row" data-attn={job.status === 'failed' ? 'err' : undefined}>
                <span className="row-stage"><StageMark stage={{ tone: stage.tone, label: t(stage.label), sub }} /></span>
                <span className="row-body">
                  <span className="row-title" title={job.description}>{job.name}</span>
                  <span className="row-meta">{meta}</span>
                  {job.progress !== null && <JobProgressRow progress={job.progress} />}
                  <JobSignals job={job} now={now} />
                  {showsTail(job) && <code className="job-tail" title={t('jobline.tail')}>{job.tail}</code>}
                  <details className="row-more">
                    <summary>{t('jobs.command')}</summary>
                    <code className="mono">{job.command}</code>
                  </details>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function useTab(): Tab {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash === '#/jobs' ? 'jobs' : 'overview'
}

/** Two quiet text buttons; the active one is marked like the active tab. The page switches when the snapshot comes back in the new language */
function LangToggle({ onFailure }: { onFailure: (message: string | null) => void }) {
  const { lang, t } = useI18n()
  const choose = (next: Lang) => {
    if (next === lang) return
    onFailure(null)
    postLang(next).catch((err: Error) => onFailure(err.message))
  }
  return (
    <span className="lang-toggle" role="group" aria-label={t('lang.label')}>
      {LANG_OPTIONS.map((option) => (
        <button key={option.lang} type="button" className="lang-btn" lang={option.htmlLang} aria-pressed={option.lang === lang}
          onClick={() => choose(option.lang)}>
          {option.label}
        </button>
      ))}
    </span>
  )
}

function Page({ snapshot, connection }: { snapshot: Snapshot | null; connection: Connection }) {
  const { t } = useI18n()
  const tab = useTab()
  const { collapsed, toggle, reveal } = useReveal()
  const [openId, setOpenId] = useState<string | null>(null)
  const [langFailure, setLangFailure] = useState<string | null>(null)
  const needsCount = snapshot?.strips.filter((s) => s.bay === 'needs').length ?? 0
  const openStrip = openId === null ? null : snapshot?.strips.find((s) => s.sessionId === openId) ?? null

  useEffect(() => {
    // When you switch to another window, the tab title tells you how many are waiting for you
    document.title = needsCount > 0 ? `(${needsCount}) ${APP_NAME}` : APP_NAME
  }, [needsCount])

  // The open session was retired or is gone: the details close with it
  useEffect(() => {
    if (openId !== null && snapshot !== null && openStrip === null) setOpenId(null)
  }, [openId, openStrip, snapshot])

  const open = (strip: AgentStrip) => {
    if (openId === strip.sessionId) {
      setOpenId(null)
      return
    }
    setOpenId(strip.sessionId)
    // Opened from the band or the rail: back to the overview, its group expanded, its tile in view
    if (tab !== 'overview') window.location.hash = '#/'
    reveal(strip)
  }

  const jobCount = snapshot?.strips.reduce((n, s) => n + s.jobs.length, 0) ?? 0
  const tabs: { id: Tab; href: string; label: string; count?: number }[] = [
    { id: 'overview', href: '#/', label: t('tabs.overview') },
    { id: 'jobs', href: '#/jobs', label: t('tabs.jobs'), count: jobCount },
  ]

  return (
    <div className="page">
      {__STATIC_DEMO__ && <div className="banner banner--plain banner--demo"><p><WithCode text={t('banner.sample')} /></p></div>}
      <header className="top">
        <h1 className="brand">
          {/* The mark: a solid control tower whose beacon and cab windows are lit in the brand blue; client/public/favicon.svg is the same shape */}
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <g fill="currentColor">
              <rect x="15.1" y="3.2" width="1.8" height="4" />
              <path d="M8.6 7h14.8l1.3 2.3H7.3z" />
              <path d="M5.4 10.3h21.2l-3.3 8.4H8.7z" />
              <path d="M12.2 19.8h7.6l1.7 9.4h-11z" />
              <rect x="6.5" y="29" width="19" height="2.2" rx="1.1" />
            </g>
            <g className="brand-accent">
              <path d="M7.75 12.3h16.5l-1.15 3.1H8.9z" />
              <circle cx="16" cy="2.4" r="1.9" />
            </g>
          </svg>
          {APP_NAME}
        </h1>
        <nav className="tabs" aria-label={t('tabs.label')}>
          {tabs.map((tabItem) => (
            <a key={tabItem.id} className="tab" href={tabItem.href} aria-current={tabItem.id === tab ? 'page' : undefined}>
              {tabItem.label}
              {tabItem.count !== undefined && tabItem.count > 0 && <span className="count">{tabItem.count}</span>}
            </a>
          ))}
        </nav>
        <Status snapshot={snapshot} connection={connection} />
        <LangToggle onFailure={setLangFailure} />
      </header>
      {langFailure !== null && <p className="error" role="alert">{langFailure}</p>}

      {snapshot?.error && (
        <p className="banner banner--err">{t('banner.agentsError', { error: snapshot.error })}</p>
      )}

      {snapshot !== null && (
        <>
          <section className="band" aria-label={t('band.label')}>
            <Counts snapshot={snapshot} onOpen={open} />
            {snapshot.machine !== null && <Machine machine={snapshot.machine} />}
            <Usage usage={snapshot.usage} now={snapshot.takenAt} />
          </section>

          {tab === 'overview' ? (
            <div className="body">
              <main className="main">
                <GroupedOverview snapshot={snapshot} collapsed={collapsed} toggle={toggle} openId={openId} onOpen={open} />
              </main>
              <aside className="rail" aria-label={t('rail.label')}>
                {snapshot.hogs !== null && (
                  <Hogs hogs={snapshot.hogs} machine={snapshot.machine} briefsHeld={snapshot.briefsHeld} briefsEnabled={snapshot.briefsEnabled} now={snapshot.takenAt} />
                )}
                <Running snapshot={snapshot} onOpen={open} />
              </aside>
            </div>
          ) : (
            <main className="body body--single">
              <Jobs snapshot={snapshot} />
            </main>
          )}

          {openStrip !== null && (
            <SessionDrawer strip={openStrip} groups={snapshot.groups} now={snapshot.takenAt} windowMs={snapshot.windowMs}
              briefsEnabled={snapshot.briefsEnabled} onClose={() => setOpenId(null)} />
          )}
        </>
      )}
    </div>
  )
}

export function Board() {
  const { snapshot, connection } = useSnapshot()
  // Before the first snapshot there is no server choice yet: follow the browser
  const lang = snapshot?.lang ?? langFromLocale(navigator.language)
  return (
    <I18nProvider lang={lang}>
      <Page snapshot={snapshot} connection={connection} />
    </I18nProvider>
  )
}
