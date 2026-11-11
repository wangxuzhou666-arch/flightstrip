// Merges the data sources into one snapshot: one strip per session.
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { arrange, BAY_ORDER, demoBoardStrips, needsLine, surfaceOf } from '../shared/board.ts'
import { WINDOW_MS } from '../shared/defaults.ts'
import { demoMachine, demoUsage } from '../shared/demo.ts'
import type { AgentStrip, BackgroundJob, Bay, MachineReading, Segment, Snapshot, StateKind, TimelineEvent, TodoItem, UsageReading } from '../shared/types.ts'
import { type AgentListing, type JobTimelineEntry, listAgents, readInteractiveSession, readJobState, readJobTimeline } from './agents.ts'
import { type BriefJob, briefOf, jobNameOf, type RecentLine, requestBrief } from './brief.ts'
import { config } from './config.ts'
import { groupOf, listGroups, ungroupedAt } from './groups.ts'
import { currentLang, serverT } from './lang.ts'
import { jobsOf, pagesOf } from './jobs.ts'
import { cachedPr, projectOf } from './repo.ts'
import { sampleResources } from './resources.ts'
import { readSessionTodos, type SessionTodos } from './sessionTodos.ts'
import { describeAction, digestTranscript, readSubagents, type TranscriptDigest } from './transcript.ts'
import { readUsage } from './usage.ts'

// Two agent outputs closer together than this count as one continuous stretch of work
const ACTIVITY_GAP_MS = 2 * 60 * 1000
const TEXT_LIMIT = 280

// State comes only from official sources. Measured 2026-11-07: with AskUserQuestion pending in VSCode, status = waiting
// and waitingFor = input needed, so there is no need to infer it from the transcript
// (inference also misreports when a tool is interrupted and never gets a tool_result)
function stateKindOf(listing: AgentListing, jobState: string | null): StateKind {
  const state = listing.state ?? jobState
  if (state === 'failed') return 'failed'
  if (state === 'blocked' || listing.status === 'waiting') return 'needs'
  if (state === 'working' || listing.status === 'busy') return 'working'
  if (state === 'done') return 'done'
  return 'idle'
}

// Bay rules:
// - a failed background job that ended after the chat's last activity has no one handling it yet: counts as needs-you
// - chat stopped but a background job is still running: the work isn't finished, counts as in progress
// - Claude Code marks an interactive session idle after every turn. Activity within the timeline window counts as
//   just finished; only silence beyond the window counts as idle
function bayOf(kind: StateKind, updatedAt: number | null, now: number, jobs: BackgroundJob[]): Bay {
  if (kind === 'failed' || kind === 'needs') return 'needs'
  const unhandledFailure = jobs.some((job) => job.status === 'failed' && job.endedAt !== null && (updatedAt === null || job.endedAt > updatedAt))
  if (unhandledFailure) return 'needs'
  if (kind === 'working' || jobs.some((job) => job.status === 'running')) return 'working'
  if (kind === 'done' || (updatedAt !== null && now - updatedAt <= WINDOW_MS)) return 'done'
  return 'idle'
}

function jobStateKind(state: string): StateKind {
  if (state === 'blocked') return 'needs'
  if (state === 'working' || state === 'failed' || state === 'done') return state
  return 'idle'
}

/** Flattens to one line of plain text: strips markdown markers and extra whitespace */
function oneLine(text: string | null | undefined): string {
  if (!text) return ''
  const flat = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*`#>|]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT)}…` : flat
}

/**
 * State history of a background session: each timeline entry lasts until the next one. When the last entry disagrees
 * with the current state (the agents listing is authoritative), history stops at the last entry and the current state
 * is drawn after it.
 * Measured 2026-11-07: a restarted session's timeline still ended at yesterday's "blocked"; extending it as-is drew a
 * whole day of "waiting for you"
 */
function jobRuns(entries: JobTimelineEntry[], current: StateKind, startedAt: number | null, now: number): Segment[] {
  const runs: Segment[] = entries.map((entry, i) => ({ from: entry.at, to: entries[i + 1]?.at ?? now, state: jobStateKind(entry.state) }))
  const last = runs.at(-1)
  if (last === undefined) return [{ from: startedAt ?? now, to: now, state: current }]
  if (startedAt !== null && startedAt > last.from) {
    last.to = startedAt
    runs.push({ from: startedAt, to: now, state: current })
  } else if (last.state !== current) {
    last.to = last.from
    runs.push({ from: last.from, to: now, state: current })
  }
  return runs
}

