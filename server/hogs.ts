// The memory ranking: what uses the most memory and CPU on this machine, and ending or pausing it from the board.
// Memory is top's MEM column (the same figure as Activity Monitor's Memory column, including compressed and swapped-out
// pages), not ps's RSS: when memory is tight the big processes have most of their pages compressed or swapped out, and
// RSS is left with a fraction (measured 2026-11-11: an inference process holding 10 GB showed 78 MB of RSS). Where
// `top -l` doesn't exist (Linux), RSS is what there is.
// Processes are folded into a few kinds: every process of one .app is one application; each big task a Claude session
// started gets its own row (so it can be paused or ended alone); the sessions themselves and their small helpers (MCP
// servers, shells) fold into one "Claude sessions" row, and each session's own figure goes on its card.
// top takes a second or two, so the ranking refreshes in the background and a snapshot takes the previous result.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import { ActionError } from '../shared/actionError.ts'
import { actOnDemoHog, demoHogs } from '../shared/demo.ts'
import type { Hog } from '../shared/types.ts'
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
// /System/Applications holds ordinary apps (Preview, Notes) and doesn't count
const SYSTEM_PATH = /^\/(?:System\/(?!Applications\/)|usr\/|sbin\/|bin\/|Library\/Apple\/)/
const MY_UID = userInfo().uid
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
  /** Full path of the executable (macOS); the short name on Linux */
  exe: string
  args: string
  /** What top reports; RSS when top can't run */
  memoryBytes: number
}

interface Group extends Hog {
  pids: number[]
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => done(err === null ? stdout : null))
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

async function processes(): Promise<Map<number, Proc> | null> {
  // comm and args can both hold spaces, so each is the last column of its own ps call
  const [byExe, byArgs, top] = await Promise.all([
    run(PS, ['-A', '-o', 'pid=,ppid=,uid=,pcpu=,rss=,state=,comm=']),
    run(PS, ['-A', '-o', 'pid=,args=']),
    run(TOP, ['-l', '1', '-stats', 'pid,mem']),
  ])
  if (byExe === null) return null
  const args = new Map<number, string>()
  for (const line of (byArgs ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match !== null) args.set(Number(match[1]), match[2])
  }
  const memory = top === null ? new Map<number, number>() : parseTopMemory(top)
  const table = new Map<number, Proc>()
  for (const line of byExe.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const rssBytes = Number(match[5]) * 1024
    table.set(pid, {
      pid, ppid: Number(match[2]), uid: Number(match[3]), cpuPercent: Number(match[4]), rssBytes,
      // ps's state column starts with T for a stopped process
      stopped: match[6].startsWith('T'),
      exe: match[7], args: args.get(pid) ?? match[7], memoryBytes: memory.get(pid) ?? rssBytes,
    })
  }
  return table
}

/** The application a process belongs to: the first .app in its path; outside an .app, the executable's name */
export function appNameOf(exe: string): string {
  const app = /\/([^/]+)\.app\//.exec(exe)
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
 * A session task's row name. When the heaviest process's own name says nothing (a shell, or an interpreter running
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

function childrenOf(table: Map<number, Proc>): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const proc of table.values()) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
  return children
}

function subtree(root: number, children: Map<number, number[]>): number[] {
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return [...seen]
}

function total(pids: number[], table: Map<number, Proc>): { memoryBytes: number; cpuPercent: number } {
  let memoryBytes = 0
  let cpuPercent = 0
  for (const pid of pids) {
    const proc = table.get(pid) as Proc
    memoryBytes += proc.memoryBytes
    cpuPercent += proc.cpuPercent
  }
  return { memoryBytes, cpuPercent }
}

interface Ranking {
  groups: Group[]
  /** sessionId → that session's process and everything it started */
  sessionMemory: Map<string, number>
}

