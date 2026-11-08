// How strips become a board: the labels shown on a card, the order of the bays and the retired fold. server/collect.ts
// uses it for real sessions and for `--demo`; the static demo build (client/src/staticDemo.ts) uses the same code,
// so both show a demo the same way. Nothing here reads files, so the browser can import it.
import type { MessageKey, Translate } from './i18n/index.ts'
import { type DemoStrip, demoStrips } from './demo.ts'
import type { AgentStrip, Bay, RetiredRow } from './types.ts'

// What `claude agents` says a session waits on → the dictionary key of its wording; unknown values are shown as they are
const WAITING_KEYS = {
  'permission prompt': 'waiting.permission',
  'input needed': 'waiting.input',
  'sandbox request': 'waiting.sandbox',
  'worker request': 'waiting.worker',
  'dialog open': 'waiting.dialog',
} as const satisfies Record<string, MessageKey>

const SURFACE_KEYS = {
  'claude-vscode': 'surface.vscode',
  cli: 'surface.cli',
  'claude-desktop': 'surface.desktop',
} as const satisfies Record<string, MessageKey>

/** Own keys only: a value like "constructor" from a session file must not resolve to something on Object.prototype */
function lookup<T extends Record<string, MessageKey>>(table: T, name: string): T[keyof T] | undefined {
  return Object.hasOwn(table, name) ? table[name as keyof T] : undefined
}

/** Where a session runs, as shown on the card; entrypoint null = background session */
export function surfaceOf(entrypoint: string | null, t: Translate): string {
  if (entrypoint === null) return t('surface.background')
  const key = lookup(SURFACE_KEYS, entrypoint)
  return key === undefined ? entrypoint || t('surface.interactive') : t(key)
}

/** "Waiting for your answer: <the question>" */
export function needsLine(waitingFor: string | undefined, ask: string, t: Translate): string {
  const key = waitingFor ? lookup(WAITING_KEYS, waitingFor) : undefined
  const waiting = key === undefined ? waitingFor || null : t(key)
  return [waiting, ask].filter(Boolean).join(t('sep.colon')) || t('now.waiting')
}

export const BAY_ORDER: Bay[] = ['needs', 'working', 'done', 'idle']

/** Order inside a bay must be stable: running and waiting strips sort by start time, not by latest activity,
 *  otherwise they'd swap places on every output. Finished and idle ones sort by latest activity: just-finished on top */
function orderInBay(strip: AgentStrip): number {
  return strip.bay === 'done' || strip.bay === 'idle' ? strip.updatedAt ?? 0 : strip.startedAt ?? 0
}

/** A retired strip is hidden only while idle or finished; one that moved again must not stay hidden, or a waiting-for-you strip would be missed */
function isActive(strip: AgentStrip): boolean {
  return strip.bay === 'needs' || strip.bay === 'working'
}

/** Running or waiting for you; retiring a background session in this state has to stop it first */
export function isRunning(strip: AgentStrip): boolean {
  return strip.stateKind === 'working' || strip.stateKind === 'needs'
}

export interface Arranged {
  /** The strips on display, in board order */
  shown: AgentStrip[]
  retiredRows: RetiredRow[]
  /** Retired strips that became running or waiting again: the caller restores them to the board */
  revived: string[]
}

/** Puts `allStrips` in board order (in place) and splits off the retired ones */
export function arrange(allStrips: AgentStrip[], retired: ReadonlyMap<string, number>): Arranged {
  allStrips.sort((a, b) => BAY_ORDER.indexOf(a.bay) - BAY_ORDER.indexOf(b.bay) || orderInBay(b) - orderInBay(a))
  const hidden = (strip: AgentStrip) => retired.has(strip.sessionId) && !isActive(strip)
  const retiredRows: RetiredRow[] = allStrips.filter(hidden).map((strip) => ({
    sessionId: strip.sessionId, name: strip.name, kind: strip.kind, retiredAt: retired.get(strip.sessionId) as number,
  }))
  const shown = allStrips.filter((strip) => !hidden(strip))
  const revived = allStrips.filter((strip) => retired.has(strip.sessionId) && isActive(strip)).map((strip) => strip.sessionId)
  return { shown, retiredRows, revived }
}

/** The fixture strips as the board shows them: surface label, waiting-for-you line and group id added the way real sessions get them */
export function demoBoardStrips(now: number, t: Translate, groupOf: (sessionId: string) => string | null): AgentStrip[] {
  return demoStrips(now, t).map(({ entrypoint, waitingFor, ...strip }: DemoStrip): AgentStrip => ({
    ...strip,
    surface: surfaceOf(entrypoint, t),
    now: waitingFor === undefined ? strip.now : needsLine(waitingFor, strip.now, t),
    groupId: groupOf(strip.sessionId),
  }))
}
