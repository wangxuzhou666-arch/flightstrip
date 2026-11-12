// Uses Haiku to write two things for each strip:
// 1. Todos: what you wanted to achieve in the first few messages of the session. Not recomputed while those
//    messages stay the same, so roughly once per session
// 2. Progress: a plain-language summary of the latest progress, ticking off todos that are done.
//    Updated once per turn (when the session stops running)
// Also gives background jobs a plain-language name: a description written in the other language than the page's
// is translated once and stored in job-names.json in the state dir (a description already in the page's language is shown as is).
// Everything Haiku writes is in the page's language (server/lang.ts), and both caches keep one section per language:
// switching the language shows nothing from the other one, writes the new language once, and switching back finds
// the old text still there.
// Results are stored in briefs.json there, so a restart doesn't recompute. Only requested while the dashboard is open
// (collect is driven by refresh).
// Measured 2026-11-07: one extraction is about 1.3K input + 0.5K output tokens, 0.0008 USD, 4 seconds.
// With FLIGHTSTRIP_BRIEFS=off none of this runs: no `claude -p` calls, no cache files read or written.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LANGS, type Lang } from '../shared/i18n/index.ts'
import type { TodoItem } from '../shared/types.ts'
import { memoryTight } from './alerts.ts'
import { config } from './config.ts'
import { currentLang, serverT } from './lang.ts'

const runFile = promisify(execFile)

/** One line of the recent transcript handed to Haiku; the label in front of it is added in the language of the prompt */
export interface RecentLine {
  role: 'you' | 'agent' | 'now'
  text: string
}

/** Everything that depends on the language Haiku writes in: the system prompts, the labels in its input, and where its output is cut */
interface PromptSet {
  todo: string
  progress: string
  /** Turns each input line (a description in the other language) into a short name in this language */
  name: string
  openingLine: (number: number, text: string) => string
  checklistHeading: string
  recentHeading: string
  doneMark: string
  noTodos: string
  roleLabels: Record<RecentLine['role'], string>
  /** Characters kept of a todo, of the progress note and of a job name; longer output is cut with an ellipsis */
  todoLimit: number
  progressLimit: number
  nameLimit: number
}

