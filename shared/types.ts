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
  /** How far it has got, read from the progress marks in its output; only for jobs that are still running */
  progress: JobProgress | null
  /** When the output last grew; null for a job that has printed nothing yet (it may write to its own log instead),
   *  and for jobs that ended */
  lastOutputAt: number | null
  /** What the job's processes use right now; only for running jobs, null when they can't be found (no lsof or ps) */
  usage: JobUsage | null
}

export interface JobUsage {
  /** Summed over the job's processes, as top and Activity Monitor count it: 100 = one core flat out */
  cpuPercent: number
  /** Resident memory of those processes, bytes */
  memoryBytes: number
  processes: number
}

export interface JobProgress {
  /** 0–1 */
  fraction: number
  /** The mark as the reader should see it: "3/8", "45%", "epoch 4/20" */
  mark: string
  /** The rest of that line, usually the step name; null when the line is only the mark */
  label: string | null
  /** The mark is on the last line of the output, so that line needn't be shown again */
  lineIsTail: boolean
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
  /** Memory of the session's process plus everything it started; null when the process is not running or not sampled yet */
  memoryBytes: number | null
}

export interface RetiredRow {
  sessionId: string
  name: string
  kind: 'interactive' | 'background'
  retiredAt: number
}

/** The system's own judgment of how tight memory is (macOS only); null where there is none */
export type MemoryPressure = 'normal' | 'warn' | 'critical'

/** Load of the machine the dashboard runs on */
export interface MachineReading {
  at: number
  /** Busy share of all cores together over the last few seconds, 0–100; null before there are two samples */
  cpuPercent: number | null
  cores: number
  /** swapUsedBytes: the part moved out to disk (swap); null when it can't be read */
  memory: { usedBytes: number; totalBytes: number; pressure: MemoryPressure | null; swapUsedBytes: number | null }
  /** The volume holding the home directory; null when it can't be read */
  disk: { freeBytes: number; totalBytes: number } | null
}

/** One row of the memory ranking */
export interface Hog {
  /** What the page sends back to act on it */
  key: string
  name: string
  /** app = all processes of one application; job = a big task a session started; sessions = all Claude sessions
   *  together; system = processes of the operating system */
  kind: 'app' | 'job' | 'sessions' | 'system'
  /** The same figure as Activity Monitor's Memory column, including compressed and swapped-out pages */
  memoryBytes: number
  /** 100 = one full core */
  cpuPercent: number
  processes: number
  /** job: the name of the session that started it */
  owner: string | null
  /** Whether the board offers to end it */
  killable: boolean
  /** Whether it can be paused: only tasks a session started. A paused app would just hang with a spinner */
  pausable: boolean
  /** Paused (its processes are stopped), waiting for you to resume or end it */
  paused: boolean
  /** How many Claude sessions run inside it: ending it takes them along */
  hostedSessions: number
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
  machine: MachineReading | null
  /** The memory ranking, biggest first; null before the first sample */
  hogs: Hog[] | null
  /** Memory is tight, so the dashboard holds its own Haiku calls: todos and progress on the cards pause */
  briefsHeld: boolean
  error: string | null
  /** False when FLIGHTSTRIP_BRIEFS=off: todos then come only from the session and progress stays empty,
   *  so the UI must not show a "still extracting" state */
  briefsEnabled: boolean
  /** Token count at which the context meter reads "full" (FLIGHTSTRIP_CONTEXT_LINE); the client derives the warning threshold from it */
  contextLine: number
}
