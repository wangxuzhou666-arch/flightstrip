// Background jobs and local pages: turns raw transcript records into what the strip shows.
// Still running = no completion notice received and the output file still exists (measured 2026-11-07: Claude Code
// deletes the output file after a task ends; a task killed when its session restarted gets no notice and its output
// file is gone too, so those are not shown at all)
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { connect } from 'node:net'
import type { BackgroundJob, PageRef } from '../shared/types.ts'
import type { RawJob } from './transcript.ts'

const TAIL_BYTES = 4096
const TAIL_LIMIT = 160
const PAGE_LIMIT = 6
const PROBE_TIMEOUT_MS = 300
const PROBE_CACHE_MS = 5_000
// Terminal color control sequences, common in the last line of output
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** The last non-empty line of the output file; null if it can't be read */
async function lastLine(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').replace(ANSI, '').split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean)
    const last = lines.at(-1)
    if (last === undefined) return null
    return last.length > TAIL_LIMIT ? `${last.slice(0, TAIL_LIMIT)}…` : last
  } finally {
    await handle.close()
  }
}

export async function jobsOf(raw: Record<string, RawJob>, nameOf: (description: string) => string): Promise<BackgroundJob[]> {
  const jobs: BackgroundJob[] = []
  for (const job of Object.values(raw)) {
    const running = job.status === null
    // No notice received and the output file is gone too: killed by a restart, state unclear, so not shown
    if (running && (job.outputPath === null || !existsSync(job.outputPath))) continue
    jobs.push({
      id: job.id,
      name: nameOf(job.description),
      description: job.description,
      command: job.command,
      status: job.status ?? 'running',
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      tail: running ? await lastLine(job.outputPath as string) : null,
    })
  }
  return jobs.sort((a, b) => b.startedAt - a.startedAt)
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