const PROMPTS: Record<Lang, PromptSet> = {
  zh: {
    todo: [
      '下面是一个人开一个 AI 对话时说的前几句话。把他想达成的最终目的拆成 2 到 5 条待办。',
      '每条不超过 22 个汉字，动词开头，用最浅显的说法，不用术语和英文缩写，不出现文件名、链接和命令。',
      '只是提问的话，待办就是「弄清楚某某」。规矩、限制和注意事项（比如「不要碰某处」「先问我」「只在某目录里干活」）不算待办。',
      '每行一条，以「- 」开头，不输出别的。',
    ].join(''),
    progress: [
      '你在帮一个同时开着很多 AI 对话的人快速了解其中一个对话进行到哪了。下面给你他的待办清单和对话最近的记录。',
      '输出一行 JSON，不输出别的：{"done":[已经做完的待办编号],"progress":"最新进展"}。',
      'progress 用最浅显的中文，像跟不懂技术的人讲：做成了什么、卡在哪、现在在等什么；',
      '一到两句，不超过 70 个汉字，不用术语和英文缩写，不出现文件名、路径和命令，不评论记录里有没有提到某条待办。',
      'done 里保留清单上标了已完成的编号；其余只有记录里明确说已经做完的才算，拿不准就不算。',
    ].join(''),
    name: [
      '下面每行是一条编了号的后台命令英文说明。给每条起一个不超过 16 个汉字的中文名，像跟不懂技术的人说它在干嘛。',
      '保留 #编号、PR 号和数字，不加解释，不出现文件名和命令。',
      '每条输出一行，写成「编号. 中文名」，编号和输入一致，不输出别的。',
    ].join(''),
    openingLine: (number, text) => `第 ${number} 句：${text}`,
    checklistHeading: '待办清单：',
    recentHeading: '最近的对话记录：',
    doneMark: '（已完成）',
    noTodos: '（没有待办）',
    roleLabels: { you: '用户：', agent: 'AI：', now: '现在：' },
    todoLimit: 40,
    progressLimit: 120,
    nameLimit: 24,
  },
  en: {
    todo: [
      'Below are the first few things a person said when starting a conversation with an AI. Break the final goal they want to reach into 2 to 5 to-do items. ',
      'Each item is at most 10 words, starts with a verb and uses the plainest wording: no jargon or abbreviations, and no file names, links or commands. ',
      'If they are only asking a question, the to-do is "Find out …". Rules, limits and cautions (such as "do not touch X", "ask me first", "only work in this folder") are not to-dos. ',
      'One item per line, each starting with "- ". Output nothing else. Write in English, whatever language the messages are in.',
    ].join(''),
    progress: [
      'You are helping someone who has many AI conversations open at once to see quickly how far one of them has got. Below are their to-do list and the most recent record of the conversation. ',
      'Output one line of JSON and nothing else: {"done":[numbers of the to-dos that are finished],"progress":"latest progress"}. ',
      'Write progress in plain English, as if telling someone who is not technical: what got done, where it is stuck, what it is waiting for. ',
      'One or two sentences, at most 30 words, no jargon or abbreviations, no file names, paths or commands, and no comment on whether the record mentions a to-do. ',
      'In done, keep the numbers the list marks as finished; add others only if the record clearly says they are finished, and when unsure leave them out.',
    ].join(''),
    name: [
      'Each line below is the numbered description of a background command, written in Chinese. Give each one a plain-language English name of at most 6 words, as if telling someone who is not technical what it does. ',
      'Keep #numbers, PR numbers and digits; add no explanation; no file names or commands. ',
      'Output one line per description, written as "number. name" with the same number as the input, and nothing else.',
    ].join(''),
    openingLine: (number, text) => `Message ${number}: ${text}`,
    checklistHeading: 'To-do list:',
    recentHeading: 'Recent conversation:',
    doneMark: '(done) ',
    noTodos: '(no to-dos)',
    roleLabels: { you: 'User: ', agent: 'AI: ', now: 'Now: ' },
    todoLimit: 80,
    progressLimit: 240,
    nameLimit: 48,
  },
}
const NAME_BATCH = 12
// A description gets at most this many naming attempts, counted on disk; after that it keeps its original text. Failures
// used to retry every 15 minutes forever, counted only in memory, so every restart tried again at once (2026-11-11 log:
// 285 of 446 naming calls were repeats)
const NAME_ATTEMPTS = 3

// One entry per session
interface BriefEntry {
  todoKey: string | null
  todos: string[] | null
  progressKey: string | null
  progress: string | null
  done: number[]
  progressAt: number | null
  failedAt: number | null
  /** Failures in a row, cleared on success; decides how long until the next try */
  failures?: number
  /** When it was last on the board: entries gone for long are dropped when saving */
  seenAt?: number
}

export interface BriefJob {
  sessionId: string
  /** The opening messages (for background sessions the first one is the dispatch instructions) */
  opening: string[]
  /** Todos the session wrote itself with todo.mjs: when present, nothing is extracted and no ticking is judged, only progress is written */
  manual: TodoItem[] | null
  /** Recent transcript, oldest first, already truncated */
  recent: RecentLine[]
  /** Changes whenever the transcript changes: decides whether progress needs rewriting */
  activityKey: string
  /** Session no longer running = this turn is over, so progress can update right away */
  settled: boolean
  /** Lower runs first: waiting-for-you and running strips go before idle ones */
  priority: number
}

export interface Brief {
  todos: TodoItem[] | null
  progress: string | null
  progressAt: number | null
}

// A still-running session's progress updates at most this often; a finished turn updates immediately
const WORKING_REFRESH_MS = 10 * 60_000
// At least this long between two progress updates of one session: around a permission prompt the state flips several
// times a minute, and each flip used to rewrite the progress (2026-11-11 log: 26% of calls came within a minute of the
// previous one)
const PROGRESS_MIN_GAP_MS = 2 * 60_000
// The first retry after a failure waits this long; each further failure doubles it, up to RETRY_MAX_MS
const RETRY_AFTER_MS = 15 * 60_000
const RETRY_MAX_MS = 4 * 3_600_000
// A session not on the board for this long loses its todos and progress; at most this many job names are kept (oldest
// dropped first)
const FORGET_SESSION_MS = 30 * 24 * 3_600_000
const KEEP_NAMES = 2000
// Runaway guard: at most this many calls per hour; a single call costing more than the cap disables everything
const CALLS_PER_HOUR = 90
const MAX_CALL_COST_USD = 0.02
const OPENING_LIMIT = 1500
const CALL_TIMEOUT_MS = 90_000

