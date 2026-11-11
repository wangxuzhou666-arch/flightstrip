// Background jobs and local pages: turns raw transcript records into what the strip shows.
// Still running = no completion notice received, the output file still exists, and its last line isn't an exit code.
// Measured 2026-11-07: Claude Code deletes the output file after a task ends; a task killed when its session restarted
// gets no notice and its output file is gone too, so those are not shown at all.
// Measured 2026-11-08: the output file stays after the task ends, with [exited with code N] as its last line; a task
// stopped with TaskStop gets no notice and its last line is [killed]. When the notice was missed or never came, that
// line is the fallback for telling the job ended
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { connect } from 'node:net'
import { progressIn } from '../shared/jobProgress.ts'
import type { BackgroundJob, JobProgress, JobStatus, PageRef } from '../shared/types.ts'
import type { RawJob } from './transcript.ts'

// The end of the output that is read on each refresh: the last line, plus enough before it to find the newest
// progress mark (a step header followed by a page of logs). Only running jobs are read, a few at a time
const TAIL_BYTES = 64 * 1024
const TAIL_LIMIT = 160
const PAGE_LIMIT = 6
const PROBE_TIMEOUT_MS = 300
const PROBE_CACHE_MS = 5_000
// Terminal color control sequences, common in the last line of output
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// The line Claude Code appends to the output file when a task ends: an exit code, or [killed] when it was stopped
const EXIT_LINE = /^\[(?:exited with code (\d+)|killed)\]$/
// A command's own output can hold that line too (a polling script that tails another task's output, say), so on seeing
// it, lsof also checks that no process has the file open for writing; one that only reads it (a `tail -f` someone left
// running) doesn't count. All files to check in one pass go to a single lsof (about 0.1 s); on macOS it lives in
// /usr/sbin, which isn't always on PATH
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((path) => existsSync(path)) ?? 'lsof'
const LSOF_TIMEOUT_MS = 5_000
// A file found being written isn't checked again for this long, so a running job whose last line happens to be an exit
// line doesn't start lsof on every refresh
const HELD_RECHECK_MS = 5_000
// output file (real path) → when a process was last found writing it
const heldAt = new Map<string, number>()
// A job with no notice and no output file is dropped from the record once it started this long ago (right after a
// start the file may not exist yet, hence the wait)
const GONE_AFTER_MS = 10 * 60_000

/** Which of these files a process still has open for writing (lsof reports real paths).
 *  missing = there is no lsof here, so it can never be checked; failed = it errored or timed out this time, so no
 *  conclusion yet */
function writtenFiles(paths: string[]): Promise<Set<string> | 'missing' | 'failed'> {
  return new Promise((done) => {
    execFile(LSOF, ['-F', 'an', '--', ...paths], { timeout: LSOF_TIMEOUT_MS }, (err, stdout) => {
      if (err !== null && err.code === 'ENOENT') return done('missing')
      // Exit code 1 = some file has no process holding it; the output is still good
      if (err !== null && err.code !== 1) return done('failed')
      const written = new Set<string>()
      let mode = ''
      for (const line of stdout.split('\n')) {
        if (line.startsWith('f')) mode = ''
        else if (line.startsWith('a')) mode = line.slice(1)
        else if (line.startsWith('n') && /[wu]/.test(mode)) written.add(line.slice(1))
      }
      done(written)
    })
  })
}

interface OutputRead {
  line: string | null
  progress: JobProgress | null
  modifiedAt: number
  size: number
}

/** The last non-empty line of the output file, the newest progress mark near its end, and when the file last changed;
 *  null if it can't be read */
async function tailOf(path: string): Promise<OutputRead | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const { size, mtimeMs } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    // A \r rewrites the line in place (progress bars do this), so only what comes after the last one is on screen
    const lines = buffer.toString('utf8').replace(ANSI, '').split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean)
    return { line: lines.at(-1) ?? null, progress: progressIn(lines), modifiedAt: mtimeMs, size }
  } finally {
    await handle.close()
  }
}

function clip(line: string | null): string | null {
  if (line === null) return null
  return line.length > TAIL_LIMIT ? `${line.slice(0, TAIL_LIMIT)}…` : line
}

