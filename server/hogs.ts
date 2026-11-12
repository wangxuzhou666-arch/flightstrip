// The memory ranking: what uses the most memory and CPU on this machine, and ending or pausing it from the board.
// Memory is top's MEM column (the same figure as Activity Monitor's Memory column, including compressed and swapped-out
// pages), not ps's RSS: when memory is tight the big processes have most of their pages compressed or swapped out, and
// RSS is left with a fraction (measured 2026-11-11: an inference process holding 10 GB showed 78 MB of RSS). Where
// `top -l` doesn't exist (Linux), RSS is what there is.
// Processes are folded into a few kinds: each big task a Claude session started gets its own row (so it can be paused or
// ended alone); the sessions themselves and their small helpers (MCP servers, shells) fold into one "Claude sessions"
// row, and each session's own figure goes on its card; every process of one .app is one application; everything else
// is one row per process tree.
// Which processes are sessions is read here, from sessions/*.json, on every sample, not handed in by the board: the
// memory alert samples while no board is open, and a list handed in then is stale or empty, which made sessions and the
// VS Code hosting them look like ordinary apps with an end button.
// top takes a second or two, so the ranking refreshes in the background and a snapshot takes the previous result.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readlink } from 'node:fs/promises'
import { platform, userInfo } from 'node:os'
import { basename } from 'node:path'
import { ActionError } from '../shared/actionError.ts'
import { actOnDemoHog, demoHogs } from '../shared/demo.ts'
import type { Hog } from '../shared/types.ts'
import { readSessionFiles, sameStart } from './agents.ts'
import { config } from './config.ts'
import { serverT } from './lang.ts'

const SAMPLE_MS = 15_000
const RUN_TIMEOUT_MS = 20_000
// A process tree a session started gets its own row from this size on; smaller ones fold into "Claude sessions"
const SPLIT_BYTES = 300 * 1024 * 1024
const SPLIT_CPU = 50
const LIST_MIN_BYTES = 100 * 1024 * 1024
const LIST_MIN_CPU = 50
// The ranking takes the biggest by memory, then adds the ones burning CPU with little memory (a memory ranking drops them)
const MEMORY_LEADERS = 8
const CPU_LEADERS = 4
const UNIT_BYTES: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
// The process name of these interpreters says nothing about what runs; the script name does
const INTERPRETER = /^(python[\d.]*|node|ruby|perl|deno|bun|java|tsx)$/i
// What follows these options is a piece of code, not a script (python -c, node -e, ruby / perl -e): no script name to take
const INLINE_CODE = new Set(['-c', '-e', '--eval'])
// The shell wrapped around a command: neither its name nor its arguments say what runs inside
const SHELL = /^(bash|zsh|sh|dash|fish)$/
// The operating system's own processes: ending them either restarts them or takes the desktop down, so no button.
// /System/Applications holds ordinary apps (Preview, Notes) and doesn't count. On Linux this needs the full path, which
// ps doesn't give (see processes()); gnome-shell, Xorg and the like live under /usr
const SYSTEM_PATH = /^\/(?:System\/(?!Applications\/)|usr\/(?!local\/)|sbin\/|bin\/|lib(?:64)?\/|Library\/Apple\/)/
const IN_APP = /\/([^/]+)\.app\//
const MY_UID = userInfo().uid
const LINUX = platform() === 'linux'
const findTool = (paths: string[], fallback: string) => paths.find((path) => existsSync(path)) ?? fallback
const PS = findTool(['/bin/ps', '/usr/bin/ps'], 'ps')
const TOP = findTool(['/usr/bin/top'], 'top')

export interface SessionProc {
  sessionId: string
  name: string
  pid: number
}

export interface Proc {
  pid: number
  ppid: number
  uid: number
  cpuPercent: number
  rssBytes: number
  /** Stopped by SIGSTOP */
  stopped: boolean
  /** Full path of the executable */
  exe: string
  args: string
  /** What top reports; RSS when top can't run */
  memoryBytes: number
  /** When it started (ps lstart, in UTC), written like procStart in sessions/*.json; null when unknown */
  started: string | null
}

export interface Group extends Hog {
  pids: number[]
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout) => done(err === null ? stdout : null))
  })
}

/** top's MEM column: "10G", "1064M+", "7473K" */
export function parseTopMemory(out: string): Map<number, number> {
  const memory = new Map<number, number>()
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])[+-]?\s*$/.exec(line)
    if (match !== null) memory.set(Number(match[1]), Number(match[2]) * UNIT_BYTES[match[3]])
  }
  return memory
}