let cwd: string | null = null
let cachePath: string | null = null
let namesPath: string | null = null
let nameFailuresPath: string | null = null
type ByLang<T> = Record<Lang, Record<string, T>>
type NameFailure = { attempts: number; lastAt: number }
// Description in the other language → name in this one, and sessionId → todos and progress, both per language
let names: ByLang<string> = { en: {}, zh: {} }
let entries: ByLang<BriefEntry> = { en: {}, zh: {} }
// Description → how many naming attempts failed and when the last one did, per language
let nameFailures: ByLang<NameFailure> = { en: {}, zh: {} }
// Descriptions waiting for a name; which language they get one in is decided when the batch runs
const pendingNames = new Set<string>()
// Being named now ("lang\ndescription"): every collection asks again before the answer is back, and must not queue it again
const naming = new Set<string>()
let onUpdate: () => void = () => {}
const pending = new Map<string, BriefJob>()
let working = false
// Set when the cost guard trips: what one call cost and how many turns it took
let disabled: { cost: number | undefined; turns: number | undefined } | null = null
const recentCalls: number[] = []

/** Reads a cache file of the shape { en: {…}, zh: {…} }. A missing, corrupt or older-format file (a flat map) reads as empty: it is rebuilt as the board is used */
async function readByLang<T>(path: string): Promise<ByLang<T>> {
  const empty: ByLang<T> = { en: {}, zh: {} }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return empty
  }
  for (const lang of LANGS) {
    const section = parsed?.[lang]
    if (typeof section === 'object' && section !== null && !Array.isArray(section)) empty[lang] = section as Record<string, T>
  }
  return empty
}

export async function startBriefs(onDone: () => void): Promise<void> {
  if (!config.briefsEnabled) {
    // cwd stays null, which makes requestBrief, jobNameOf and drain no-ops
    console.log('[brief] off (FLIGHTSTRIP_BRIEFS=off), not calling Haiku')
    return
  }
  cwd = config.stateDir
  cachePath = join(cwd, 'briefs.json')
  namesPath = join(cwd, 'job-names.json')
  nameFailuresPath = join(cwd, 'job-names-failed.json')
  onUpdate = onDone
  entries = await readByLang<BriefEntry>(cachePath)
  names = await readByLang<string>(namesPath)
  nameFailures = await readByLang<NameFailure>(nameFailuresPath)
}

/** Backoff: after `failures` failures in a row, how long until the next try */
function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_AFTER_MS * 2 ** Math.max(0, failures - 1))
}

/** Whether a description can be named in this language now: it needs a name and has none, isn't being named, hasn't
 *  used up its attempts, and its last failure was long enough ago */
function canName(description: string, lang: Lang, now: number): boolean {
  if (!needsName(description, lang) || names[lang][description] !== undefined || naming.has(`${lang}\n${description}`)) return false
  const failed = nameFailures[lang][description]
  return failed === undefined || (failed.attempts < NAME_ATTEMPTS && now - failed.lastAt >= retryDelay(failed.attempts))
}

/** Why Haiku isn't writing todos and progress right now; null while it writes as usual. Memory pressure is briefsHeld */
export function briefsPausedReason(now = Date.now()): string | null {
  if (disabled !== null) return serverT('briefs.paused.cost', { cost: String(disabled.cost ?? '?'), turns: String(disabled.turns ?? '?') })
  const lastHour = recentCalls.filter((at) => now - at <= 3_600_000)
  if (lastHour.length < CALLS_PER_HOUR) return null
  const resume = new Date(lastHour[0] + 3_600_000)
  return serverT('briefs.paused.hourly', { count: CALLS_PER_HOUR, time: `${resume.getHours()}:${String(resume.getMinutes()).padStart(2, '0')}` })
}

const HAS_CHINESE = /[\u4e00-\u9fff]/

/** A description is written in Chinese or (usually) English; it needs a name only when that is not the language of the page */
function needsName(description: string, lang: Lang): boolean {
  return HAS_CHINESE.test(description) ? lang !== 'zh' : lang !== 'en'
}