/** Interactive sessions have no state history: agent outputs no more than ACTIVITY_GAP_MS apart merge into one "working" stretch, then the current state is appended */
function activityRuns(digest: TranscriptDigest, current: StateKind, currentSince: number | null, now: number): Segment[] {
  const runs: Segment[] = []
  for (const t of [...digest.activityTimes].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last !== undefined && t - last.to <= ACTIVITY_GAP_MS) {
      last.to = t
    } else {
      runs.push({ from: t, to: t + 20_000, state: 'working' })
    }
  }
  const last = runs.at(-1)
  if (current === 'working' && last !== undefined && now - last.to <= ACTIVITY_GAP_MS) {
    last.to = now
  } else if (current === 'working' || current === 'needs') {
    runs.push({ from: currentSince ?? last?.to ?? now, to: now, state: current })
  }
  return runs
}

/** How long the current state has held: walk back from the end over stretches with the same state */
function stateSinceOf(runs: Segment[], current: StateKind): number | null {
  let since: number | null = null
  for (let i = runs.length - 1; i >= 0 && runs[i].state === current; i--) since = runs[i].from
  return since
}

/** Segments drawn on the band: idle is skipped; "done" is a moment, drawn as a thin tick; clipped to the window */
function bandSegments(runs: Segment[], start: number): Segment[] {
  const shown: Segment[] = []
  for (const run of runs) {
    const to = run.state === 'done' ? run.from : run.to
    if (run.state === 'idle' || to < start) continue
    shown.push({ from: Math.max(run.from, start), to, state: run.state })
  }
  return shown
}

function nowLine(kind: StateKind, listing: AgentListing, jobDetail: string | null, jobNeeds: string | null, digest: TranscriptDigest | null): string {
  if (kind === 'needs') return needsLine(listing.waitingFor, oneLine(jobNeeds ?? digest?.lastAgentText ?? jobDetail), serverT)
  if (kind === 'working') {
    const lastAction = digest?.lastAction ? describeAction(digest.lastAction, serverT) : null
    return oneLine(jobDetail ?? lastAction ?? digest?.lastAgentText) || serverT('now.working')
  }
  return oneLine(jobDetail ?? digest?.lastAgentText ?? digest?.lastPrompt) || serverT('now.none')
}

const SHOWN_WORKTREES = 4
// Each transcript entry handed to Haiku for the progress note is cut to this length:
// enough to see what's going on, without sending long replies whole
const RECENT_LIMIT = 500

