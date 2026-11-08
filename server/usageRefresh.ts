// Periodically has the official Claude Code client pull usage itself: `claude -p /usage`.
// Measured 2026-11-07: this command has num_turns = 0 and total_cost_usd = 0 (no model call, no tokens), and afterwards
// cachedUsageUtilization in Claude Code's global config (~/.claude.json) is refreshed to the latest value (same source as VSCode's usage panel).
// The dashboard never touches credentials; it only reads the cache the client wrote (usage.ts's fallback source).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const REFRESH_MS = 2 * 60_000

let timer: NodeJS.Timeout | null = null
let running = false
// Once /usage turns out to really call the model, stop for good: never burn tokens quietly
let disabledReason: string | null = null

async function refreshOnce(cwd: string, onDone: () => void): Promise<void> {
  if (running || disabledReason !== null) return
  running = true
  try {
    const { stdout } = await runFile(
      'claude',
      ['-p', '/usage', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence'],
      { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 },
    )
    const reply = JSON.parse(stdout) as { num_turns?: number; total_cost_usd?: number }
    if ((reply.num_turns ?? 0) > 0 || (reply.total_cost_usd ?? 0) > 0) {
      disabledReason = `claude -p /usage called the model (num_turns=${reply.num_turns}, cost=${reply.total_cost_usd}); the scheduled refresh is now off`
      console.warn(`[usage] ${disabledReason}`)
    }
    onDone()
  } catch (err) {
    // Boundary of the long-running loop: if this pull fails, wait for the next round; the board keeps using the previous cache
    console.warn(`[usage] refresh failed: ${(err as Error).message.split('\n')[0]}`)
  } finally {
    running = false
  }
}

/** Starts while a browser is connected; cwd is the dashboard's own state dir, so nothing is left in your projects */
export function startUsageRefresh(cwd: string, onDone: () => void): void {
  if (timer !== null) return
  void refreshOnce(cwd, onDone)
  timer = setInterval(() => void refreshOnce(cwd, onDone), REFRESH_MS)
}

export function stopUsageRefresh(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}
