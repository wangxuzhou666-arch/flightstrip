import type { UsageReading, UsageWindow } from '../../shared/types.ts'
import { type I18n, useI18n } from './i18n.tsx'

/** Within a week the weekday, further out the date, then the time */
function resetLabel(resetsAt: number | null, now: number, { t, fmt }: Pick<I18n, 't' | 'fmt'>): string | null {
  if (resetsAt === null) return null
  return t('usage.resets', { when: `${fmt.dayLabel(resetsAt, now)} ${fmt.clock(resetsAt)}` })
}

export type Level = 'ok' | 'warn' | 'high'

/** Amber from 70%, red from 90%: as on the strips, color only signals that you should take a look */
export function level(percent: number): Level {
  if (percent >= 90) return 'high'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** One meter of the header: label, bar, percent, and a short note after it. Shared with the machine meters */
export function MeterRow({ label, percent, tone, note, title }: {
  label: string
  percent: number | null
  /** The bar's color; by default it follows the percent */
  tone?: Level
  note: string | null
  title?: string
}) {
  return (
    <div className="usage-row" title={title}>
      <span className="usage-label">{label}</span>
      <span className="usage-track" aria-hidden="true">
        {percent !== null && <span className={`usage-fill usage-fill--${tone ?? level(percent)}`} style={{ width: `${Math.min(100, percent)}%` }} />}
      </span>
      <span className="usage-value">{percent === null ? '—' : `${Math.round(percent)}%`}</span>
      <span className="usage-note">{note}</span>
    </div>
  )
}

function Meter({ label, window, now }: { label: string; window: UsageWindow; now: number }) {
  const i18n = useI18n()
  const expired = window.resetsAt !== null && window.resetsAt < now
  return (
    <MeterRow label={label} percent={expired ? null : window.percent}
      note={expired ? i18n.t('usage.expired') : resetLabel(window.resetsAt, now, i18n)} />
  )
}

export function Usage({ usage, now }: { usage: UsageReading | null; now: number }) {
  const { t, fmt } = useI18n()
  if (usage === null) {
    return <p className="usage-missing">{t('usage.missing')}</p>
  }
  // The cache source only updates when a session starts, so mark when the data is from, lest a stale number pass as current.
  // The dashboard has Claude Code pull usage every 2 minutes; no update for 10 minutes means refreshing is broken,
  // so the time of the data is shown
  const stale = now - usage.at > 10 * 60_000
  return (
    <div className="usage" aria-label={t('usage.label')} title={t('usage.hint')}>
      <Meter label={t('usage.week')} window={usage.week} now={now} />
      {usage.fiveHour.percent !== null && <Meter label={t('usage.fiveHour')} window={usage.fiveHour} now={now} />}
      {stale && <p className="usage-stale">{t('usage.stale', { when: fmt.dateTime(usage.at) })}</p>}
    </div>
  )
}
