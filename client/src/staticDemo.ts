// The board of the static build (`vite build --mode pages`, hosted on GitHub Pages): the same fictional sessions as
// `flightstrip --demo`, assembled in the browser. There is no server and no request: every write is applied here, in
// memory, and is gone on reload.
// What the board shows comes from shared/ (fixtures in demo.ts, ordering and retire in board.ts, group rules in
// groupBook.ts), the same code `--demo` runs. This file is only what server/index.ts and actions.ts are for the real
// thing: hold the state, apply a write, push the next snapshot.
import { ActionError, cleanSessionName } from '../../shared/actionError.ts'
import { arrange, demoBoardStrips, isRunning } from '../../shared/board.ts'
import { DEFAULT_CONTEXT_LINE, WINDOW_MS } from '../../shared/defaults.ts'
import { actOnDemoHog, DEMO_GROUPS, demoHogs, demoMachine, demoUsage, renameDemoSession, stopDemoSession } from '../../shared/demo.ts'
import { GroupBook } from '../../shared/groupBook.ts'
import { type Lang, langFromLocale, t, type Translate } from '../../shared/i18n/index.ts'
import type { AgentStrip, Snapshot } from '../../shared/types.ts'
import type { GroupOp, SessionAction } from './api.ts'

// The same pace as the server's fallback polling, so the clocks on the strips tick the way they do in `--demo`
const REFRESH_MS = 3000

let lang: Lang = langFromLocale(navigator.language)
/** Follows the language of the moment, like the server's serverT */
const pageT: Translate = (key, ...params) => t(lang, key, ...params)

const groups = new GroupBook(pageT)
groups.state = structuredClone(DEMO_GROUPS)
const retired = new Map<string, number>()
/** Every strip of the latest board, retired ones included: a write looks its strip up here */
let allStrips: AgentStrip[] = []
const listeners = new Set<(snapshot: Snapshot) => void>()
let timer: ReturnType<typeof setInterval> | null = null

function collect(): Snapshot {
  const now = Date.now()
  allStrips = demoBoardStrips(now, pageT, (sessionId) => groups.groupOf(sessionId))
  const { shown, retiredRows, revived } = arrange(allStrips, retired)
  // A retired strip that is running or waiting again comes back to the board, as on the server
  for (const sessionId of revived) retired.delete(sessionId)
  const snapshot: Snapshot = {
    takenAt: now, lang, windowMs: WINDOW_MS, strips: shown, retired: retiredRows, groups: groups.groups, ungroupedAt: groups.ungroupedAt,
    usage: demoUsage(now), machine: demoMachine(now), hogs: demoHogs(now, pageT), briefsHeld: false, error: null, briefsEnabled: true,
    contextLine: DEFAULT_CONTEXT_LINE,
  }
  // Through JSON like the SSE stream does: the page gets copies it can keep (groups are edited in place), and fields the wire would drop are dropped here too
  return JSON.parse(JSON.stringify(snapshot)) as Snapshot
}

function publish(): void {
  const snapshot = collect()
  for (const listener of listeners) listener(snapshot)
}

/** The first snapshot arrives at once, then a new one every few seconds and after every write; returns the way to stop */
export function subscribe(listener: (snapshot: Snapshot) => void): () => void {
  listeners.add(listener)
  listener(collect())
  timer ??= setInterval(publish, REFRESH_MS)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function stripOf(sessionId: string): AgentStrip {
  const strip = allStrips.find((candidate) => candidate.sessionId === sessionId)
  if (strip === undefined) throw new ActionError(404, pageT('error.sessionGone'))
  return strip
}

/** retire / unretire / rename / group on one session; throws what the server would answer with */
export function applyAction(sessionId: string, action: SessionAction, body: Record<string, unknown>): void {
  if (action === 'unretire') {
    retired.delete(sessionId)
  } else {
    const strip = stripOf(sessionId)
    if (action === 'retire') {
      // As in server/actions.ts: a running background session is stopped first (the demo's stand-in for `claude stop`), so retiring it sticks
      if (strip.kind === 'background' && isRunning(strip)) stopDemoSession(sessionId, Date.now())
      retired.set(sessionId, Date.now())
    } else if (action === 'group') {
      groups.assign(sessionId, body.groupId ?? null)
    } else {
      renameDemoSession(sessionId, cleanSessionName(String(body.name ?? ''), pageT))
    }
  }
  publish()
}

export function applyGroupOp(op: GroupOp, body: Record<string, unknown>): void {
  if (op === 'create') {
    // "New group…" on a card sends its sessionId: move that session in right away
    const sessionId = typeof body.sessionId === 'string' && allStrips.some((strip) => strip.sessionId === body.sessionId) ? body.sessionId : null
    groups.create(body.name, sessionId)
  } else if (op === 'rename') {
    groups.rename(body.id, body.name)
  } else if (op === 'delete') {
    groups.remove(body.id)
  } else {
    groups.move(body.id, body.before ?? null)
  }
  publish()
}

/** end / pause / resume on a row of the memory ranking; only the in-memory demo ranking changes */
export function applyHogAction(key: string, action: 'end' | 'pause' | 'resume'): void {
  actOnDemoHog(key, action, Date.now(), pageT)
  publish()
}

export function applyLang(next: Lang): void {
  lang = next
  publish()
}