function clip(text: string, limit: number): string {
  const flat = oneLine(text)
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** Background sessions open with the dispatch instructions; interactive sessions with the first few things you said */
function openingOf(intent: string | null, digest: TranscriptDigest | null): string[] {
  const prompts = digest?.openingPrompts ?? []
  return intent === null ? prompts : [intent, ...prompts.filter((p) => p !== intent)].slice(0, 3)
}

// Paths mentioned in commands can be plain files (measured 2026-11-07: a stray .log file was taken for a worktree):
// for existing paths check that it is a directory, for deleted ones go by the extension
const FILE_SUFFIX = /\.(log|txt|json|jsonl|md|out|err|png|jpe?g|csv|html|sh|py|ts)$/i
function looksLikeFile(path: string): boolean {
  try {
    return !statSync(path).isDirectory()
  } catch {
    return FILE_SUFFIX.test(path)
  }
}

type PlanFields = 'goal' | 'todos' | 'todoSource' | 'todosDoneEarlier' | 'progress' | 'progressAt' | 'worktrees'

/** The strip's todos, latest progress and attached worktrees. A todo list the session wrote itself wins; Haiku's extraction is used only when there is none */
function planOf(opening: string[], digest: TranscriptDigest | null, sessionId: string, manual: SessionTodos | null): Pick<AgentStrip, PlanFields> {
  const brief = briefOf(sessionId)
  const todos = manual?.items ?? brief.todos
  const worktrees = Object.entries(digest?.worktrees ?? {})
    .filter(([path]) => !looksLikeFile(path))
    .sort(([, a], [, b]) => b - a)
    .slice(0, SHOWN_WORKTREES)
    .map(([path, lastAt]) => ({ path, name: basename(path), lastAt, exists: existsSync(path) }))
  return {
    goal: opening.length === 0 ? null : clip(opening[0], TEXT_LIMIT),
    todos,
    todoSource: todos === null ? null : manual !== null ? 'session' : 'haiku',
    todosDoneEarlier: manual === null ? 0 : manual.doneEarlier,
    progress: brief.progress,
    progressAt: brief.progressAt,
    worktrees,
  }
}

/** Raw material for brief.ts; nothing is actually called when the content hasn't changed */
function briefJobOf(strip: AgentStrip, opening: string[], manual: TodoItem[] | null): BriefJob {
  // events are newest first; Haiku reads in chronological order
  const recent: RecentLine[] = [...strip.events].reverse()
    .filter((event) => event.text)
    .map((event) => ({ role: event.actor, text: clip(event.text, RECENT_LIMIT) }))
  if (recent.length > 0) recent.push({ role: 'now', text: strip.now })
  return {
    sessionId: strip.sessionId,
    opening,
    manual,
    recent,
    activityKey: `${strip.updatedAt ?? 0}:${strip.stateKind}`,
    settled: strip.stateKind !== 'working',
    priority: BAY_ORDER.indexOf(strip.bay),
  }
}

interface Built {
  strip: AgentStrip
  opening: string[]
  manual: SessionTodos | null
  /** id → output file of the jobs still running, for finding their processes */
  outputs: Map<string, string>
}

async function buildStrip(listing: AgentListing, now: number): Promise<Built> {
  const start = now - WINDOW_MS
  const background = listing.kind === 'background'
  const [job, timeline, session, digest, manual] = await Promise.all([
    background ? readJobState(listing.sessionId) : null,
    background ? readJobTimeline(listing.sessionId) : [],
    background ? null : readInteractiveSession(listing.pid),
    digestTranscript(listing.sessionId),
    readSessionTodos(OWN_CWD, listing.sessionId),
  ])
  const kind = stateKindOf(listing, job?.state ?? null)
  const nameSource = job?.nameSource ?? session?.nameSource ?? null
  // The newest custom-title in the transcript wins (renaming from the dashboard writes it there; the process's
  // in-memory listing.name doesn't follow), then the name you gave it. Auto names (username plus a hex suffix)
  // are replaced by the title VSCode's sidebar shows
  const name = digest?.customTitle ?? (nameSource === 'user' ? listing.name : digest?.aiTitle ?? listing.name)

  const events: TimelineEvent[] = background
    ? timeline.slice(-10).map((e) => ({ at: e.at, actor: 'agent', state: jobStateKind(e.state), text: oneLine(e.detail) }))
    : (digest?.recentTurns ?? []).map((t) => ({ at: t.at, actor: t.actor, state: null, text: oneLine(t.text) }))

  const startedAt = listing.startedAt === undefined ? null : Number(listing.startedAt)
  // Start of an interactive session's current state: when status really is waiting/busy use the moment it changed;
  // with AskUserQuestion pending, status is still busy, so use the moment of the agent's last output
  const currentSince = kind === 'needs' && listing.status !== 'waiting'
    ? digest?.activityTimes.at(-1) ?? null
    : session?.statusUpdatedAt ?? null
  const runs = background
    ? jobRuns(timeline, kind, startedAt, now)
    : digest === null ? [] : activityRuns(digest, kind, currentSince, now)

  const lastSeen = Math.max(timeline.at(-1)?.at ?? 0, digest?.activityTimes.at(-1) ?? 0, session?.statusUpdatedAt ?? 0)
  const subagents = digest === null ? [] : await readSubagents(digest.path, start)
  const [jobs, pages] = digest === null ? [[], []] : await Promise.all([jobsOf(digest.jobs, jobNameOf), pagesOf(digest.pages, OWN_PORT, now)])
  const branch = digest?.branch ?? null
  const opening = openingOf(job?.intent ?? null, digest)

  const strip: AgentStrip = {
    sessionId: listing.sessionId,
    shortId: listing.id,
    kind: listing.kind,
    surface: surfaceOf(background ? null : session?.entrypoint ?? '', serverT),
    name,
    project: await projectOf(listing.cwd),
    cwd: listing.cwd,
    branch,
    bay: bayOf(kind, lastSeen || null, now, jobs),
    stateKind: kind,
    now: nowLine(kind, listing, job?.detail ?? null, job?.needs ?? null, digest),
    lastPrompt: oneLine(digest?.lastPrompt) || null,
    ...planOf(opening, digest, listing.sessionId, manual),
    stateSince: stateSinceOf(runs, kind),
    updatedAt: lastSeen || null,
    startedAt,
    segments: bandSegments(runs, start),
    events: events.reverse(),
    subagents,
    jobs,
    pages,
    pr: cachedPr(listing.cwd, branch),
    groupId: groupOf(listing.sessionId),
    contextTokens: digest?.contextTokens ?? null,
  }
  const outputs = new Map(jobs.flatMap((shown) => {
    const path = shown.status === 'running' ? digest?.jobs[shown.id]?.outputPath : null
    return path ? [[shown.id, path] as const] : []
  }))
  return { strip, opening, manual, outputs }
}

function bareStrip(listing: AgentListing): AgentStrip {
  const kind = stateKindOf(listing, null)
  return {
    sessionId: listing.sessionId, shortId: listing.id, kind: listing.kind,
    surface: serverT(listing.kind === 'background' ? 'surface.background' : 'surface.interactive'), name: listing.name,
    project: listing.cwd, cwd: listing.cwd, branch: null, bay: bayOf(kind, null, 0, []), stateKind: kind,
    now: serverT('now.unreadable'), lastPrompt: null, goal: null, todos: null, todoSource: null, todosDoneEarlier: 0, progress: null, progressAt: null, worktrees: [], stateSince: null, updatedAt: null,
    startedAt: listing.startedAt === undefined ? null : Number(listing.startedAt),
    segments: [], events: [], subagents: [], jobs: [], pages: [], pr: null, groupId: groupOf(listing.sessionId), contextTokens: null,
  }
}

let lastCliFailure: string | null = null

/** "Command failed" says nothing; the real reason is in claude's stderr. The same error is logged once, so it doesn't print a line every 3 seconds */
function describeCliFailure(err: Error & { stderr?: string }): string {
  const reason = err.stderr?.split('\n').map((line) => line.trim()).find(Boolean) ?? err.message.split('\n')[0]
  if (reason !== lastCliFailure) {
    console.warn(`[agents] ${err.message.split('\n')[0]}\n${err.stderr ?? ''}`)
    lastCliFailure = reason
  }
  return reason
}

export interface Collected {
  snapshot: Snapshot
  /** Includes retired (collapsed) strips; write actions look a strip up by sessionId */
  allStrips: AgentStrip[]
  /** Retired strips that became running or waiting again: the caller restores them to the board */
  revived: string[]
}

// The dashboard's own page doesn't count as a page a session opened
const OWN_PORT = config.port

// The dashboard's own `claude -p /usage` runs in the state dir; for those few seconds it also registers as a session
// and must not show up as a strip
const OWN_CWD = config.stateDir

/** Hides retired strips, requests briefs for the ones on display and wraps everything into a Snapshot */
function assemble(allStrips: AgentStrip[], built: ReadonlyMap<string, Built>, retired: ReadonlyMap<string, number>, now: number,
  usage: UsageReading | null, machine: MachineReading | null): Collected {
  const { shown, retiredRows, revived } = arrange(allStrips, retired)
  // Only strips on display get todos and progress written; retired ones cost nothing
  for (const strip of shown) {
    const source = built.get(strip.sessionId)
    if (source !== undefined) requestBrief(briefJobOf(strip, source.opening, source.manual?.items ?? null))
  }
  const snapshot: Snapshot = { takenAt: now, lang: currentLang(), windowMs: WINDOW_MS, strips: shown, retired: retiredRows, groups: listGroups(), ungroupedAt: ungroupedAt(), usage, machine, error: null, briefsEnabled: config.briefsEnabled, contextLine: config.contextLine }
  return { snapshot, allStrips, revived }
}

/** Demo mode: the fixture strips from shared/demo.ts go through the same ordering, retire and group logic as real ones */
function collectDemo(retired: ReadonlyMap<string, number>): Collected {
  const now = Date.now()
  const strips = demoBoardStrips(now, serverT, groupOf)
  // Briefs are not requested: nothing is built from files, so there is nothing for Haiku to read
  return assemble(strips, new Map(), retired, now, demoUsage(now), demoMachine(now))
}

export async function collectSnapshot(retired: ReadonlyMap<string, number>): Promise<Collected> {
  if (config.demo) return collectDemo(retired)
  const now = Date.now()
  const usage = await readUsage()
  let listings: AgentListing[]
  try {
    listings = (await listAgents()).filter((listing) => listing.cwd !== OWN_CWD)
  } catch (err) {
    // Boundary downgrade: claude not on PATH / the CLI changed its output format. The UI shows the reason; retried next round
    const error = describeCliFailure(err as Error & { stderr?: string })
    const snapshot: Snapshot = { takenAt: now, lang: currentLang(), windowMs: WINDOW_MS, strips: [], retired: [], groups: listGroups(), ungroupedAt: ungroupedAt(), usage, machine: (await sampleResources([])).machine, error, briefsEnabled: config.briefsEnabled, contextLine: config.contextLine }
    return { snapshot, allStrips: [], revived: [] }
  }
  const settled = await Promise.allSettled(listings.map((l) => buildStrip(l, now)))
  const built = new Map<string, Built>()
  const allStrips = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      built.set(outcome.value.strip.sessionId, outcome.value)
      return outcome.value.strip
    }
    // Per-strip downgrade: a session may end and its files vanish mid-read. Show only what the agents listing has; don't sink the whole snapshot
    console.warn(`[collect] ${listings[i].name}: ${(outcome.reason as Error).message}`)
    return bareStrip(listings[i])
  })
  const resources = await sampleResources([...built.values()].flatMap((entry) => [...entry.outputs.values()]))
  for (const entry of built.values()) {
    for (const job of entry.strip.jobs) {
      const path = entry.outputs.get(job.id)
      if (path !== undefined) job.usage = resources.jobs.get(path) ?? null
    }
  }
  return assemble(allStrips, built, retired, now, usage, resources.machine)
}
