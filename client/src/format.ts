import type { Lang, Translate } from '../../shared/i18n/index.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Clocks are 24-hour in both languages (the timeline axis marks whole hours); en-GB gives "14:05" where en-US would give "2:05 PM"
const TIME_LOCALE: Record<Lang, string> = { en: 'en-GB', zh: 'zh-CN' }
const DATE_LOCALE: Record<Lang, string> = { en: 'en-US', zh: 'zh-CN' }
const MONTH_STYLE: Record<Lang, 'short' | 'numeric'> = { en: 'short', zh: 'numeric' }
const WEEK_MS = 7 * DAY

export interface Format {
  /** "3 min ago"; empty for a missing time */
  ago: (at: number | null, now: number) => string
  /** How long something lasted ("1 h 5 min"); exact to the minute within the first hour */
  span: (from: number, now: number) => string
  /** Joins a prefix to an ago-text ("last 3 min ago"). In Chinese a digit-first text needs a space after the prefix and a word ("刚刚") doesn't */
  joinAgo: (prefix: string, at: number | null, now: number) => string
  clock: (at: number) => string
  clockWithSeconds: (at: number) => string
  /** The weekday within the next week, the date further out */
  dayLabel: (at: number, now: number) => string
  /** Date and time of day, for "data from …" */
  dateTime: (at: number) => string
}

export function makeFormat(lang: Lang, t: Translate): Format {
  const ago: Format['ago'] = (at, now) => {
    if (at === null) return ''
    const gap = Math.max(0, now - at)
    if (gap < MINUTE) return t('time.justNow')
    if (gap < HOUR) return t('time.minutesAgo', { n: Math.floor(gap / MINUTE) })
    if (gap < DAY) return t('time.hoursAgo', { n: Math.floor(gap / HOUR) })
    return t('time.daysAgo', { n: Math.floor(gap / DAY) })
  }

  const span: Format['span'] = (from, now) => {
    const gap = Math.max(0, now - from)
    if (gap < MINUTE) return t('time.lessThanMinute')
    if (gap < HOUR) return t('time.minutes', { n: Math.floor(gap / MINUTE) })
    if (gap < DAY) {
      const hours = Math.floor(gap / HOUR)
      const minutes = Math.floor((gap % HOUR) / MINUTE)
      return minutes === 0 ? t('time.hours', { n: hours }) : t('time.hoursMinutes', { hours, minutes })
    }
    return t('time.days', { n: Math.floor(gap / DAY) })
  }

  const joinAgo: Format['joinAgo'] = (prefix, at, now) => {
    const text = ago(at, now)
    if (text === '') return prefix
    return lang === 'en' || /^\d/.test(text) ? `${prefix} ${text}` : `${prefix}${text}`
  }

  return {
    ago,
    span,
    joinAgo,
    clock: (at) => new Date(at).toLocaleTimeString(TIME_LOCALE[lang], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    clockWithSeconds: (at) => new Date(at).toLocaleTimeString(TIME_LOCALE[lang], { hourCycle: 'h23' }),
    dayLabel: (at, now) => at - now < WEEK_MS
      ? new Date(at).toLocaleDateString(DATE_LOCALE[lang], { weekday: 'short' })
      : new Date(at).toLocaleDateString(DATE_LOCALE[lang], { month: MONTH_STYLE[lang], day: 'numeric' }),
    dateTime: (at) => new Date(at).toLocaleString(DATE_LOCALE[lang], {
      month: MONTH_STYLE[lang], day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }),
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** "2.1 GB", "512 MB": one decimal below 10, whole numbers above. Memory counts in 1024s (16 GB of RAM is 16 GiB, as
 *  Activity Monitor shows it), disks in 1000s (as Finder and df -H do) */
export function formatBytes(bytes: number, base: 1000 | 1024): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= base && unit < UNITS.length - 1) {
    value /= base
    unit++
  }
  const shown = value < 10 && unit > 0 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return `${shown} ${UNITS[unit]}`
}
