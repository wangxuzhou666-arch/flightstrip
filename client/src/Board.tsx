// Main page of the dashboard: small title + underlined tabs, section titles with counts, quiet by default
// (places with nothing to show take no space).
// Only two tabs: #/ overview (grouped the way you arranged it) and #/jobs background jobs.
// The earlier Session page (split by state) and the pages page are gone; retired strips fold into the bottom of the overview.
// The language toggle sits at the right end of the tabs row.
import { Fragment, type ReactNode, useEffect, useState } from 'react'
import { type Lang, langFromLocale, type MessageKey } from '../../shared/i18n/index.ts'
import type { BackgroundJob, Snapshot } from '../../shared/types.ts'
import { postLang } from './api.ts'
import { GroupedOverview } from './Groups.tsx'
import { I18nProvider, useI18n } from './i18n.tsx'
import { JobProgressRow, JobSignals, showsTail } from './JobSignals.tsx'
import { Machine } from './Machine.tsx'
import { StageMark } from './SessionCard.tsx'
import { Usage } from './Usage.tsx'
import { type Connection, useSnapshot } from './useSnapshot.ts'

type Tab = 'overview' | 'jobs'

const APP_NAME = 'flightstrip'
// Each language names itself, so the toggle reads the same whichever one is showing
const LANG_OPTIONS: { lang: Lang; label: string; htmlLang: string }[] = [
  { lang: 'en', label: 'EN', htmlLang: 'en' },
  { lang: 'zh', label: '中文', htmlLang: 'zh-CN' },
]

function Section({ title, count, children, action }: { title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="section">
      <h2 className="section-title">
        {title}
        {count !== undefined && <span className="count">{count}</span>}
        {action && <span className="section-action">{action}</span>}
      </h2>
      {children}
    </section>
  )
}

/** A message with `commands` in backticks: the backticks go, the command is set in <code> */
function WithCode({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}</>
}

const JOB_STAGE = {
  running: { tone: 'ongoing', label: 'jobs.stage.running' },
  failed: { tone: 'err', label: 'jobs.stage.failed' },
  completed: { tone: 'ok', label: 'jobs.stage.completed' },
  stopped: { tone: 'idle', label: 'jobs.stage.stopped' },
} as const satisfies Record<BackgroundJob['status'], { tone: string; label: MessageKey }>

function Jobs({ snapshot }: { snapshot: Snapshot }) {
  const { t, fmt } = useI18n()
  const now = snapshot.takenAt
  const rows = snapshot.strips.flatMap((strip) => strip.jobs.map((job) => ({ job, strip })))
  const order = (job: BackgroundJob) => (job.status === 'running' ? 0 : job.status === 'failed' ? 1 : 2)
  rows.sort((a, b) => order(a.job) - order(b.job) || (b.job.endedAt ?? b.job.startedAt) - (a.job.endedAt ?? a.job.startedAt))
  return (
    <Section title={t('tabs.jobs')} count={rows.length}>
      <p className="hint">{t('jobs.hint')}</p>
      {rows.length > 0 && (
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
    </Section>
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
  const { t, fmt } = useI18n()
  const tab = useTab()
  const [langFailure, setLangFailure] = useState<string | null>(null)
  const needsCount = snapshot?.strips.filter((s) => s.bay === 'needs').length ?? 0

  useEffect(() => {
    // When you switch to another window, the tab title tells you how many are waiting for you
    document.title = needsCount > 0 ? `(${needsCount}) ${APP_NAME}` : APP_NAME
  }, [needsCount])

  const jobCount = snapshot?.strips.reduce((n, s) => n + s.jobs.length, 0) ?? 0
  const tabs: { id: Tab; href: string; label: string; count?: number }[] = [
    { id: 'overview', href: '#/', label: t('tabs.overview') },
    { id: 'jobs', href: '#/jobs', label: t('tabs.jobs'), count: jobCount },
  ]
  const status = connection === 'lost' ? t('status.lost')
    : snapshot === null ? t('status.connecting')
    : t('status.sessions', { n: snapshot.strips.length, time: fmt.clockWithSeconds(snapshot.takenAt) })

  return (
    <div className="page">
      {__STATIC_DEMO__ && <div className="banner banner--plain banner--demo"><p><WithCode text={t('banner.sample')} /></p></div>}
      <header className="head">
        <div className="head-main">
          <h1 className="title">
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.5 15l1-7h3l1 7 M4 8h8l-1-3H5z M8 5V2.5 M6 2.5h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            {APP_NAME}
          </h1>
          <p className={connection === 'lost' ? 'status status--lost' : 'status'} role="status">{status}</p>
        </div>
        {snapshot !== null && (
          <div className="head-meters">
            {snapshot.machine !== null && <Machine machine={snapshot.machine} />}
            <Usage usage={snapshot.usage} now={snapshot.takenAt} />
          </div>
        )}
      </header>

      <nav className="tabs" aria-label={t('tabs.label')}>
        {tabs.map((tabItem) => (
          <a key={tabItem.id} className="tab" href={tabItem.href} aria-current={tabItem.id === tab ? 'page' : undefined}>
            {tabItem.label}
            {tabItem.count !== undefined && tabItem.count > 0 && <span className="count">{tabItem.count}</span>}
          </a>
        ))}
        <LangToggle onFailure={setLangFailure} />
      </nav>
      {langFailure !== null && <p className="error" role="alert">{langFailure}</p>}

      {snapshot?.error && (
        <p className="banner banner--err">{t('banner.agentsError', { error: snapshot.error })}</p>
      )}

      {snapshot !== null && (
        <main className="main">
          {tab === 'overview' && <GroupedOverview snapshot={snapshot} />}
          {tab === 'jobs' && <Jobs snapshot={snapshot} />}
        </main>
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
