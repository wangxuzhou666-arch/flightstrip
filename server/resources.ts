// Machine load for the header meters, and what each running background job is using for its line.
// Sampled at most every SAMPLE_MS, however often the snapshot is rebuilt (several times a second while sessions write).
// Machine: CPU from the change in os.cpus() times since the last sample; memory from vm_stat on macOS (what Activity
// Monitor calls Memory Used: app memory + wired + compressed, with its memory-pressure level), MemAvailable from
// /proc/meminfo on Linux, os.freemem() elsewhere; disk from statfs on the volume that holds the home directory.
// A job's processes: the ones holding its output file open for writing (the shell Claude Code started, and whatever it
// runs without redirecting), plus all their descendants, which also covers a command that writes to its own log.
// The holders are found with lsof once per job and kept while they live, so lsof doesn't run on every sample.
// A process that starts and ends between two samples is never seen, so a job that runs many short commands one after
// another reads low; a long-running process (a training run, a server, a big build step) is measured exactly.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath, statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, platform, totalmem } from 'node:os'
import type { JobUsage, MachineReading, MemoryPressure } from '../shared/types.ts'

const SAMPLE_MS = 3_000
const RUN_TIMEOUT_MS = 5_000
// A job whose output file no process held when last checked is checked again after this long, not on every sample
const HOLDERS_RECHECK_MS = 30_000
const findTool = (paths: string[], fallback: string) => paths.find((path) => existsSync(path)) ?? fallback
const PS = findTool(['/bin/ps', '/usr/bin/ps'], 'ps')
const LSOF = findTool(['/usr/sbin/lsof', '/usr/bin/lsof'], 'lsof')
// kern.memorystatus_vm_pressure_level, the level Activity Monitor's memory-pressure graph shows
export const DARWIN_PRESSURE: Record<string, MemoryPressure> = { 1: 'normal', 2: 'warn', 4: 'critical' }

/** stdout of a command, or null when it can't run, fails, or times out. lsof exits 1 when some file has no holder,
 *  and its output is still good, so the exit codes that still count as success are passed in */
function run(file: string, args: string[], okCodes: (number | string)[] = []): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      done(err === null || okCodes.includes(err.code ?? '') ? stdout : null)
    })
  })
}

// ---------- machine ----------

interface CpuTimes {
  idle: number
  total: number
}

function cpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const { times } of cpus()) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

// Taken when the server starts, so the first reading already has something to compare with
let lastCpu = cpuTimes()

/** Busy share of all cores together since the last call, 0–100 */
function cpuPercent(): number | null {
  const current = cpuTimes()
  const total = current.total - lastCpu.total
  const idle = current.idle - lastCpu.idle
  lastCpu = current
  return total > 0 ? Math.min(100, Math.max(0, (1 - idle / total) * 100)) : null
}

/** Activity Monitor's Memory Used from vm_stat's output: anonymous pages that can't be purged, wired pages and the
 *  compressor's pages. null when a line is missing (another macOS may name them differently) */
export function darwinMemoryUsed(vmStat: string): number | null {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1])
  const pages = (name: string) => Number(vmStat.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1])
  const used = pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')
  return Number.isFinite(used) && pageSize > 0 ? used * pageSize : null
}

/** Bytes in use from the "total = 8192.00M  used = 6740.00M  free = ..." of sysctl vm.swapusage */
export function parseSwapUsed(swapUsage: string): number | null {
  const match = /used = ([\d.]+)([KMG])/.exec(swapUsage)
  return match === null ? null : Number(match[1]) * 1024 ** ' KMG'.indexOf(match[2])
}

/** Swap in use from /proc/meminfo: SwapTotal minus SwapFree */
export function linuxSwapUsed(meminfo: string): number | null {
  const kb = (name: string) => Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'))?.[1])
  const used = kb('SwapTotal') - kb('SwapFree')
  return Number.isFinite(used) ? used * 1024 : null
}

/** Memory in use from /proc/meminfo: everything but what the kernel says is available without swapping */
export function linuxMemoryUsed(meminfo: string): number | null {
  const kb = (name: string) => Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'))?.[1])
  const used = kb('MemTotal') - kb('MemAvailable')
  return Number.isFinite(used) ? used * 1024 : null
}

async function memory(): Promise<MachineReading['memory']> {
  const total = totalmem()
  if (platform() === 'darwin') {
    const [stats, sysctl] = await Promise.all([
      run('/usr/bin/vm_stat', []),
      run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage']),
    ])
    const used = stats === null ? null : darwinMemoryUsed(stats)
    const [level = '', swap = ''] = (sysctl ?? '').split('\n')
    if (used !== null) return { usedBytes: used, totalBytes: total, pressure: DARWIN_PRESSURE[level.trim()] ?? null, swapUsedBytes: parseSwapUsed(swap) }
  }
  if (platform() === 'linux') {
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    const used = linuxMemoryUsed(meminfo)
    if (used !== null) return { usedBytes: used, totalBytes: total, pressure: null, swapUsedBytes: linuxSwapUsed(meminfo) }
  }
  // os.freemem() on macOS leaves out the cache the system hands back on demand, so it is only the last resort
  return { usedBytes: total - freemem(), totalBytes: total, pressure: null, swapUsedBytes: null }
}

async function disk(): Promise<MachineReading['disk']> {
  try {
    const stats = await statfs(homedir())
    // bavail, not bfree: the blocks reserved for root aren't free for you
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
  } catch {
    return null
  }
}

async function machine(now: number): Promise<MachineReading> {
  const [memoryReading, diskReading] = await Promise.all([memory(), disk()])
  return { at: now, cpuPercent: cpuPercent(), cores: cpus().length, memory: memoryReading, disk: diskReading }
}

