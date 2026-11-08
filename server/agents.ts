// The local agent listing and the state files of background sessions.
// The listing is assembled directly from <claude dir>/sessions/*.json (live processes) and <claude dir>/jobs/*/state.json
// (background jobs; the claude dir is ~/.claude or CLAUDE_CONFIG_DIR); it matched `claude agents --json --all` row by row (2026-11-07). The CLI isn't called because in a
// launchd-spawned process every CLI call stalls for about 10 seconds (hung on a connection to api.anthropic.com),
// which would ruin the latency of a resident service.
// These two kinds of files are undocumented and may change format after upgrades: when no valid row can be read,
// fall back to the CLI.
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.ts'

const runFile = promisify(execFile)
const CLAUDE_HOME = config.claudeDir

/** One row of `claude agents --json --all` (Agent View docs + observed locally) */
export interface AgentListing {
  id: string
  sessionId: string
  name: string
  cwd: string
  kind: 'interactive' | 'background'
  pid?: number | string
  startedAt?: number | string
  status?: 'busy' | 'waiting' | 'idle'
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped'
  waitingFor?: string
}

export async function listAgents(): Promise<AgentListing[]> {
  const local = await listAgentsLocal()
  return local ?? listAgentsViaCli()
}

const JOB_STATES = new Set(['working', 'blocked', 'done', 'failed', 'stopped'])

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but isn't ours; ESRCH: the process is gone and the sessions file is a leftover
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Returns null when no valid row can be read (directory missing or format changed), so the caller falls back to the CLI */
export async function listAgentsLocal(): Promise<AgentListing[] | null> {
  const sessionsDir = join(CLAUDE_HOME, 'sessions')
  const jobsDir = join(CLAUDE_HOME, 'jobs')
  const sessionFiles = (await readdir(sessionsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
  const jobDirs = (await readdir(jobsDir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name)
  const listings = new Map<string, AgentListing>()
  let validRows = 0

  for (const file of sessionFiles) {
    const raw = await readTextIfExists(join(sessionsDir, file))
    const row = raw === null ? null : parseJsonLine(raw)
    if (row === null || typeof row.sessionId !== 'string' || row.pid === undefined) continue
    validRows += 1
    if (!isAlive(Number(row.pid))) continue
    listings.set(row.sessionId, {
      id: row.sessionId.slice(0, 8),
      sessionId: row.sessionId,
      name: String(row.name ?? ''),
      cwd: String(row.cwd ?? ''),
      kind: row.kind === 'background' ? 'background' : 'interactive',
      pid: Number(row.pid),
      startedAt: Number(row.startedAt),
      status: row.status as AgentListing['status'],
      waitingFor: typeof row.waitingFor === 'string' ? row.waitingFor : undefined,
    })
  }

  for (const dir of jobDirs) {
    const raw = await readTextIfExists(join(jobsDir, dir, 'state.json'))
    const job = raw === null ? null : parseJsonLine(raw)
    if (job === null || typeof job.sessionId !== 'string') continue
    validRows += 1
    const live = listings.get(job.sessionId)
    // Measured: state.json says "running" where the CLI says "working"
    const state = job.state === 'running' ? 'working' : String(job.state)
    listings.set(job.sessionId, {
      ...live,
      id: typeof job.daemonShort === 'string' ? job.daemonShort : dir,
      sessionId: job.sessionId,
      name: typeof job.name === 'string' ? job.name : live?.name ?? '',
      cwd: typeof job.cwd === 'string' ? job.cwd : live?.cwd ?? '',
      kind: 'background',
      startedAt: live?.startedAt ?? Date.parse(String(job.createdAt)),
      state: JOB_STATES.has(state) ? (state as AgentListing['state']) : undefined,
    })
  }

  const filesPresent = sessionFiles.length + jobDirs.length > 0
  return filesPresent && validRows === 0 ? null : [...listings.values()]
}

async function listAgentsViaCli(): Promise<AgentListing[]> {
  const { stdout } = await runFile('claude', ['agents', '--json', '--all'], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    // Listing sessions needs only local data; switch off telemetry, update checks and other networking.
    // Measured 2026-11-07: in a launchd-spawned process claude hangs on a connection to api.anthropic.com until the timeout
    env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  })
  return JSON.parse(stdout) as AgentListing[]
}

/** The fields we want from jobs/<short id>/state.json (an allowlist; auth-related fields aren't read) */
export interface JobState {
  state: string | null
  detail: string | null
  needs: string | null
  inFlightTasks: number
  nameSource: string | null
  /** The description given when this background job was dispatched: the strip's "goal" */
  intent: string | null
}

export interface JobTimelineEntry {
  at: number
  state: string
  detail: string
}

function jobDir(sessionId: string): string {
  // Measured: the directory name = the first 8 characters of the sessionId (daemonShort in state.json)
  return join(CLAUDE_HOME, 'jobs', sessionId.slice(0, 8))
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function readJobState(sessionId: string): Promise<JobState | null> {
  const raw = await readTextIfExists(join(jobDir(sessionId), 'state.json'))
  // The file may be caught half-rewritten: treat it as absent this round and read it again next round
  const parsed = raw === null ? null : parseJsonLine(raw)
  if (parsed === null) return null
  const inFlight = parsed.inFlight as { tasks?: number } | undefined
  return {
    state: nonEmpty(parsed.state),
    // Measured: right after a restart a background session's detail is an empty string; it must count as "none" so we
    // fall back to the latest action in the transcript
    detail: nonEmpty(parsed.detail),
    needs: nonEmpty(parsed.needs),
    inFlightTasks: Number(inFlight?.tasks ?? 0),
    nameSource: nonEmpty(parsed.nameSource),
    intent: nonEmpty(parsed.intent),
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export async function readJobTimeline(sessionId: string): Promise<JobTimelineEntry[]> {
  const raw = await readTextIfExists(join(jobDir(sessionId), 'timeline.jsonl'))
  if (raw === null) return []
  const entries: JobTimelineEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const row = parseJsonLine(line)
    if (row === null || typeof row.at !== 'string' || typeof row.state !== 'string') continue
    entries.push({ at: Date.parse(row.at), state: row.state, detail: String(row.detail ?? '') })
  }
  return entries
}

/** sessions/<pid>.json: the surface an interactive session runs in, and where its name came from */
export interface InteractiveSessionFile {
  entrypoint: string | null
  nameSource: string | null
  statusUpdatedAt: number | null
}

export async function readInteractiveSession(pid: number | string | undefined): Promise<InteractiveSessionFile | null> {
  if (pid === undefined) return null
  const raw = await readTextIfExists(join(CLAUDE_HOME, 'sessions', `${pid}.json`))
  const parsed = raw === null ? null : parseJsonLine(raw)
  if (parsed === null) return null
  return {
    entrypoint: typeof parsed.entrypoint === 'string' ? parsed.entrypoint : null,
    nameSource: typeof parsed.nameSource === 'string' ? parsed.nameSource : null,
    statusUpdatedAt: parsed.statusUpdatedAt === undefined ? null : Number(parsed.statusUpdatedAt),
  }
}

/** Parses one jsonl line; the file tail may be mid-write, so a bad line returns null and the caller skips it */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}
