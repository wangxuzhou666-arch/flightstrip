// Dashboard data shapes shared by server and client. The server only fills allowlisted fields here; auth tokens never come in.
import type { Lang } from './i18n/index.ts'

/** State of a strip; decides the left-edge color and the timeline color */
export type StateKind = 'needs' | 'working' | 'done' | 'failed' | 'idle'

/** Which bay a strip sits in: needs = needs you (including failures and failed experiments nobody has picked up),
 *  working = in progress (including sessions whose chat stopped but whose background jobs still run),
 *  done = just finished (activity within 3 hours), idle = idle */
export type Bay = 'needs' | 'working' | 'done' | 'idle'

/** One stretch on the timeline, epoch milliseconds */
export interface Segment {
  from: number
  to: number
  state: StateKind
}

export interface TimelineEvent {
  at: number
  actor: 'you' | 'agent'
  state: StateKind | null
  text: string
}

export interface SubagentRow {
  id: string
  agentType: string
  description: string
  running: boolean
}

export interface TodoItem {
  text: string
  /** The progress summary judged this item done */
  done: boolean
}

export interface WorktreeRef {
  path: string
  name: string
  lastAt: number
  /** Whether the directory still exists (the transcript keeps the path after a worktree is torn down) */
  exists: boolean
}

/** Background job: a command a session ran with run_in_background */
export type JobStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface BackgroundJob {
  id: string
  /** Plain-language name written by Haiku; the raw description until that is ready */
  name: string
  /** The description the session wrote, usually in English */
  description: string
  command: string
  status: JobStatus
  startedAt: number
  endedAt: number | null
  /** Last line of the output; only read for jobs that are still running */
  tail: string | null
}

/** A local page the session opened */
export interface PageRef {
  url: string
  /** Short form such as localhost:3910/trend */
  label: string
  lastAt: number
  /** Whether the port is currently listening */
  live: boolean
}

export interface PrRef {
  number: number
  url: string
  state: string
  review: string | null
  checks: 'pass' | 'fail' | 'pending' | null
}

export interface AgentStrip {
  sessionId: string
  shortId: string
  kind: 'interactive' | 'background'
  /** Where the session runs (VS Code, Terminal…), already in the snapshot's language */
  surface: string
  name: string
  /** Repository name; null = the session runs in the home directory, which belongs to no project */
  project: string | null
  cwd: string
  branch: string | null
  bay: Bay
  stateKind: StateKind
  /** One line: what it is doing / what it is asking you (text the server writes is in the snapshot's language) */
  now: string
  lastPrompt: string | null
  /** Verbatim: for interactive sessions the first thing you said, for background sessions the dispatch instructions.
   *  Shown while the todos are not extracted yet */
  goal: string | null
  /** Todos; null = still being extracted (or never, when briefs are off) */
  todos: TodoItem[] | null
  /** session = written by the session itself via todo.mjs; haiku = extracted from your opening messages */
  todoSource: 'session' | 'haiku' | null
  /** Finished todos that are no longer in `todos`: todo.mjs keeps only the last few finished ones. 0 for Haiku's list */
  todosDoneEarlier: number
  /** Plain-language summary of the latest progress */
  progress: string | null
  progressAt: number | null
  /** Attached worktrees, most recently touched first */
  worktrees: WorktreeRef[]
  /** When the current state began (not cut off by the 3-hour window); used to show how long it has been waiting */
  stateSince: number | null
  updatedAt: number | null
  startedAt: number | null
  segments: Segment[]
  events: TimelineEvent[]
  subagents: SubagentRow[]
  /** Running background jobs and ones that ended within 24 hours, newest first */
  jobs: BackgroundJob[]
  /** Local pages opened, most recent first */
  pages: PageRef[]
  pr: PrRef | null
  /** The group you put it in; null = ungrouped */
  groupId: string | null
  /** Tokens in the current context: input of the latest main-conversation reply (including cache reads and writes);
   *  right after a compaction, the post-compaction size; null = unreadable */
  contextTokens: number | null
}

export interface RetiredRow {
  sessionId: string
  name: string
  kind: 'interactive' | 'background'
  retiredAt: number
}

export interface UsageWindow {
  percent: number | null
  resetsAt: number | null
}

export interface UsageReading {
  /** statusline: written whenever any session refreshes its status bar, near real time;
   *  cache: cached by Claude Code at startup, may be stale */
  source: 'statusline' | 'cache'
  at: number
  week: UsageWindow
  fiveHour: UsageWindow
}

/** A group you created, listed in the order you arranged them */
export interface SessionGroup {
  id: string
  name: string
}

export interface Snapshot {
  takenAt: number
  /** The language of the whole page: the client renders its own text in it, and the server wrote the text in the snapshot in it */
  lang: Lang
  windowMs: number
  strips: AgentStrip[]
  retired: RetiredRow[]
  groups: SessionGroup[]
  /** Position of "ungrouped" among the groups (0 = top); it can be dragged too */
  ungroupedAt: number
  usage: UsageReading | null
  error: string | null
  /** False when FLIGHTSTRIP_BRIEFS=off: todos then come only from the session and progress stays empty,
   *  so the UI must not show a "still extracting" state */
  briefsEnabled: boolean
  /** Token count at which the context meter reads "full" (FLIGHTSTRIP_CONTEXT_LINE); the client derives the warning threshold from it */
  contextLine: number
}
