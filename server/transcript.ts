// Extracts from the transcript jsonl: title, last request, latest action, activity timestamps and subagents.
// The format was observed locally on 2026-11-07 and is undocumented. Only the tail of the file is read:
// the full transcript of a long session can be tens of MB.
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { MessageKey, Translate } from '../shared/i18n/index.ts'
import type { JobStatus, SubagentRow } from '../shared/types.ts'
import { parseJsonLine } from './agents.ts'
import { config } from './config.ts'

const PROJECTS_DIR = join(config.claudeDir, 'projects')
const TAIL_BYTES = 768 * 1024

/** What the agent did last. Kept as data, not text, because the digest outlives a language switch: collect.ts words it in the current language */
export type LastAction = { kind: 'tool'; tool: string | null; hint: string | null } | { kind: 'answered' }

export interface TranscriptDigest {
  path: string
  /** The name you gave it (via /rename or the dashboard): the newest one in the transcript */
  customTitle: string | null
  /** The title Claude Code generates automatically; VSCode's sidebar shows it while the session is not renamed */
  aiTitle: string | null
  lastPrompt: string | null
  lastAgentText: string | null
  lastAction: LastAction | null
  /** Name of a tool that was sent but has no tool_result yet; AskUserQuestion pending = waiting for your answer */
  pendingTool: string | null
  branch: string | null
  /** When you spoke */
  promptTimes: number[]
  /** When the agent produced each output */
  activityTimes: number[]
  recentTurns: { at: number; actor: 'you' | 'agent'; text: string }[]
  /** The first few things you said in this session: the raw material for extracting todos */
  openingPrompts: string[]
  /** Worktree roots touched by tool calls → when each was last touched */
  worktrees: Record<string, number>
  /** Background jobs: task id → start and end */
  jobs: Record<string, RawJob>
  /** Local pages opened: url → when it was last mentioned */
  pages: Record<string, number>
  /** Token count of the current context: input + cache_creation + cache_read of the latest main-conversation reply;
   *  between a compaction boundary and the next reply, the boundary record's postTokens */
  contextTokens: number | null
}

/** A Bash command sent that has no result yet; background = whether it was sent with run_in_background */
type Launch = Pick<RawJob, 'description' | 'command' | 'startedAt'> & { background: boolean }

/** A Bash command running in the background: sent with run_in_background, or a foreground command moved there after
 *  it timed out. status null = no completion notice received yet */
export interface RawJob {
  id: string
  description: string
  command: string
  startedAt: number
  /** Output file path Claude Code returned to the session. As of 2026-11-07 it was deleted after the task ended; since
   *  2026-11-08 it stays, and its last line is [exited with code N] */
  outputPath: string | null
  status: JobStatus | null
  endedAt: number | null
}