export async function jobsOf(raw: Record<string, RawJob>, nameOf: (description: string) => string): Promise<BackgroundJob[]> {
  const now = Date.now()
  const shown: Shown[] = []
  const toConfirm: RawJob[] = []
  for (const job of Object.values(raw)) {
    if (job.endedFromOutput === true && job.endedAt !== null && changedSince(job.outputPath, job.endedAt)) {
      // An ending read off the output file only stands while the file stays unchanged: if more was written (the ending
      // was wrong, or the job was stopped afterwards), decide again
      job.status = null
      job.endedAt = null
      job.endedFromOutput = false
    }
    if (job.status !== null) {
      shown.push(ended(job))
      continue
    }
    if (job.outputPath === null || !existsSync(job.outputPath)) {
      // No notice received and the output file is gone too: killed by a restart, state unclear, so not shown. Once it
      // has stayed that way for a while it is dropped, so such jobs don't pile up and get checked on every pass
      if (now - job.startedAt > GONE_AFTER_MS) delete raw[job.id]
      continue
    }
    const read = await tailOf(job.outputPath)
    if (read === null) continue
    if (read.line !== null && EXIT_LINE.test(read.line)) toConfirm.push(job)
    else shown.push(running(job, read))
  }
  if (toConfirm.length > 0) shown.push(...(await confirmEnded(toConfirm)))
  return shown
    .map(({ job, tail, progress, lastOutputAt }) => ({
      id: job.id,
      name: nameOf(job.description),
      description: job.description,
      command: job.command,
      status: job.status ?? 'running',
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      tail,
      progress,
      lastOutputAt,
      // Filled in by collect.ts from one sample across all sessions
      usage: null,
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Has the output file changed since `at`? */
function changedSince(path: string | null, at: number): boolean {
  if (path === null) return false
  try {
    return statSync(path).mtimeMs > at
  } catch {
    return false
  }
}

interface Shown {
  job: RawJob
  tail: string | null
  progress: JobProgress | null
  lastOutputAt: number | null
}

const ended = (job: RawJob): Shown => ({ job, tail: null, progress: null, lastOutputAt: null })

/** A running job as the strip shows it. A mark that later output pushed out of the part read stays on the record, so
 *  the bar doesn't vanish halfway through a long step. An empty output file says nothing about when the job last did
 *  something (it may write to its own log), so it gets no output time */
function running(job: RawJob, read: OutputRead): Shown {
  if (read.progress !== null) job.progress = read.progress
  const progress = read.progress ?? (job.progress === undefined ? null : { ...job.progress, lineIsTail: false })
  return { job, tail: clip(read.line), progress, lastOutputAt: read.size > 0 ? read.modifiedAt : null }
}

/** Jobs whose output ends with an exit line. No process writing it: the line ends the job, and that is written back to
 *  the raw record (the file isn't read again, a long-ended job is cleared on time, and a later official notice or a
 *  later write to the file can still correct it). A process still writing it: the job is running. lsof failed this
 *  time: no conclusion yet, so it still shows as running and the next pass checks again. No lsof on this machine: the
 *  line is all there is, so a job whose last line happens to be an exit line and that then stays silent shows as ended
 *  until it writes again */
async function confirmEnded(jobs: RawJob[]): Promise<Shown[]> {
  const paths = jobs.map((job) => job.outputPath as string)
  const real = await Promise.all(paths.map((path) => realpath(path).catch(() => path)))
  const now = Date.now()
  // Expired entries are removed: once a job ends with a notice its file isn't checked again, so they would pile up
  for (const [path, at] of heldAt) if (now - at >= HELD_RECHECK_MS) heldAt.delete(path)
  const recentlyHeld = (path: string) => now - (heldAt.get(path) ?? -Infinity) < HELD_RECHECK_MS
  const toProbe = real.filter((path) => !recentlyHeld(path))
  const written = toProbe.length === 0 ? new Set<string>() : await writtenFiles(toProbe)
  if (written instanceof Set) {
    for (const path of toProbe) {
      if (written.has(path)) heldAt.set(path, now)
      else heldAt.delete(path)
    }
  }
  const held = (path: string) => recentlyHeld(path) || (written instanceof Set && written.has(path))
  const shown: Shown[] = []
  for (const [i, job] of jobs.entries()) {
    // Something may have been written, or the command may have just exited, while lsof ran: read the last line again
    const read = await tailOf(paths[i])
    if (read === null) continue
    const exit = read.line?.match(EXIT_LINE)
    if (!exit || held(real[i])) {
      shown.push(running(job, read))
      continue
    }
    const status: JobStatus = exit[1] === undefined ? 'stopped' : exit[1] === '0' ? 'completed' : 'failed'
    if (written === 'failed') {
      shown.push(running(job, read))
      continue
    }
    job.status = status
    job.endedAt = read.modifiedAt
    job.endedFromOutput = true
    shown.push(ended(job))
  }
  return shown
}

// port → result and time of the last probe. Probing on every snapshot is too frequent, so a result is reused for 5 seconds
const probes = new Map<number, { live: boolean; at: number }>()

function probe(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (live: boolean) => {
      socket.destroy()
      done(live)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function portLive(port: number, now: number): Promise<boolean> {
  const cached = probes.get(port)
  if (cached !== undefined && now - cached.at < PROBE_CACHE_MS) return cached.live
  const live = await probe(port)
  probes.set(port, { live, at: now })
  return live
}

/** The localhost and 127.0.0.1 spellings of one page count as one; the dashboard's own port doesn't count */
export async function pagesOf(raw: Record<string, number>, ownPort: number, now: number): Promise<PageRef[]> {
  const byPage = new Map<string, { url: string; port: number; label: string; lastAt: number }>()
  for (const [url, lastAt] of Object.entries(raw)) {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    if (port === ownPort) continue
    const path = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`
    const label = `localhost:${port}${path}`
    const seen = byPage.get(label)
    if (seen === undefined || seen.lastAt < lastAt) byPage.set(label, { url, port, label, lastAt })
  }
  const recent = [...byPage.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, PAGE_LIMIT)
  return Promise.all(recent.map(async (page) => ({ url: page.url, label: page.label, lastAt: page.lastAt, live: await portLive(page.port, now) })))
}
