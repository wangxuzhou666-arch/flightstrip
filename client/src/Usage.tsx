// The right block of the readings band: the subscription limit. This week's use is the big number; the 5-hour window
// sits to its right when there is a reading, so it doesn't make the whole band taller
import type { UsageReading, UsageWindow } from '../../shared/types.ts'
import { type I18n, useI18n } from './i18n.tsx'
import { Meter } from './SessionCard.tsx'
import { USAGE_STALE_MS } from '../../shared/defaults.ts'

/** Within a week the weekday, further out the date, then the time */
function resetLabel(resetsAt: number | null, now: number, { t, fmt }: Pick<I18n, 't' | 'fmt'>): string | null {
  if (resetsAt === null) return null
  return t('usage.resets', { when: `${fmt.dayLabel(resetsAt, now)} ${fmt.clock(resetsAt)}` })
}

export type Level = 'ok' | 'warn' | 'high'

/** Amber from 70%, red from 90%: color only signals that you should take a look */
export function level(percent: number): Level {
  if (percent >= 90) return 'high'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** A window past its reset time with no new data yet: the old percent is not shown */
function current(window: UsageWindow, now: number): number | null {
  return window.resetsAt !== null && window.resetsAt < now ? null : window.percent
}

export function Usage({ usage, now }: { usage: UsageReading | null; now: number }) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  if (usage === null) {
    return (
      <section className="panel week" aria-label={t('usage.label')}>
        <h2 className="panel-title">{t('usage.week')}</h2>
        <p className="week-note">{t('usage.missing')}</p>
      </section>
    )
  }
  const week = current(usage.week, now)
  const fiveHour = current(usage.fiveHour, now)
  // The dashboard has Claude Code pull usage on a timer; two pulls missed means refreshing is broken (or held while
  // memory is tight), so the time of the data is shown (this also keeps a stale number from passing as current)
  const stale = now - usage.at > USAGE_STALE_MS
  return (
    <section className="panel week" aria-label={t('usage.label')} title={t('usage.hint')}>
      <h2 className="panel-title">{t('usage.week')}</h2>
      <div className="week-top">
        <b className="week-value">{week === null ? '—' : <>{week}<small>%</small></>}</b>
        {fiveHour !== null && (
          <span className="week-five" data-level={level(fiveHour) === 'ok' ? undefined : level(fiveHour)}>
            <i>{t('usage.fiveHour')}</i><b>{fiveHour}<small>%</small></b>
          </span>
        )}
      </div>
      {week !== null && <Meter fraction={week / 100} level={level(week)} />}
      <p className="week-note" data-stale={stale || undefined}>
        {stale ? t('usage.stale', { when: fmt.dateTime(usage.at) }) : week === null ? t('usage.expired') : resetLabel(usage.week.resetsAt, now, i18n)}
      </p>
    </section>
  )
}