/** Plain-language name of a background job; until it is translated the original text is returned and the description is queued */
export function jobNameOf(description: string): string {
  const lang = currentLang()
  if (!needsName(description, lang)) return description
  const name = names[lang][description]
  if (name !== undefined) return name
  if (cwd !== null && disabled === null && canName(description, lang, Date.now())) {
    pendingNames.add(description)
    void drain()
  }
  return description
}

// Bump this number when a prompt changes; todos already on disk get rewritten with the new prompt
const PROMPT_VERSION = 3

function keyOf(texts: string[]): string {
  return createHash('sha1').update(`v${PROMPT_VERSION}\n${texts.join('\n\u0000')}`).digest('hex').slice(0, 16)
}

export function briefOf(sessionId: string): Brief {
  const entry = entries[currentLang()][sessionId]
  if (entry === undefined || entry.todos === null) return { todos: null, progress: entry?.progress ?? null, progressAt: entry?.progressAt ?? null }
  const done = new Set(entry.done)
  return {
    todos: entry.todos.map((text, i) => ({ text, done: done.has(i + 1) })),
    progress: entry.progress,
    progressAt: entry.progressAt,
  }
}

function needsTodos(job: BriefJob, entry: BriefEntry | undefined): boolean {
  return job.manual === null && job.opening.length > 0 && entry?.todoKey !== keyOf(job.opening)
}

function needsProgress(job: BriefJob, entry: BriefEntry | undefined, now: number): boolean {
  if (job.recent.length === 0 || entry?.progressKey === job.activityKey) return false
  if (entry?.progressAt != null && now - entry.progressAt < PROGRESS_MIN_GAP_MS) return false
  return job.settled || entry?.progressAt == null || now - entry.progressAt > WORKING_REFRESH_MS
}

/** collect calls this every round for the strips on display; unchanged ones are skipped and cost nothing */
export function requestBrief(job: BriefJob): void {
  if (cwd === null || disabled !== null) return
  const now = Date.now()
  const entry = entries[currentLang()][job.sessionId]
  if (entry !== undefined) entry.seenAt = now
  if (entry?.failedAt != null && now - entry.failedAt < retryDelay(entry.failures ?? 1)) return
  if (!needsTodos(job, entry) && !needsProgress(job, entry, now)) return
  pending.set(job.sessionId, job)
  void drain()
}

async function drain(): Promise<void> {
  if (working) return
  working = true
  try {
    while ((pending.size > 0 || pendingNames.size > 0) && disabled === null) {
      const now = Date.now()
      while (recentCalls.length > 0 && now - recentCalls[0] > 3_600_000) recentCalls.shift()
      if (recentCalls.length >= CALLS_PER_HOUR) break
      // No new `claude` processes while memory is tight (each is about 170 MB and half a core for a few seconds).
      // The queue stays; the next collection knocks again
      if (memoryTight()) break
      // Naming handles a whole batch in one call, so do it first
      if (pendingNames.size > 0) {
        if (await runNames()) {
          await saveNames()
          onUpdate()
        }
        continue
      }
      if (pending.size === 0) break
      const job = [...pending.values()].sort((a, b) => a.priority - b.priority)[0]
      pending.delete(job.sessionId)
      await runJob(job)
      await save()
      onUpdate()
    }
  } catch (err) {
    // Saving failed (disk full, directory gone) and the like: stop this round, the next request picks the queue up again;
    // it must not become an unhandled rejection that takes the server down
    console.warn('[brief] queue interrupted:', err)
  } finally {
    working = false
  }
}