// .claude/worktrees/<name> (created by Claude Code) counts as a worktree. The name only accepts [A-Za-z0-9._-];
// an entry followed immediately by a wildcard or shell variable (my-repo-*, -$n, -${x}) doesn't count: that is a
// pattern inside a command, not a real directory
const WORKTREE_PATH = /(\/[^\s"'`\\]+?\/\.claude\/worktrees\/[\w.-]+)(?![\w.*$?{}[\]-])/g
// Format observed 2026-11-07: the tool_result of a background command reads
// "Command running in background with ID: <id>. Output is being written to: <path>";
// when it ends, the session receives a notice containing <task-notification>, with status completed / failed / stopped.
// Measured 2026-11-08: the notice is no longer a user entry but a queue-operation entry (content) and an attachment entry
// (attachment.type is queued_command, text in prompt)
// Measured 2026-11-08: a foreground command that runs past its timeout moves to the background, and its result reads
// "…moved to the background (ID: <id>). Output is being written to: <path>". Both kinds of entry carry
// toolUseResult.backgroundTaskId, which is read first; the text is only a fallback for run_in_background commands in
// the older format
const JOB_STARTED = /with ID: (\w+)/
const JOB_OUTPUT = /written to: (\S+?)\.?(?:\s|$)/
const JOB_ENDED = /<task-id>(\w+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g
// Local pages: localhost / 127.0.0.1 with a port. API and health-check endpoints don't count as pages
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/[^\s"'`)<>\]，。、\\]*)?/g
const NOT_A_PAGE = /:\d+\/(?:api|health|docs|openapi)\b|\$/
// Pages opened for you to look at, with `open <url>`
const OPEN_COMMAND = /\bopen\s+["']?(https?:\/\/\S+)/g
// Jobs that ended longer ago than this are dropped
const KEEP_JOBS_MS = 26 * 3_600_000
const KEEP_JOBS = 60

// The first message is often just a question; the real goal comes out a message or two later
const OPENING_COUNT = 3
// Very short messages like "continue" or "ok" don't count as an opening
const MIN_OPENING_LENGTH = 4

// sessionId → transcript path. A session never changes directory, so a hit is cached forever
const pathCache = new Map<string, string>()

export async function locateTranscript(sessionId: string): Promise<string | null> {
  const cached = pathCache.get(sessionId)
  if (cached !== undefined) return cached
  for (const lane of await readdir(PROJECTS_DIR)) {
    const candidate = join(PROJECTS_DIR, lane, `${sessionId}.jsonl`)
    if (existsSync(candidate)) {
      pathCache.set(sessionId, candidate)
      return candidate
    }
  }
  return null
}

/** Reads the complete lines in [start, end); a half-written line at the end waits for the next round, and consumedTo stops right after the last newline */
async function readCompleteLines(path: string, start: number, end: number): Promise<{ lines: string[]; consumedTo: number }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    await handle.read(buffer, 0, buffer.length, start)
    // Finding the newline by byte is safe: 0x0a never appears inside a UTF-8 multi-byte character
    const lastNewline = buffer.lastIndexOf(0x0a)
    if (lastNewline === -1) return { lines: [], consumedTo: start }
    return { lines: buffer.subarray(0, lastNewline).toString('utf8').split('\n'), consumedTo: start + lastNewline + 1 }
  } finally {
    await handle.close()
  }
}

type ContentBlock = {
  type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>
  tool_use_id?: string; content?: unknown
}

function blocksOf(row: Record<string, unknown>): ContentBlock[] {
  const message = row.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content as ContentBlock[]
  return []
}

/** User entries mix in hook output, system reminders and command tags; keep only what a human typed */
function humanText(row: Record<string, unknown>): string | null {
  // Measured 2026-11-07: what you type carries turnOrigin = human; messages from other sessions and continuation
  // prompts carry isMeta, compaction summaries carry isCompactSummary / isVisibleInTranscriptOnly. Older transcripts
  // have no turnOrigin and fall back to the text checks below
  if (typeof row.turnOrigin === 'string' && row.turnOrigin !== 'human') return null
  if (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true || row.promptSource === 'system') {
    return null
  }
  for (const block of blocksOf(row)) {
    if (block.type !== 'text' || !block.text) continue
    const text = block.text.trim()
    if (text.startsWith('<') || text.startsWith('[Request interrupted')) continue
    return text
  }
  return null
}

// Tools that, while pending without a tool_result, mean the session is waiting for you
export const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Strips speak plain language, not tool names. Tools not listed here are shown under their own name
const TOOL_KEYS = {
  Bash: 'tool.Bash', Read: 'tool.Read', Edit: 'tool.Edit', Write: 'tool.Write', NotebookEdit: 'tool.NotebookEdit',
  Grep: 'tool.Grep', Glob: 'tool.Glob', WebFetch: 'tool.WebFetch', WebSearch: 'tool.WebSearch', Agent: 'tool.Agent', Task: 'tool.Agent',
  AskUserQuestion: 'tool.AskUserQuestion', ExitPlanMode: 'tool.ExitPlanMode', Skill: 'tool.Skill', ToolSearch: 'tool.ToolSearch',
  TaskStop: 'tool.TaskStop', SendMessage: 'tool.SendMessage', Workflow: 'tool.Workflow',
} as const satisfies Record<string, MessageKey>

function toolUseOf(block: ContentBlock): LastAction {
  const input = block.input ?? {}
  const hint = input.description ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.skill ?? input.prompt
  return { kind: 'tool', tool: block.name ?? null, hint: typeof hint === 'string' ? hint : null }
}

/** "Reading a file: foo.ts" in the language of `t` */
export function describeAction(action: LastAction, t: Translate): string {
  if (action.kind === 'answered') return t('now.answered')
  const key = action.tool !== null && Object.hasOwn(TOOL_KEYS, action.tool) ? TOOL_KEYS[action.tool as keyof typeof TOOL_KEYS] : null
  const verb = key === null ? action.tool ?? t('tool.other') : t(key)
  return action.hint === null ? verb : `${verb}${t('sep.colon')}${action.hint}`
}

// Transcripts are append-only: each file remembers how far it was read, and the next round parses only what was appended.
// Measured 2026-11-07: re-parsing everything cost about 350ms per round across 3 busy sessions; incremental parsing is close to 0
interface TranscriptCursor {
  offset: number
  customTitle: string | null
  aiTitle: string | null
  /** Bash commands sent that have no result yet: tool_use id → description. A foreground command that times out also
   *  moves to the background, so every one is recorded */
  launching: Map<string, Launch>
  digest: TranscriptDigest
}
const cursors = new Map<string, TranscriptCursor>()
const KEEP_TURNS = 8
const KEEP_TIMES = 4000

function freshCursor(path: string): TranscriptCursor {
  return {
    offset: 0, customTitle: null, aiTitle: null, launching: new Map(),
    digest: {
      path, customTitle: null, aiTitle: null, lastPrompt: null, lastAgentText: null, lastAction: null, pendingTool: null, branch: null,
      promptTimes: [], activityTimes: [], recentTurns: [], openingPrompts: [], worktrees: {}, jobs: {}, pages: {}, contextTokens: null,
    },
  }
}

export async function digestTranscript(sessionId: string): Promise<TranscriptDigest | null> {
  const path = await locateTranscript(sessionId)
  if (path === null) return null
  const { size } = await stat(path)
  let cursor = cursors.get(path)
  if (cursor !== undefined && size === cursor.offset) return cursor.digest
  // First read, or the file got shorter (rewritten): start TAIL_BYTES before the end; the first line may be partial and is dropped
  const restart = cursor === undefined || size < cursor.offset
  if (restart) cursor = freshCursor(path)
  const active = cursor as TranscriptCursor
  const start = restart ? Math.max(0, size - TAIL_BYTES) : active.offset
  if (restart && start > 0) await scanEarlierJobs(active, path, start)
  const { lines, consumedTo } = await readCompleteLines(path, start, size)
  for (const line of restart && start > 0 ? lines.slice(1) : lines) applyLine(active, line)
  active.offset = consumedTo
  const digest = active.digest
  // The tail doesn't necessarily start at the beginning: on the first read of a file, stream from the top to pick up the
  // opening messages, stopping once there are enough. Scanning ends at consumedTo; anything after is picked up by
  // incremental parsing, so nothing is counted twice
  if (restart) digest.openingPrompts = await scanOpeningPrompts(path, consumedTo)
  digest.customTitle = active.customTitle
  digest.aiTitle = active.aiTitle
  digest.recentTurns = digest.recentTurns.slice(-KEEP_TURNS)
  digest.promptTimes = digest.promptTimes.slice(-KEEP_TIMES)
  digest.activityTimes = digest.activityTimes.slice(-KEEP_TIMES)
  pruneJobs(digest, Date.now())
  cursors.set(path, active)
  return digest
}

/** Before the tail, only lines about background jobs matter: a substring check first, and only a hit is parsed */
const JOB_LINE_HINTS = ['"name":"Bash"', 'backgroundTaskId', 'with ID: ', '<task-notification>']
// Commands sent before the tail mostly have their results already; only the latest few are kept for the tail to finish
const KEEP_LAUNCHING = 20

/** A file's first read only parses its tail, which misses background jobs started before the tail that are still
 *  running (most visible right after flightstrip restarts). So first stream through the part before the tail and
 *  pick up those jobs' starts and ends. Measured 2026-11-08: about 0.36 s for a 131 MB transcript */
async function scanEarlierJobs(cursor: TranscriptCursor, path: string, end: number): Promise<void> {
  const stream = createReadStream(path, { start: 0, end: end - 1 })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (JOB_LINE_HINTS.some((hint) => line.includes(hint))) applyJobLine(cursor, line)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  cursor.launching = new Map([...cursor.launching].slice(-KEEP_LAUNCHING))
}

/** The part of applyLine that is about background jobs: their start, their task id, their end */
function applyJobLine(cursor: TranscriptCursor, line: string): void {
  const row = parseJsonLine(line)
  if (row === null || row.isSidechain === true || typeof row.timestamp !== 'string') return
  const at = Date.parse(row.timestamp)
  const notice = queuedNotice(row)
  if (notice !== null) noteJobEnds(cursor.digest, notice, at)
  else if (row.type === 'user') noteUserBlocks(cursor, row, at)
  else if (row.type === 'assistant') for (const block of blocksOf(row)) noteBashLaunch(cursor, block, at)
}

/** Streams from the top and parses only lines holding user entries, stopping once the opening messages are found: memory holds one line at a time, and a long transcript is read only as far as its start */
async function scanOpeningPrompts(path: string, end: number): Promise<string[]> {
  const prompts: string[] = []
  if (end === 0) return prompts
  const stream = createReadStream(path, { start: 0, end: end - 1 })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"type":"user"')) continue
      const row = parseJsonLine(line)
      if (row === null || row.type !== 'user' || row.isSidechain === true) continue
      const said = humanText(row)
      if (said !== null && said.length >= MIN_OPENING_LENGTH) prompts.push(said)
      if (prompts.length >= OPENING_COUNT) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return prompts
}

function pruneJobs(digest: TranscriptDigest, now: number): void {
  const jobs = Object.values(digest.jobs)
    .filter((job) => job.endedAt === null || now - job.endedAt < KEEP_JOBS_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, KEEP_JOBS)
  digest.jobs = Object.fromEntries(jobs.map((job) => [job.id, job]))
}

function notePages(digest: TranscriptDigest, text: string, at: number, pattern: RegExp, group: number): void {
  for (const match of text.matchAll(pattern)) {
    const url = match[group].replace(/["'.,;:!?]+$/, '')
    if (url.match(LOCAL_URL)?.[0] === url && !NOT_A_PAGE.test(url)) digest.pages[url] = at
  }
}

/** tool_result content can be a string or [{type:'text', text}] */
function resultText(block: ContentBlock): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return (block.content as ContentBlock[]).map((part) => part.text ?? '').join('\n')
}

const ENDED_STATUS: Record<string, JobStatus> = { completed: 'completed', failed: 'failed', stopped: 'stopped', killed: 'stopped' }

function noteUserBlocks(cursor: TranscriptCursor, row: Record<string, unknown>, at: number): void {
  const digest = cursor.digest
  for (const block of blocksOf(row)) {
    if (block.type === 'tool_result' && block.tool_use_id !== undefined) {
      const launch = cursor.launching.get(block.tool_use_id)
      if (launch === undefined) continue
      cursor.launching.delete(block.tool_use_id)
      const text = resultText(block)
      const id = backgroundTaskIdOf(row) ?? (launch.background ? text.match(JOB_STARTED)?.[1] : undefined)
      if (id === undefined) continue
      const { background: _, ...job } = launch
      digest.jobs[id] = { ...job, id, outputPath: text.match(JOB_OUTPUT)?.[1] ?? null, status: null, endedAt: null }
    } else if (block.type === 'text' && block.text !== undefined) {
      noteJobEnds(digest, block.text, at)
    }
  }
}

/** The background task id Claude Code records on a tool_result entry; a command that finished in the foreground has none */
function backgroundTaskIdOf(row: Record<string, unknown>): string | undefined {
  const result = row.toolUseResult as { backgroundTaskId?: unknown } | undefined
  return typeof result?.backgroundTaskId === 'string' && /^\w+$/.test(result.backgroundTaskId) ? result.backgroundTaskId : undefined
}

/** Reads which background jobs a completion notice says ended, and how */
function noteJobEnds(digest: TranscriptDigest, text: string, at: number): void {
  if (!text.includes('<task-notification>')) return
  for (const [, id, status] of text.matchAll(JOB_ENDED)) {
    const job = digest.jobs[id]
    // The start entry lies before the tail we read: no description, so it isn't recorded. One notice shows up several
    // times (enqueue, attachment, dequeue); only the first counts
    if (job === undefined || job.status !== null) continue
    job.status = ENDED_STATUS[status] ?? 'completed'
    job.endedAt = at
  }
}

/** A completion notice in the newer format: a queue-operation entry's content, or a queued_command attachment's prompt */
function queuedNotice(row: Record<string, unknown>): string | null {
  if (row.type === 'queue-operation') return typeof row.content === 'string' ? row.content : null
  if (row.type !== 'attachment') return null
  const attachment = row.attachment as { type?: unknown; prompt?: unknown } | undefined
  return attachment?.type === 'queued_command' && typeof attachment.prompt === 'string' ? attachment.prompt : null
}

function noteWorktrees(digest: TranscriptDigest, block: ContentBlock, at: number): void {
  for (const match of JSON.stringify(block.input ?? {}).matchAll(WORKTREE_PATH)) {
    digest.worktrees[match[1]] = at
  }
}

function applyLine(cursor: TranscriptCursor, line: string): void {
  if (!line) return
  const row = parseJsonLine(line)
  if (row === null) return
  const digest = cursor.digest
  if (typeof row.customTitle === 'string') cursor.customTitle = row.customTitle
  if (typeof row.aiTitle === 'string') cursor.aiTitle = row.aiTitle
  if (row.type === 'last-prompt' && typeof row.lastPrompt === 'string') digest.lastPrompt = row.lastPrompt
  if (typeof row.gitBranch === 'string' && row.gitBranch) digest.branch = row.gitBranch
  if (row.isSidechain === true || typeof row.timestamp !== 'string') return
  if (row.type === 'system' && row.subtype === 'compact_boundary') {
    // Measured 2026-11-08: compactMetadata.postTokens is the size after compaction; readings from before it are void from here on
    const post = (row.compactMetadata as { postTokens?: unknown } | undefined)?.postTokens
    digest.contextTokens = typeof post === 'number' ? post : null
    return
  }
  const at = Date.parse(row.timestamp)
  const notice = queuedNotice(row)
  if (notice !== null) {
    noteJobEnds(digest, notice, at)
    return
  }
  if (row.type === 'user') {
    noteUserBlocks(cursor, row, at)
    if (blocksOf(row).some((b) => b.type === 'tool_result')) {
      if (digest.pendingTool !== null && QUESTION_TOOLS.has(digest.pendingTool)) digest.lastAction = { kind: 'answered' }
      digest.pendingTool = null
    }
    const said = humanText(row)
    if (said !== null) {
      // A newly started session: while the opening isn't full yet, messages read incrementally count as opening too
      if (digest.openingPrompts.length < OPENING_COUNT && said.length >= MIN_OPENING_LENGTH) digest.openingPrompts.push(said)
      digest.promptTimes.push(at)
      digest.recentTurns.push({ at, actor: 'you', text: said })
    }
  } else if (row.type === 'assistant') {
    digest.activityTimes.push(at)
    const context = contextOf(row)
    if (context > 0) digest.contextTokens = context
    for (const block of blocksOf(row)) applyAgentBlock(cursor, block, at)
  }
}

/** How big the context was when this reply was sent. Synthetic messages such as errors (model <synthetic>) have all-zero usage; returns 0 and the caller skips it */
function contextOf(row: Record<string, unknown>): number {
  const usage = (row.message as { usage?: Record<string, unknown> } | undefined)?.usage
  if (usage === undefined) return 0
  const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
  return count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens')
}

function applyAgentBlock(cursor: TranscriptCursor, block: ContentBlock, at: number): void {
  const digest = cursor.digest
  if (block.type === 'text' && block.text?.trim()) {
    digest.lastAgentText = block.text.trim()
    digest.lastAction = null
    digest.recentTurns.push({ at, actor: 'agent', text: block.text.trim() })
    notePages(digest, block.text, at, LOCAL_URL, 0)
  } else if (block.type === 'tool_use') {
    digest.lastAction = toolUseOf(block)
    digest.pendingTool = block.name ?? null
    noteWorktrees(digest, block, at)
    const input = block.input ?? {}
    if (block.name === 'Bash' && typeof input.command === 'string') notePages(digest, input.command, at, OPEN_COMMAND, 1)
    noteBashLaunch(cursor, block, at)
  }
}

/** Remembers a Bash command that was sent, so its result can tell whether it moved to the background */
function noteBashLaunch(cursor: TranscriptCursor, block: ContentBlock, at: number): void {
  const input = block.input ?? {}
  if (block.type !== 'tool_use' || block.name !== 'Bash' || typeof input.command !== 'string' || block.id === undefined) return
  const description = typeof input.description === 'string' && input.description ? input.description : input.command
  cursor.launching.set(block.id, { description: description.slice(0, 200), command: input.command.slice(0, 400), startedAt: at, background: input.run_in_background === true })
}

/** <sessionId>/subagents/*.meta.json; only running ones and ones that ended within the window */
export async function readSubagents(transcriptPath: string, sinceMs: number): Promise<SubagentRow[]> {
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  if (!existsSync(dir)) return []
  const rows: SubagentRow[] = []
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.meta.json')) continue
    const metaPath = join(dir, file)
    const meta = parseJsonLine(await readFile(metaPath, 'utf8'))
    if (meta === null) continue
    const running = meta.finished !== true
    if (!running && (await stat(metaPath)).mtimeMs < sinceMs) continue
    rows.push({
      id: file.replace(/^agent-|\.meta\.json$/g, ''),
      agentType: String(meta.agentType ?? 'agent'),
      description: String(meta.description ?? ''),
      running,
    })
  }
  return rows.sort((a, b) => Number(b.running) - Number(a.running))
}