/** On Linux ps's comm is the name cut to 15 characters, so the system-path rule never matched and gnome-shell had an end
 *  button. The full path is /proc/<pid>/exe; it only reads for our own processes, which are the ones that matter (other
 *  users' processes are left without a button anyway). Otherwise the first word of the command line when it's a path */
export async function linuxPath(pid: number, comm: string, args: string): Promise<string> {
  try {
    return await readlink(`/proc/${pid}/exe`)
  } catch {
    const first = args.split(/\s+/)[0] ?? ''
    return first.startsWith('/') ? first : comm
  }
}

async function processes(): Promise<Map<number, Proc> | null> {
  // comm and args can both hold spaces, so each is the last column of its own ps call; lstart is always five words and
  // goes before args
  const [byExe, byArgs, top] = await Promise.all([
    run(PS, ['-A', '-o', 'pid=,ppid=,uid=,pcpu=,rss=,state=,comm=']),
    run(PS, ['-A', '-o', 'pid=,lstart=,args='], { ...process.env, TZ: 'UTC', LC_ALL: 'C' }),
    run(TOP, ['-l', '1', '-stats', 'pid,mem']),
  ])
  if (byExe === null) return null
  const args = new Map<number, { started: string; args: string }>()
  for (const line of (byArgs ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    if (match !== null) args.set(Number(match[1]), { started: match[2], args: match[3] })
  }
  const memory = top === null ? new Map<number, number>() : parseTopMemory(top)
  const table = new Map<number, Proc>()
  for (const line of byExe.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const rssBytes = Number(match[5]) * 1024
    const extra = args.get(pid)
    table.set(pid, {
      pid, ppid: Number(match[2]), uid: Number(match[3]), cpuPercent: Number(match[4]), rssBytes,
      // ps's state column starts with T for a stopped process
      stopped: match[6].startsWith('T'),
      exe: match[7], args: extra?.args ?? match[7], memoryBytes: memory.get(pid) ?? rssBytes, started: extra?.started ?? null,
    })
  }
  if (LINUX) await Promise.all([...table.values()].map(async (proc) => { proc.exe = await linuxPath(proc.pid, proc.exe, proc.args) }))
  return table
}

/** The application a process belongs to: the first .app in its path; outside an .app, the executable's name */
export function appNameOf(exe: string): string {
  const app = IN_APP.exec(exe)
  return app !== null ? app[1] : basename(exe)
}

/**
 * A name a person recognizes: an interpreter is replaced by the script it runs (python scripts/train.py → train.py).
 * An interpreter running inline code has no script, so it keeps its own name.
 */
export function displayNameOf(exe: string, args: string): string {
  const name = appNameOf(exe)
  if (!INTERPRETER.test(name)) return name
  // args starts with the executable; the first word after it that isn't an option is the script. Meeting -c / -e first
  // means what follows is code: pytest-xdist workers run python -c "import sys;exec(...)" and used to show up as "import"
  for (const word of args.split(/\s+/).slice(1)) {
    if (INLINE_CODE.has(word)) return name
    if (!word.startsWith('-')) return basename(word)
  }
  return name
}

/**
 * A process tree's row name. When the heaviest process's own name says nothing (a shell, or an interpreter running
 * inline code), take the nearest ancestor inside the same tree whose name does: a pytest-xdist worker's parent is pytest.
 */
export function jobNameOf(heaviest: Proc, table: Map<number, Proc>, tree: Set<number>): string {
  for (let proc: Proc | undefined = heaviest; proc !== undefined && tree.has(proc.pid); proc = table.get(proc.ppid)) {
    const app = appNameOf(proc.exe)
    const name = displayNameOf(proc.exe, proc.args)
    if (!SHELL.test(app) && !(INTERPRETER.test(app) && name === app)) return name
  }
  return displayNameOf(heaviest.exe, heaviest.args)
}

/** The process doing the work in a tree: the heaviest one that isn't a shell (the outer process is often a shell) */
function heaviestOf(pids: number[], table: Map<number, Proc>): Proc {
  const procs = pids.map((pid) => table.get(pid) as Proc)
  const workers = procs.filter((proc) => !SHELL.test(appNameOf(proc.exe)))
  const weight = (proc: Proc) => proc.memoryBytes / SPLIT_BYTES + proc.cpuPercent / SPLIT_CPU
  return (workers.length > 0 ? workers : procs).reduce((a, b) => (weight(b) > weight(a) ? b : a))
}

function childrenOf(table: Map<number, Proc>): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const proc of table.values()) {
    // The kernel (pid 0) lists itself as its parent; skipping it keeps the tree free of loops
    if (proc.pid === proc.ppid) continue
    children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
  }
  return children
}

