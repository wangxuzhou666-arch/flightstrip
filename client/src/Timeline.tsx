// The past 3 hours: when this session was active and when the background jobs it started were running.
// User feedback 2026-11-07: a lone thin bar with the phrase "past 3 hours" beside it was misread as a progress bar.
// So it is collapsed by default with the conclusion in the title; once expanded every lane is labeled, the axis shows
// clock times, and the meaning of each color is written beside it
import type { MessageKey } from '../../shared/i18n/index.ts'
import type { AgentStrip, BackgroundJob, Segment } from '../../shared/types.ts'
import { type I18n, useI18n } from './i18n.tsx'

const HOUR = 3_600_000

function position(at: number, start: number, windowMs: number): number {
  return Math.min(100, Math.max(0, ((at - start) / windowMs) * 100))
}

function Bar({ from, to, start, windowMs, className, title }: {
  from: number; to: number; start: number; windowMs: number; className: string; title: string
}) {
  const left = position(from, start, windowMs)
  const width = Math.max(0.6, position(to, start, windowMs) - left)
  return <span className={className} style={{ left: `${left}%`, width: `${width}%` }} title={title} />
}

const SEGMENT_KEYS = {
  working: 'timeline.working', needs: 'timeline.needs', failed: 'timeline.failed', done: 'timeline.done',
} as const satisfies Partial<Record<Segment['state'], MessageKey>>
const JOB_BAR_KEYS = {
  running: 'timeline.bar.running', completed: 'timeline.bar.completed', failed: 'timeline.bar.failed', stopped: 'timeline.bar.stopped',
} as const satisfies Record<BackgroundJob['status'], MessageKey>
const JOB_LEGEND_KEYS = {
  running: 'timeline.legend.running', completed: 'timeline.legend.completed', failed: 'timeline.legend.failed', stopped: 'timeline.legend.stopped',
} as const satisfies Record<BackgroundJob['status'], MessageKey>

/** The one-line headline shown while collapsed */
function headline(strip: AgentStrip, jobs: BackgroundJob[], now: number, { t, fmt }: Pick<I18n, 't' | 'fmt'>): string {
  const turns = strip.segments.filter((s) => s.state === 'working').length
  const parts = [turns === 0 ? t('timeline.quiet') : `${t('timeline.active', { n: turns })}${t('sep.comma')}${fmt.joinAgo(t('timeline.last'), strip.updatedAt, now)}`]
  if (jobs.length > 0) parts.push(t('timeline.jobCount', { n: jobs.length }))
  return t('timeline.headline', { parts: parts.join(t('sep.comma')) })
}

export function Timeline({ strip, now, windowMs }: { strip: AgentStrip; now: number; windowMs: number }) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const start = now - windowMs
  const jobs = strip.jobs.filter((job) => (job.endedAt ?? now) >= start)
  if (strip.segments.length === 0 && jobs.length === 0) return null
  // The axis marks whole hours, with "now" at the far right
  const ticks: number[] = []
  for (let t = Math.ceil(start / HOUR) * HOUR; t < now - HOUR / 6; t += HOUR) ticks.push(t)
  return (
    <details className="timeline">
      <summary>{headline(strip, jobs, now, i18n)}</summary>
      <div className="timeline-body">
        <div className="timeline-axis" aria-hidden="true">
          {ticks.map((tick) => <span key={tick} style={{ left: `${position(tick, start, windowMs)}%` }}>{fmt.clock(tick)}</span>)}
          <span className="timeline-now">{t('timeline.now')}</span>
        </div>
        <div className="timeline-lane">
          <span className="timeline-label">{t('timeline.chat')}</span>
          <span className="timeline-track">
            {strip.segments.map((s) => (
              <Bar key={`${s.from}-${s.state}`} from={s.from} to={s.to} start={start} windowMs={windowMs} className={`timeline-bar timeline-bar--${s.state}`}
                title={`${fmt.clock(s.from)}–${fmt.clock(s.to)} ${s.state === 'idle' ? '' : t(SEGMENT_KEYS[s.state])}`} />
            ))}
          </span>
        </div>
        {jobs.map((job) => (
          <div className="timeline-lane" key={job.id}>
            <span className="timeline-label" title={`${job.name}\n${job.description}`}>{job.name}</span>
            <span className="timeline-track">
              <Bar from={job.startedAt} to={job.endedAt ?? now} start={start} windowMs={windowMs} className={`timeline-bar timeline-bar--job-${job.status}`}
                title={t(JOB_BAR_KEYS[job.status], { start: fmt.clock(job.startedAt), end: job.endedAt === null ? '' : fmt.clock(job.endedAt) })} />
            </span>
          </div>
        ))}
        <p className="timeline-legend">
          <span><i className="swatch timeline-bar--working" />{t('timeline.working')}</span>
          {strip.segments.some((s) => s.state === 'needs') && <span><i className="swatch timeline-bar--needs" />{t('timeline.needs')}</span>}
          {/* Job colors are listed by the statuses actually present, so the legend matches the chart */}
          {(['running', 'completed', 'failed', 'stopped'] as const).filter((status) => jobs.some((job) => job.status === status)).map((status) => (
            <span key={status}><i className={`swatch timeline-bar--job-${status}`} />{t(JOB_LEGEND_KEYS[status])}</span>
          ))}
          <span>{t('timeline.blank')}</span>
        </p>
      </div>
    </details>
  )
}
