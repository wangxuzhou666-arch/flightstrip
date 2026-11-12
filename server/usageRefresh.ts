// Periodically has the official Claude Code client pull usage itself: `claude -p /usage`.
// Measured 2026-11-07: this command has num_turns = 0 and total_cost_usd = 0 (no model call, no tokens), and afterwards
// cachedUsageUtilization in Claude Code's global config (~/.claude.json) is refreshed to the latest value (same source as VSCode's usage panel).
// The dashboard never touches credentials; it only reads the cache the client wrote (usage.ts's fallback source).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { USAGE_REFRESH_MS } from '../shared/defaults.ts'
import { memoryTight } from './alerts.ts'

const runFile = promisify(execFile)

let timer: NodeJS.Timeout | null = null
let running = false
// When it last really pulled: closing and reopening the board doesn't pull again at once, so a page reopened again and
// again doesn't scan every transcript each time
let lastRunAt = 0
// Once /usage turns out to really call the model, stop for good: never burn tokens quietly
let disabledReason: string | null = null

async function refreshOnce(cwd: string, onDone: () => void): Promise<void> {
  if (running || disabledReason !== null) return
  // Skipped while memory is tight: it takes hundreds of MB, exactly the kind of cost that sinks the machine; the band shows
  // the time of the data as usual
  if (memoryTight() || Date.now() - lastRunAt < USAGE_REFRESH_MS - 5_000) return
  running = true
  lastRunAt = Date.now()
  try {
    const run = runFile(
      'claude',
      ['-p', '/usage', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence'],
      { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 },
    )
    // With stdin left open, claude first waits 3 s for input every time
    run.child.stdin?.end()
    const { stdout } = await run
    const reply = JSON.parse(stdout) as { num_turns?: number; total_cost_usd?: number }
    if ((reply.num_turns ?? 0) > 0 || (reply.total_cost_usd ?? 0) > 0) {
      disabledReason = `claude -p /usage called the model (num_turns=${reply.num_turns}, cost=${reply.total_cost_usd}); the scheduled refresh is now off`
      console.warn(`[usage] ${disabledReason}`)
    }
    onDone()
  } catch (err) {
    // Boundary of the long-running loop: if this pull fails, wait for the next round; the board keeps using the previous
    // cache (and marks it once it is 10 minutes old). The first line alone ("Command failed: ...") never says why, so
    // the time, the exit code or timeout, and stderr's last line go in too
    const failure = err as Error & { code?: number | string; signal?: string; killed?: boolean; stderr?: string }
    const stderr = (failure.stderr ?? '').trim().split('\n').filter((line) => !line.startsWith('Warning: no stdin')).at(-1) ?? ''
    const how = failure.killed ? 'timed out' : `exit code ${failure.code ?? '?'}${failure.signal ? `, signal ${failure.signal}` : ''}`
    console.warn(`[usage] ${new Date().toISOString()} refresh failed (${how}): ${stderr || failure.message.split('\n')[0]}`)
  } finally {
    running = false
  }
}

/** Starts while a browser is connected; cwd is the dashboard's own state dir, so nothing is left in your projects */
export function startUsageRefresh(cwd: string, onDone: () => void): void {
  if (timer !== null) return
  void refreshOnce(cwd, onDone)
  timer = setInterval(() => void refreshOnce(cwd, onDone), USAGE_REFRESH_MS)
}

export function stopUsageRefresh(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}
