// Memory alert: when macOS says memory is tight and it stays that way, post a notification that says who is using it.
// Unlike the rest of the dashboard this runs whether or not a browser is connected: the alert is for when nobody is
// looking at the board. A check reads two sysctl values and costs next to nothing; the ranking is sampled only when a
// notification is about to go out.
// It goes by the system's own memory-pressure level, not by swap: swap stays high long after the pressure is gone, so
// it would keep firing.
// The same reading also tells the dashboard to hold its own Haiku calls (brief.ts), even with FLIGHTSTRIP_ALERTS=off.
import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import type { MemoryPressure } from '../shared/types.ts'
import { config } from './config.ts'
import { topHog } from './hogs.ts'
import { serverT } from './lang.ts'
import { DARWIN_PRESSURE, parseSwapUsed } from './resources.ts'

const CHECK_MS = 30_000
// Fire only after this many checks in a row read tight, so a short spike doesn't disturb
const SUSTAINED_CHECKS = 2
// At least this long between two notifications at the same level; going from tight to critical isn't held back
const COOLDOWN_MS = 30 * 60_000
const RANK: Record<MemoryPressure, number> = { normal: 0, warn: 1, critical: 2 }

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: 5_000 }, (err, stdout) => done(err === null ? stdout : null))
  })
}

let tightChecks = 0
let lastLevel: MemoryPressure = 'normal'
let lastNotified: { at: number; level: MemoryPressure } | null = null

/** Whether the latest check (at most 30 s old) found memory tight. The dashboard holds its own Haiku calls meanwhile */
export function memoryTight(): boolean {
  return lastLevel !== 'normal'
}

async function check(): Promise<void> {
  const out = await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage'])
  if (out === null) return
  const [levelLine, swapLine = ''] = out.split('\n')
  const level = DARWIN_PRESSURE[levelLine.trim()] ?? 'normal'
  lastLevel = level
  if (level === 'normal') {
    tightChecks = 0
    return
  }
  tightChecks++
  if (!config.alertsEnabled || tightChecks < SUSTAINED_CHECKS) return
  const escalated = lastNotified !== null && RANK[level] > RANK[lastNotified.level]
  if (lastNotified !== null && !escalated && Date.now() - lastNotified.at < COOLDOWN_MS) return
  lastNotified = { at: Date.now(), level }
  const hog = await topHog()
  const swap = parseSwapUsed(swapLine)
  const parts = [
    hog === null ? null : serverT(hog.pausable && !hog.paused ? 'alert.hogPausable' : 'alert.hog', { name: hog.name, size: gb(hog.memoryBytes) }),
    swap === null || swap === 0 ? null : serverT('alert.swap', { size: gb(swap) }),
  ].filter((part) => part !== null)
  const body = parts.length > 0 ? serverT('alert.body', { facts: parts.join(serverT('sep.comma')) }) : serverT('alert.bodyPlain')
  const title = serverT(level === 'critical' ? 'alert.title.critical' : 'alert.title.warn')
  // The text goes in as arguments, not into the script, so a quote in a process name can't break out
  await run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body])
}

/** macOS only: elsewhere there is no pressure level to go by. Not in demo mode, which reads nothing from the machine */
export function startAlerts(): void {
  if (platform() !== 'darwin' || config.demo) return
  const tick = () => {
    check().catch((err) => console.error('[alerts]', err))
  }
  // Look once at startup: otherwise for the first 30 s after a restart the dashboard would assume memory is fine and call Haiku
  tick()
  setInterval(tick, CHECK_MS)
}