async function runJob(job: BriefJob): Promise<void> {
  // The language is fixed for the whole job: its output is stored under it even if the page switches while Haiku is thinking
  const lang = currentLang()
  const prompts = PROMPTS[lang]
  const entry: BriefEntry = entries[lang][job.sessionId] ?? {
    todoKey: null, todos: null, progressKey: null, progress: null, done: [], progressAt: null, failedAt: null,
  }
  entries[lang][job.sessionId] = entry
  try {
    if (needsTodos(job, entry)) {
      const opening = job.opening.map((text, i) => prompts.openingLine(i + 1, text.slice(0, OPENING_LIMIT))).join('\n\n')
      const todos = parseTodos(await askHaiku(`${job.sessionId.slice(0, 8)} todos`, prompts.todo, opening), prompts.todoLimit)
      if (todos.length === 0) throw new Error('todo extraction came back empty')
      entry.todoKey = keyOf(job.opening)
      entry.todos = todos
      // The todos changed, so the old progress and ticks no longer match and must be rewritten
      entry.progressKey = null
      entry.done = []
    }
    if (needsProgress(job, entry, Date.now())) {
      const checklist = job.manual ?? (entry.todos ?? []).map((text, i) => ({ text, done: entry.done.includes(i + 1) }))
      const list = checklist.map((todo, i) => `${i + 1}. ${todo.done ? prompts.doneMark : ''}${todo.text}`).join('\n') || prompts.noTodos
      const recent = job.recent.map((line) => `${prompts.roleLabels[line.role]}${line.text}`).join('\n')
      const input = `${prompts.checklistHeading}\n${list}\n\n${prompts.recentHeading}\n${recent}`
      const reply = parseProgress(await askHaiku(`${job.sessionId.slice(0, 8)} progress`, prompts.progress, input), prompts.progressLimit)
      entry.progress = reply.progress
      // Ticks on manual todos are kept by the session itself; Haiku only sees the last few turns, and anything ticked stays ticked
      if (job.manual === null) {
        const fresh = reply.done.filter((n) => n >= 1 && n <= (entry.todos?.length ?? 0))
        entry.done = [...new Set([...entry.done, ...fresh])].sort((a, b) => a - b)
      }
      entry.progressKey = job.activityKey
      entry.progressAt = Date.now()
    }
    entry.failedAt = null
    entry.failures = 0
  } catch (err) {
    // This one failed this time: retry after a while, longer after each failure in a row; the strip shows the verbatim
    // opening in the meantime
    entry.failedAt = Date.now()
    entry.failures = (entry.failures ?? 0) + 1
    console.warn(`[brief] ${job.sessionId.slice(0, 8)}: ${(err as Error).message}`)
  }
}

/** Haiku's "number. name" lines, matched by number: explanations, blank lines and unknown numbers don't count */
export function parseNames(reply: string, count: number, limit: number): Map<number, string> {
  const named = new Map<number, string>()
  for (const line of reply.split('\n')) {
    const match = /^\s*(?:[-*•]\s*)?(\d+)\s*[.、:：)）]\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const index = Number(match[1])
    if (index >= 1 && index <= count && !named.has(index)) named.set(index, match[2].length > limit ? `${match[2].slice(0, limit)}…` : match[2])
  }
  return named
}

/** Name one batch. What didn't get a name (the call failed, or the reply lacks its number) counts one failed attempt and
 *  is tried again later. Returns whether a call was made */
async function runNames(): Promise<boolean> {
  const lang = currentLang()
  const now = Date.now()
  // Things may have changed since these were queued (the page may have switched language): drop whatever can't be named now
  for (const description of [...pendingNames]) if (!canName(description, lang, now)) pendingNames.delete(description)
  const batch = [...pendingNames].slice(0, NAME_BATCH)
  if (batch.length === 0) return false
  for (const description of batch) {
    pendingNames.delete(description)
    naming.add(`${lang}\n${description}`)
  }
  const { nameLimit, name: prompt } = PROMPTS[lang]
  let named = new Map<number, string>()
  try {
    const input = batch.map((d, i) => `${i + 1}. ${d.replace(/\s+/g, ' ')}`).join('\n')
    named = parseNames(await askHaiku(`naming ${batch.length}`, prompt, input), batch.length, nameLimit)
    if (named.size < batch.length) console.warn(`[brief] naming answered ${named.size}/${batch.length}; the rest is retried later`)
  } catch (err) {
    console.warn(`[brief] naming failed: ${(err as Error).message}`)
  } finally {
    batch.forEach((description, i) => {
      naming.delete(`${lang}\n${description}`)
      const name = named.get(i + 1)
      if (name !== undefined) {
        names[lang][description] = name
        delete nameFailures[lang][description]
      } else {
        nameFailures[lang][description] = { attempts: (nameFailures[lang][description]?.attempts ?? 0) + 1, lastAt: now }
      }
    })
  }
  return true
}

/** Only the latest `limit` entries of each language (string keys keep the order they were added in) */
function keepLatest<T>(byLang: ByLang<T>, limit: number): ByLang<T> {
  const trim = (record: Record<string, T>) => {
    const keys = Object.keys(record)
    return keys.length <= limit ? record : Object.fromEntries(keys.slice(-limit).map((key) => [key, record[key]]))
  }
  return { en: trim(byLang.en), zh: trim(byLang.zh) }
}

