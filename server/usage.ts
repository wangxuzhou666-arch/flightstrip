// Subscription usage (weekly / 5-hour windows), from two sources:
// - cachedUsageUtilization in Claude Code's global config, ~/.claude.json: usageRefresh.ts has `claude -p /usage` refresh it
//   every 10 minutes, and fetchedAtMs is when it was really pulled. When every session runs in VS Code this is the only
//   source that moves (VS Code doesn't run the statusline command).
// - The per-session reports scripts/statusline.mjs writes from a terminal session's rate_limits into <state dir>/usage/:
//   near real time, but an idle session's report stays at its old number.
// Merging: only windows whose reset time hasn't passed count; within one window usage never goes down, so the maximum
// wins and an old report can't hide a newer one.
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageReading, UsageWindow } from '../shared/types.ts'
import { parseJsonLine } from './agents.ts'
import { config } from './config.ts'

const LIVE_DIR = join(config.stateDir, 'usage')
const CLAUDE_JSON = config.claudeJson

type LiveWindow = { used_percentage?: number; resets_at?: string | number }

function toTime(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null
  // resets_at can be an ISO string or a timestamp in seconds
  const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  return Number.isNaN(time) ? null : time
}

function liveWindow(window: LiveWindow | undefined): UsageWindow {
  return { percent: typeof window?.used_percentage === 'number' ? window.used_percentage : null, resetsAt: toTime(window?.resets_at) }
}

async function readReport(path: string): Promise<UsageReading | null> {
  const parsed = parseJsonLine(await readFile(path, 'utf8'))
  if (parsed === null || typeof parsed.at !== 'number') return null
  const limits = parsed.rateLimits as { seven_day?: LiveWindow; five_hour?: LiveWindow } | undefined
  return { source: 'statusline', at: parsed.at, week: liveWindow(limits?.seven_day), fiveHour: liveWindow(limits?.five_hour) }
}

// Sources don't report one window's reset time identically: the statusline gives whole seconds, the /usage cache
// milliseconds. Measured 2026-11-11, one week's two reset times were 0.23 s apart; grouping by exact equality made an
// old 5% statusline report its own "latest week" and hid the cache's 68% from that day. Two consecutive windows reset
// at least 5 hours apart, so reset times within an hour are the same window
const SAME_WINDOW_MS = 60 * 60_000

/** The current window's usage: a report past its reset time describes the previous window and doesn't count; of the
 *  rest, the window that resets last, and the maximum within it. Everything past its reset time = reset, no new
 *  report yet: empty */
export function freshest(window: (r: UsageReading) => UsageWindow, reports: UsageReading[], now = Date.now()): UsageWindow {
  const known = reports.map(window).filter((w) => w.percent !== null && (w.resetsAt === null || w.resetsAt > now))
  const latestReset = Math.max(...known.map((w) => w.resetsAt ?? 0))
  const current = known.filter((w) => latestReset - (w.resetsAt ?? 0) < SAME_WINDOW_MS)
  if (current.length === 0) return { percent: null, resetsAt: null }
  return { percent: Math.max(...current.map((w) => w.percent as number)), resetsAt: latestReset || null }
}

async function readLive(): Promise<UsageReading | null> {
  const paths = existsSync(LIVE_DIR) ? (await readdir(LIVE_DIR)).filter((f) => f.endsWith('.json')).map((f) => join(LIVE_DIR, f)) : []
  const reports = (await Promise.all(paths.map(readReport))).filter((r): r is UsageReading => r !== null)
  if (reports.length === 0) return null
  return {
    source: 'statusline',
    at: Math.max(...reports.map((r) => r.at)),
    week: freshest((r) => r.week, reports),
    fiveHour: freshest((r) => r.fiveHour, reports),
  }
}

// ~/.claude.json is hundreds of KB; don't re-read it while unchanged
let cacheMemo: { mtimeMs: number; reading: UsageReading | null } | null = null

type CachedWindow = { utilization?: number; resets_at?: string } | null

async function readCached(): Promise<UsageReading | null> {
  if (!existsSync(CLAUDE_JSON)) return null
  const { mtimeMs } = await stat(CLAUDE_JSON)
  if (cacheMemo?.mtimeMs === mtimeMs) return cacheMemo.reading
  const parsed = parseJsonLine(await readFile(CLAUDE_JSON, 'utf8'))
  const cached = parsed?.cachedUsageUtilization as { fetchedAtMs?: number; utilization?: { seven_day?: CachedWindow; five_hour?: CachedWindow } } | undefined
  const toWindow = (w: CachedWindow | undefined): UsageWindow => ({ percent: w?.utilization ?? null, resetsAt: toTime(w?.resets_at) })
  const reading: UsageReading | null = cached?.fetchedAtMs === undefined ? null : {
    source: 'cache', at: cached.fetchedAtMs, week: toWindow(cached.utilization?.seven_day), fiveHour: toWindow(cached.utilization?.five_hour),
  }
  cacheMemo = { mtimeMs, reading }
  return reading
}

/** Both sources are merged with "same window, take the maximum" */
export async function readUsage(): Promise<UsageReading | null> {
  const [live, cached] = await Promise.all([readLive(), readCached()])
  const reports = [live, cached].filter((r): r is UsageReading => r !== null)
  if (reports.length === 0) return null
  return {
    // Where the latest report came from
    source: reports.reduce((a, b) => (b.at > a.at ? b : a)).source,
    at: Math.max(...reports.map((r) => r.at)),
    week: freshest((r) => r.week, reports),
    fiveHour: freshest((r) => r.fiveHour, reports),
  }
}