/** root and all its descendants; stops at a process in `stop` (another session), which counts on its own */
function subtree(root: number, children: Map<number, number[]>, stop: Set<number> = new Set()): number[] {
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid) || (pid !== root && stop.has(pid))) continue
    seen.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return [...seen]
}

/** pid itself and every parent above it */
function lineage(table: Map<number, Proc>, pid: number): Set<number> {
  const chain = new Set<number>()
  for (let at = table.get(pid); at !== undefined && !chain.has(at.pid); at = table.get(at.ppid)) chain.add(at.pid)
  return chain
}

function total(pids: number[], table: Map<number, Proc>): { memoryBytes: number; cpuPercent: number; stopped: number } {
  let memoryBytes = 0
  let cpuPercent = 0
  let stopped = 0
  for (const pid of pids) {
    const proc = table.get(pid) as Proc
    memoryBytes += proc.memoryBytes
    cpuPercent += proc.cpuPercent
    if (proc.stopped) stopped++
  }
  return { memoryBytes, cpuPercent, stopped }
}

export interface Ranking {
  groups: Group[]
  /** sessionId → that session's process and everything it started */
  sessionMemory: Map<string, number>
}

/**
 * sessions is null when the session list can't be read: then nothing tells which processes are sessions or which app
 * hosts one, so no app or process tree gets an end button; otherwise sessions and VS Code would pass for ordinary
 * programs hosting nothing.
 */
export function rank(table: Map<number, Proc>, sessions: SessionProc[] | null, ownPid: number): Ranking {
  const children = childrenOf(table)
  // The dashboard and its parents: paused or ended, the board is gone and nobody can press Resume
  const ownLine = lineage(table, ownPid)
  const live = (sessions ?? []).filter((s) => table.has(s.pid))
  const sessionPids = new Set(live.map((s) => s.pid))
  // What can be signalled: our own user's processes, outside the dashboard's own line
  const touchable = (pids: number[]) => pids.every((pid) => table.get(pid)?.uid === MY_UID && !ownLine.has(pid))
  const claimed = new Set<number>()
  const groups: Group[] = []
  const sessionMemory = new Map<string, number>()
  const folded: number[] = []
  for (const session of live) {
    const whole = subtree(session.pid, children, sessionPids)
    sessionMemory.set(session.sessionId, total(whole, table).memoryBytes)
    for (const pid of whole) claimed.add(pid)
    folded.push(session.pid)
    for (const child of children.get(session.pid) ?? []) {
      if (sessionPids.has(child)) continue
      const pids = subtree(child, children, sessionPids)
      const sum = total(pids, table)
      // A paused task gets its own row however small: folded into "Claude sessions" there would be nowhere to resume it
      if (sum.memoryBytes < SPLIT_BYTES && sum.cpuPercent < SPLIT_CPU && sum.stopped === 0) {
        folded.push(...pids)
        continue
      }
      // The dashboard running under this session (npx flightstrip from the session's terminal), or another user's
      // process in the tree (sudo): no buttons
      const free = touchable(pids)
      groups.push({
        key: `job:${child}`, name: jobNameOf(heaviestOf(pids, table), table, new Set(pids)), kind: 'job', ...sum,
        processes: pids.length, owner: session.name, killable: free, pausable: free, paused: sum.stopped > 0, hostedSessions: 0, pids,
      })
    }
  }
  if (folded.length > 0) {
    groups.push({
      key: 'sessions', name: serverT('hogs.sessionsName'), kind: 'sessions', ...total(folded, table),
      processes: folded.length, owner: null, killable: false, pausable: false, paused: false, hostedSessions: sessionMemory.size, pids: folded,
    })
  }

  // The rest: processes inside an .app fold into that app (VS Code's dozens of helpers are one thing); everything else
  // is one row per process tree, rooted at the highest ancestor that is likewise outside an .app, unclaimed and the same
  // user's. Not by name: processes that share a name (node, python) are usually unrelated programs, and one row for all
  // of them would end the unrelated ones along with the one you meant
  const unclaimed = (proc: Proc | undefined): proc is Proc => proc !== undefined && proc.pid > 1 && !claimed.has(proc.pid)
  const rootOf = (proc: Proc): Proc => {
    let root = proc
    const seen = new Set([proc.pid])
    for (let up = table.get(root.ppid); unclaimed(up) && !IN_APP.test(up.exe) && up.uid === proc.uid && !seen.has(up.pid); up = table.get(up.ppid)) {
      seen.add(up.pid)
      root = up
    }
    return root
  }
  const rows = new Map<string, number[]>()
  for (const proc of table.values()) {
    if (!unclaimed(proc)) continue
    const key = IN_APP.test(proc.exe) ? `app:${appNameOf(proc.exe)}` : `proc:${rootOf(proc).pid}`
    rows.set(key, [...(rows.get(key) ?? []), proc.pid])
  }
  // The dashboard itself gets no end button; an app hosting sessions (VS Code, a terminal) says in the confirmation how
  // many it takes along
  const sessionLines = live.map((s) => lineage(table, s.pid))
  for (const [key, pids] of rows) {
    const system = pids.some((pid) => (table.get(pid) as Proc).uid !== MY_UID || SYSTEM_PATH.test((table.get(pid) as Proc).exe))
    const sum = total(pids, table)
    const name = pids.includes(ownPid) ? serverT('hogs.selfName')
      : key.startsWith('app:') ? key.slice(4)
      : jobNameOf(heaviestOf(pids, table), table, new Set(pids))
    const free = !system && touchable(pids)
    groups.push({
      key, name, kind: system ? 'system' : 'app', ...sum, processes: pids.length, owner: null,
      killable: free && sessions !== null,
      // Apps don't get Pause (a paused app only shows a spinner); one holding a stopped process gets Resume: a task whose
      // session ended lands here, and without the button it would stay stopped forever
      pausable: free && sum.stopped > 0,
      paused: sum.stopped > 0,
      hostedSessions: sessionLines.filter((line) => pids.some((pid) => line.has(pid))).length, pids,
    })
  }
  groups.sort((a, b) => b.memoryBytes - a.memoryBytes)
  return { groups, sessionMemory }
}