export function rank(table: Map<number, Proc>, sessions: SessionProc[], ownPid: number): Ranking {
  const children = childrenOf(table)
  const claimed = new Set<number>()
  const groups: Group[] = []
  const sessionMemory = new Map<string, number>()
  const folded: number[] = []
  for (const session of sessions.filter((s) => table.has(s.pid))) {
    const whole = subtree(session.pid, children)
    sessionMemory.set(session.sessionId, total(whole, table).memoryBytes)
    for (const pid of whole) claimed.add(pid)
    folded.push(session.pid)
    for (const child of children.get(session.pid) ?? []) {
      const pids = subtree(child, children)
      const sum = total(pids, table)
      // A paused task gets its own row however small: folded into "Claude sessions" there would be nowhere to resume it
      const stopped = pids.some((pid) => table.get(pid)?.stopped === true)
      if (sum.memoryBytes < SPLIT_BYTES && sum.cpuPercent < SPLIT_CPU && !stopped) {
        folded.push(...pids)
        continue
      }
      // The outer process is often a shell; the row is named after the one doing the work: the heaviest non-shell process
      const procs = pids.map((pid) => table.get(pid) as Proc)
      const workers = procs.filter((proc) => !SHELL.test(appNameOf(proc.exe)))
      const weight = (proc: Proc) => proc.memoryBytes / SPLIT_BYTES + proc.cpuPercent / SPLIT_CPU
      const heaviest = (workers.length > 0 ? workers : procs).reduce((a, b) => (weight(b) > weight(a) ? b : a))
      groups.push({
        key: `job:${child}`, name: jobNameOf(heaviest, table, new Set(pids)), kind: 'job', ...sum,
        processes: pids.length, owner: session.name, killable: true, pausable: true, paused: stopped, hostedSessions: 0, pids,
      })
    }
  }
  if (folded.length > 0) {
    groups.push({
      key: 'sessions', name: serverT('hogs.sessionsName'), kind: 'sessions', ...total(folded, table),
      processes: folded.length, owner: null, killable: false, pausable: false, paused: false, hostedSessions: sessionMemory.size, pids: folded,
    })
  }

  // The dashboard itself and its parents get no end button; an app hosting sessions (VS Code, a terminal) says in the
  // confirmation how many it takes along
  const lineage = (pid: number): Set<number> => {
    const chain = new Set<number>()
    for (let at = table.get(pid); at !== undefined && !chain.has(at.pid); at = table.get(at.ppid)) chain.add(at.pid)
    return chain
  }
  const ownLine = lineage(ownPid)
  const sessionLines = sessions.filter((s) => table.has(s.pid)).map((s) => lineage(s.pid))
  const apps = new Map<string, Proc[]>()
  for (const proc of table.values()) {
    if (claimed.has(proc.pid)) continue
    const name = proc.pid === ownPid ? serverT('hogs.selfName') : displayNameOf(proc.exe, proc.args)
    apps.set(name, [...(apps.get(name) ?? []), proc])
  }
  for (const [name, procs] of apps) {
    const pids = procs.map((proc) => proc.pid)
    const system = procs.some((proc) => proc.uid !== MY_UID || SYSTEM_PATH.test(proc.exe))
    groups.push({
      key: `app:${name}`, name, kind: system ? 'system' : 'app', ...total(pids, table), processes: pids.length, owner: null,
      killable: !system && !pids.some((pid) => ownLine.has(pid)), pausable: false, paused: false,
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
  const held = groups.filter((group) => group.paused && !byMemory.includes(group) && !byCpu.includes(group))
  return [...byMemory, ...byCpu, ...held].map(({ pids: _pids, ...hog }) => hog)
}

// ---------- sampling ----------

let latest: (Ranking & { at: number; table: Map<number, Proc> }) | null = null
let sampling: Promise<void> | null = null
let knownSessions: SessionProc[] = []

async function sample(): Promise<void> {
  const table = await processes()
  if (table !== null) latest = { ...rank(table, knownSessions, process.pid), at: Date.now(), table }
}

function refresh(): Promise<void> {
  sampling ??= sample().finally(() => {
    sampling = null
  })
  return sampling
}

export interface HogReading {
  hogs: Hog[]
  sessionMemory: Map<string, number>
}

/** The latest ranking; when it is stale a new sample starts in the background and this call returns the old one.
 *  null before the first sample */
export function readHogs(sessions: SessionProc[], now = Date.now()): HogReading | null {
  if (config.demo) return { hogs: demoHogs(now, serverT), sessionMemory: new Map() }
  knownSessions = sessions
  if (latest === null || now - latest.at >= SAMPLE_MS) void refresh()
  return latest === null ? null : { hogs: listed(latest.groups), sessionMemory: latest.sessionMemory }
}

/** A fresh sample, for the alert: the biggest row */
export async function topHog(): Promise<Hog | null> {
  await refresh()
  return latest === null ? null : (listed(latest.groups)[0] ?? null)
}

export type HogAction = 'end' | 'pause' | 'resume'

/** Act on a row of the ranking.
 *  end: SIGTERM first so it can clean up; SIGKILL with force.
 *  pause / resume: SIGSTOP / SIGCONT, only for tasks a session started. Pausing doesn't hand the memory back at once,
 *  but the task stops pulling its pages back in, so the system can give that memory to others; resuming carries on
 *  where it stopped.
 *  Returns how many processes were signalled */
export async function signalHog(key: string, action: HogAction, force: boolean): Promise<number> {
  if (config.demo) {
    actOnDemoHog(key, action, Date.now(), serverT)
    return 1
  }
  const group = latest?.groups.find((candidate) => candidate.key === key)
  if (group === undefined) throw new ActionError(404, serverT('hogs.error.gone'))
  if (action === 'end' && !group.killable) throw new ActionError(403, serverT('hogs.error.notKillable', { name: group.name }))
  if (action !== 'end' && !group.pausable) throw new ActionError(403, serverT('hogs.error.notPausable', { name: group.name }))
  // The ranking is up to a few seconds old: signal only processes that are still there and still the same program,
  // and skip a pid that another process has taken over
  const sampled = latest?.table as Map<number, Proc>
  const current = await processes()
  if (current === null) throw new ActionError(500, serverT('hogs.error.noProcesses'))
  const alive = group.pids.filter((pid) => current.get(pid)?.exe === sampled.get(pid)?.exe)
  if (alive.length === 0) throw new ActionError(409, serverT('hogs.error.ended', { name: group.name }))
  // An app gets the signal at its top processes only, so it exits normally and takes its children along; a task gets
  // it across the whole tree (the outer shell doesn't always pass it on)
  const inGroup = new Set(alive)
  const wholeTree = group.kind === 'job' || force
  const targets = wholeTree ? alive : alive.filter((pid) => !inGroup.has(current.get(pid)?.ppid ?? -1))
  const signal = action === 'pause' ? 'SIGSTOP' : action === 'resume' ? 'SIGCONT' : force ? 'SIGKILL' : 'SIGTERM'
  let signalled = 0
  for (const pid of targets) {
    try {
      process.kill(pid, signal)
      // A stopped process holds a SIGTERM without handling it; it has to be let go before it can exit
      if (action === 'end' && !force && current.get(pid)?.stopped === true) process.kill(pid, 'SIGCONT')
      signalled++
    } catch {
      // It exited on its own just now
    }
  }
  latest = null
  void refresh()
  return signalled
}
