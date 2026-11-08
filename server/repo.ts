// The name of the repository a session lives in, and the PR / CI of its current branch.
// gh calls are slow (~1s), so the collect loop only reads a cache and refreshes expired entries in the background,
// never blocking the refresh round.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { PrRef } from '../shared/types.ts'

const runFile = promisify(execFile)
const HOME = homedir()
const PR_TTL_MS = 60_000

// cwd → repo name. A worktree must roll up to its main repo, so use git-common-dir rather than show-toplevel
const projectCache = new Map<string, string>()

/** Repository name of a working directory; null for the home directory, which belongs to no project */
export async function projectOf(cwd: string): Promise<string | null> {
  if (cwd === HOME) return null
  const cached = projectCache.get(cwd)
  if (cached !== undefined) return cached
  let name = basename(cwd)
  try {
    const { stdout } = await runFile('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 3000 })
    name = basename(dirname(stdout.trim()))
  } catch {
    // Not a git repo (or the directory is gone): keep the directory name as the project name
  }
  projectCache.set(cwd, name)
  return name
}

interface PrCacheEntry { fetchedAt: number; pr: PrRef | null; inFlight: boolean }
const prCache = new Map<string, PrCacheEntry>()
const NO_PR_BRANCHES = new Set(['main', 'master', 'HEAD'])

type CheckRun = { status?: string; conclusion?: string; state?: string }

function summarizeChecks(rollup: CheckRun[]): PrRef['checks'] {
  if (rollup.length === 0) return null
  const outcomes = rollup.map((run) => (run.conclusion || run.state || run.status || '').toUpperCase())
  if (outcomes.some((o) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(o))) return 'fail'
  if (outcomes.some((o) => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(o))) return 'pending'
  return 'pass'
}

async function fetchPr(cwd: string, branch: string): Promise<PrRef | null> {
  const fields = 'number,url,state,reviewDecision,statusCheckRollup'
  const { stdout } = await runFile('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', fields], { cwd, timeout: 15_000 })
  const [row] = JSON.parse(stdout) as { number: number; url: string; state: string; reviewDecision: string; statusCheckRollup: CheckRun[] }[]
  if (row === undefined) return null
  return { number: row.number, url: row.url, state: row.state, review: row.reviewDecision || null, checks: summarizeChecks(row.statusCheckRollup ?? []) }
}

/** Returns the PR from the cache; when it is missing or expired, refreshes in the background and takes effect next round */
export function cachedPr(cwd: string, branch: string | null): PrRef | null {
  if (branch === null || NO_PR_BRANCHES.has(branch) || cwd === HOME) return null
  const key = `${cwd}\n${branch}`
  const entry = prCache.get(key)
  const fresh = entry !== undefined && Date.now() - entry.fetchedAt < PR_TTL_MS
  if (!fresh && !entry?.inFlight) {
    prCache.set(key, { fetchedAt: entry?.fetchedAt ?? 0, pr: entry?.pr ?? null, inFlight: true })
    fetchPr(cwd, branch)
      .then((pr) => prCache.set(key, { fetchedAt: Date.now(), pr, inFlight: false }))
      .catch((err: Error) => {
        // No GitHub remote, gh not logged in, or the directory is gone all end up here; log once and don't retry for 60 seconds
        console.warn(`[pr] ${branch} @ ${cwd}: ${err.message.split('\n')[0]}`)
        prCache.set(key, { fetchedAt: Date.now(), pr: null, inFlight: false })
      })
  }
  return entry?.pr ?? null
}