/** The rows shown: the biggest by memory, then the CPU leaders, then anything paused */
export function listed(groups: Group[]): Hog[] {
  const byMemory = groups.filter((group) => group.memoryBytes >= LIST_MIN_BYTES).slice(0, MEMORY_LEADERS)
  const byCpu = groups
    .filter((group) => group.cpuPercent >= LIST_MIN_CPU && !byMemory.includes(group))
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, CPU_LEADERS)
  // A paused task must stay listed: stopped, it uses no CPU and its memory drifts out, so by the figures it would drop
  // off the ranking and leave no way to resume it
  const held = groups.filter((group) => group.paused && group.pausable && !byMemory.includes(group) && !byCpu.includes(group))
  return [...byMemory, ...byCpu, ...held].map(({ pids: _pids, ...hog }) => hog)
}

// ---------- sampling ----------

interface Sample extends Ranking {
  at: number
  table: Map<number, Proc>
}

let latest: Sample | null = null
let sampling: Promise<void> | null = null
// Goes up with every action: a sample that started before the action is dropped, or the ranking would briefly go back
// to how it was (a task just paused shown as running)
let generation = 0
// The names on the cards (renamed ones included), only for the "started by" line of a task row
let sessionNames = new Map<string, string>()

/** A fresh sample: the process table, the session list, the ranking */
async function measure(): Promise<Sample | null> {
  const [table, files] = await Promise.all([processes(), readSessionFiles()])
  if (table === null) return null
  // A session file's pid must still be the same process: when the pid was reused, the file is a leftover and that
  // process isn't a session
  const sessions = files === null ? null : files.flatMap((file): SessionProc[] => {
    const started = table.get(file.pid)?.started ?? null
    if (started === null || (file.procStart !== null && !sameStart(file.procStart, started))) return []
    return [{ sessionId: file.sessionId, pid: file.pid, name: sessionNames.get(file.sessionId) ?? String(file.row.name ?? '') }]
  })
  return { ...rank(table, sessions, process.pid), at: Date.now(), table }
}

async function sample(): Promise<void> {
  for (;;) {
    const started = generation
    const fresh = await measure()
    if (started !== generation) continue
    if (fresh !== null) latest = fresh
    return
  }
}

function refresh(): Promise<void> {
  // A failed sample (a session file we may not read, say) is logged and the previous ranking stays; it must not become
  // an unhandled rejection that takes the server down
  sampling ??= sample().catch((err) => console.warn('[hogs] sampling failed:', err)).finally(() => {
    sampling = null
  })
  return sampling
}

export interface HogReading {
  hogs: Hog[]
  sessionMemory: Map<string, number>
  /** One process's memory in that sample, counted as above; undefined for a process not running then */
  memoryOf: (pid: number) => number | undefined
}

/** The latest ranking; when it is stale a new sample starts in the background and this call returns the old one.
 *  null before the first sample. names: sessionId → the name on its card; null keeps the previous ones (this round
 *  couldn't list the sessions) */