async function saveNames(): Promise<void> {
  names = keepLatest(names, KEEP_NAMES)
  nameFailures = keepLatest(nameFailures, KEEP_NAMES)
  if (namesPath !== null) await writeAtomic(namesPath, names)
  if (nameFailuresPath !== null) await writeAtomic(nameFailuresPath, nameFailures)
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`
  await writeFile(temp, JSON.stringify(value))
  await rename(temp, path)
}

interface HaikuReply {
  result?: string
  is_error?: boolean
  num_turns?: number
  total_cost_usd?: number
}

function parseReply(stdout: string): HaikuReply | null {
  try {
    return JSON.parse(stdout) as HaikuReply
  } catch {
    return null
  }
}

/** The cost guard: one call over MAX_CALL_COST_USD, or more than one turn (it must not use tools), switches everything off */
function guardCost(reply: HaikuReply): void {
  if ((reply.total_cost_usd ?? 0) > MAX_CALL_COST_USD || (reply.num_turns ?? 0) > 1) {
    disabled = { cost: reply.total_cost_usd, turns: reply.num_turns }
    console.warn(`[brief] one call cost ${reply.total_cost_usd} USD over ${reply.num_turns} turns, more than expected; summaries are now off`)
  }
}

async function askHaiku(label: string, systemPrompt: string, input: string): Promise<string> {
  recentCalls.push(Date.now())
  const child = runFile(
    'claude',
    [
      '-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence',
      // No tools, no MCP, none of your hooks: a one-shot plain-text rewrite, so the conversation content can't touch anything
      '--tools', '', '--strict-mcp-config', '--setting-sources', 'project',
      '--system-prompt', systemPrompt,
    ],
    { cwd: cwd as string, timeout: CALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, MAX_THINKING_TOKENS: '0' } },
  )
  child.child.stdin?.end(input)
  let stdout: string
  try {
    ({ stdout } = await child)
  } catch (err) {
    // A non-zero exit often still prints JSON (is_error, what the call cost): it goes through the cost guard all the
    // same, and the log gets the real cause instead of a bare "Command failed"
    const failure = err as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean }
    const reply = parseReply(failure.stdout ?? '')
    if (reply !== null) guardCost(reply)
    const how = failure.killed ? 'timed out' : `exit code ${failure.code ?? '?'}`
    const why = reply?.result ?? ((failure.stderr ?? '').trim().split('\n').at(-1) || failure.message.split('\n')[0])
    throw new Error(`${label}: the Haiku call failed (${how}): ${why.slice(0, 300)}`)
  }
  const reply = parseReply(stdout)
  if (reply === null) throw new Error(`${label}: Haiku's output isn't JSON: ${stdout.slice(0, 200)}`)
  guardCost(reply)
  // Log the cost of every call on one line so the log can be reconciled
  console.log(`[brief] ${label} ${reply.total_cost_usd ?? '?'} USD`)
  if (reply.is_error === true || typeof reply.result !== 'string') throw new Error(`${label}: Haiku returned no result: ${String(reply.result ?? stdout).slice(0, 200)}`)
  return reply.result
}

function parseTodos(text: string, limit: number): string[] {
  return text.split('\n')
    .map((line) => line.trim().replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5)
    .map((line) => (line.length > limit ? `${line.slice(0, limit)}…` : line))
}

function parseProgress(text: string, limit: number): { done: number[]; progress: string } {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  const parsed = JSON.parse(json) as { done?: unknown; progress?: unknown }
  if (typeof parsed.progress !== 'string' || !parsed.progress.trim()) throw new Error(`progress reply has the wrong shape: ${text.slice(0, 120)}`)
  const done = Array.isArray(parsed.done) ? parsed.done.map(Number).filter(Number.isInteger) : []
  const progress = parsed.progress.trim()
  return { done, progress: progress.length > limit ? `${progress.slice(0, limit)}…` : progress }
}

async function save(): Promise<void> {
  const now = Date.now()
  for (const lang of LANGS) {
    for (const [sessionId, entry] of Object.entries(entries[lang])) {
      if (now - (entry.seenAt ?? entry.progressAt ?? entry.failedAt ?? now) > FORGET_SESSION_MS) delete entries[lang][sessionId]
    }
  }
  if (cachePath !== null) await writeAtomic(cachePath, entries)
}