// ---------- processes behind each job ----------

interface Proc {
  ppid: number
  /** CPU time used so far */
  cpuSeconds: number
  /** ps's own CPU figure, used when there is no earlier sample of the process to compare with */
  cpuPercent: number
  rssBytes: number
}

/** "[[dd-]hh:]mm:ss[.ss]", the TIME column of ps on macOS and Linux */
export function cpuSecondsOf(time: string): number {
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
  return Number(days) * 86_400 + clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

/** Every process on the machine; null when ps isn't there */
async function processTable(): Promise<Map<number, Proc> | null> {
  const out = await run(PS, ['-A', '-o', 'pid=,ppid=,pcpu=,rss=,time='])
  if (out === null) return null
  const table = new Map<number, Proc>()
  for (const line of out.split('\n')) {
    const [pid, ppid, pcpu, rss, time] = line.trim().split(/\s+/)
    if (time === undefined) continue
    table.set(Number(pid), { ppid: Number(ppid), cpuSeconds: cpuSecondsOf(time), cpuPercent: Number(pcpu), rssBytes: Number(rss) * 1024 })
  }
  return table
}

/** Which processes have each of these files open for writing, keyed by real path (what lsof reports); null when lsof
 *  can't run here */
async function writersOf(paths: string[]): Promise<Map<string, number[]> | null> {
  const out = await run(LSOF, ['-F', 'pan', '--', ...paths], [1])
  if (out === null) return null
  const writers = new Map<string, number[]>()
  let pid = 0
  let mode = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('f')) mode = ''
    else if (line.startsWith('a')) mode = line.slice(1)
    else if (line.startsWith('n') && /[wu]/.test(mode)) {
      const path = line.slice(1)
      writers.set(path, [...new Set([...(writers.get(path) ?? []), pid])])
    }
  }
  return writers
}

// output file → the processes last found writing it, and when that was checked
const holders = new Map<string, { pids: number[]; at: number }>()
// pid → its CPU time at the previous sample, for the CPU used in between
let lastProcCpu = new Map<number, number>()
// When that sample was taken, and which output files it covered
let lastSample: { at: number; paths: Set<string> } | null = null

/** The holders of each output file, from the cache while one of them still runs */
async function holdersOf(paths: string[], table: Map<number, Proc>, now: number): Promise<Map<string, number[]>> {
  for (const path of holders.keys()) if (!paths.includes(path)) holders.delete(path)
  const stale = paths.filter((path) => {
    const known = holders.get(path)
    if (known === undefined) return true
    if (known.pids.some((pid) => table.has(pid))) return false
    return now - known.at >= HOLDERS_RECHECK_MS
  })
  if (stale.length > 0) {
    const real = await Promise.all(stale.map((path) => realpath(path).catch(() => path)))
    const writers = await writersOf(real)
    // No lsof here: nothing to remember, and nothing will ever be found
    if (writers !== null) stale.forEach((path, i) => holders.set(path, { pids: writers.get(real[i]) ?? [], at: now }))
  }
  return new Map(paths.map((path) => [path, (holders.get(path)?.pids ?? []).filter((pid) => table.has(pid))]))
}

/** The processes and all their descendants */
function treeOf(roots: number[], table: Map<number, Proc>): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, proc] of table) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), pid])
  const seen = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return [...seen]
}

async function jobUsage(paths: string[], now: number): Promise<Map<string, JobUsage>> {
  const usage = new Map<string, JobUsage>()
  if (paths.length === 0) {
    holders.clear()
    lastProcCpu = new Map()
    lastSample = null
    return usage
  }
  const table = await processTable()
  if (table === null) return usage
  const roots = await holdersOf(paths, table, now)
  const previous = lastSample !== null && now > lastSample.at ? lastSample : null
  const sampled = new Map<number, number>()
  for (const [path, pids] of roots) {
    if (pids.length === 0) continue
    const tree = treeOf(pids, table)
    const followed = previous?.paths.has(path) === true
    let cpu = 0
    let memoryBytes = 0
    for (const pid of tree) {
      const proc = table.get(pid) as Proc
      const before = lastProcCpu.get(pid)
      // CPU over the time since the last sample, as Activity Monitor measures it. A process new to a job that was
      // already followed started in between, so all its CPU time falls in that stretch (a job that runs one short
      // command after another would otherwise never get a real figure). ps's own figure is only the first guess: it
      // averages over the process's life on Linux and ramps up slowly on macOS
      const spent = before !== undefined ? proc.cpuSeconds - before : followed ? proc.cpuSeconds : null
      cpu += spent !== null && previous !== null ? Math.max(0, (spent * 1000) / (now - previous.at)) * 100 : proc.cpuPercent
      memoryBytes += proc.rssBytes
      sampled.set(pid, proc.cpuSeconds)
    }
    usage.set(path, { cpuPercent: cpu, memoryBytes, processes: tree.length })
  }
  lastProcCpu = sampled
  lastSample = { at: now, paths: new Set(paths) }
  return usage
}

// ---------- sampling ----------

export interface Resources {
  machine: MachineReading
  /** output file of a running job → what its processes use; missing when they can't be found */
  jobs: Map<string, JobUsage>
}

let latest: Resources | null = null

/** The machine and the given running jobs' output files. Within SAMPLE_MS of the last sample the same reading comes
 *  back; a job that started in between gets its figures on the next one */
export async function sampleResources(paths: string[], now = Date.now()): Promise<Resources> {
  if (latest !== null && now - latest.machine.at < SAMPLE_MS) return latest
  const [machineReading, jobs] = await Promise.all([machine(now), jobUsage(paths, now)])
  latest = { machine: machineReading, jobs }
  return latest
}