export function readHogs(names: Map<string, string> | null, now = Date.now()): HogReading | null {
  if (config.demo) return { hogs: demoHogs(now, serverT), sessionMemory: new Map(), memoryOf: () => undefined }
  if (names !== null) sessionNames = names
  if (latest === null || now - latest.at >= SAMPLE_MS) void refresh()
  if (latest === null) return null
  const { table } = latest
  return { hogs: listed(latest.groups), sessionMemory: latest.sessionMemory, memoryOf: (pid) => table.get(pid)?.memoryBytes }
}

/** A fresh sample, for the alert: the ranking, biggest first */
export async function currentHogs(): Promise<Hog[]> {
  await refresh()
  return latest === null ? [] : listed(latest.groups)
}

export type HogAction = 'end' | 'pause' | 'resume'

/** Which signal goes to which processes.
 *  end: SIGTERM first so it can clean up; SIGKILL with force. An app gets it at its top processes only, so it exits
 *  normally and takes its children along; a task or process tree gets it across the whole tree (the outer shell doesn't
 *  always pass it on).
 *  pause / resume: SIGSTOP / SIGCONT across the tree. Pausing doesn't hand the memory back at once, but the task stops
 *  pulling its pages back in, so the system can give that memory to others; resuming carries on where it stopped */
export function planSignal(group: Group, table: Map<number, Proc>, action: HogAction, force: boolean): { targets: number[]; signal: NodeJS.Signals } {
  const inGroup = new Set(group.pids)
  const wholeTree = action !== 'end' || force || !group.key.startsWith('app:')
  const targets = wholeTree ? group.pids : group.pids.filter((pid) => !inGroup.has(table.get(pid)?.ppid ?? -1))
  const signal = action === 'pause' ? 'SIGSTOP' : action === 'resume' ? 'SIGCONT' : force ? 'SIGKILL' : 'SIGTERM'
  return { targets, signal }
}

type Kill = (pid: number, signal: NodeJS.Signals) => void

/** Signal each target. One that exited just now (ESRCH) isn't a failure; anything else (EPERM, no permission) is
 *  counted, never reported as done */
export function deliver(targets: number[], signal: NodeJS.Signals, table: Map<number, Proc>, kill: Kill = process.kill): { signalled: number; refused: number } {
  let signalled = 0
  let refused = 0
  for (const pid of targets) {
    try {
      kill(pid, signal)
      // A stopped process holds a SIGTERM without handling it; it has to be let go before it can exit
      if (signal === 'SIGTERM' && table.get(pid)?.stopped === true) kill(pid, 'SIGCONT')
      signalled++
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') refused++
    }
  }
  return { signalled, refused }
}

/** Act on a row of the ranking. seenName is the row's name when you pressed the button: when the freshly sampled row
 *  is now another program (a reused pid, a tree with a new root), nothing is done.
 *  The buttons were drawn from a ranking up to 15 seconds old, so this samples again first and judges permission and
 *  membership on what runs now: children started since then are paused too, processes gone since then aren't touched.
 *  Returns how many processes were signalled */
export async function signalHog(key: string, seenName: string | null, action: HogAction, force: boolean): Promise<number> {
  if (config.demo) {
    actOnDemoHog(key, action, Date.now(), serverT)
    return 1
  }
  const fresh = await measure()
  if (fresh === null) throw new ActionError(500, serverT('hogs.error.noProcesses'))
  const group = fresh.groups.find((candidate) => candidate.key === key)
  if (group === undefined) throw new ActionError(409, seenName === null ? serverT('hogs.error.gone') : serverT('hogs.error.ended', { name: seenName }))
  if (seenName !== null && group.name !== seenName) throw new ActionError(409, serverT('hogs.error.replaced', { name: seenName, now: group.name }))
  if (action === 'end' && !group.killable) throw new ActionError(403, serverT('hogs.error.notKillable', { name: group.name }))
  if (action !== 'end' && !group.pausable) throw new ActionError(403, serverT('hogs.error.notPausable', { name: group.name }))
  const { targets, signal } = planSignal(group, fresh.table, action, force)
  const { signalled, refused } = deliver(targets, signal, fresh.table)
  // Answer once the sample after the action is done: the board pushes right after the reply, and what it pushes is then
  // the state after the action (paused, one row fewer), not before
  generation++
  await refresh()
  if (refused > 0) {
    throw new ActionError(403, signalled > 0
      ? serverT('hogs.error.refusedPartly', { count: refused, done: signalled })
      : serverT('hogs.error.refused', { count: refused }))
  }
  if (signalled === 0) throw new ActionError(409, serverT('hogs.error.ended', { name: group.name }))
  return signalled
}
