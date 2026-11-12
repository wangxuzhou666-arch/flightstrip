// The memory ranking: how processes fold into rows, and what each row may be asked to do.
//   H (ranking): top's memory column, application and script names (inline code named after its parent), a session's big
//     tasks split off with their owner,
//     paused tasks kept, the dashboard's own line and the system left without an end button, the CPU leaders added.
//   W (swap): the swap figure from sysctl on macOS and /proc/meminfo on Linux.
//   D (demo): pause, resume and end change only the in-memory demo ranking, under the same rules as the real one.
// The TypeScript is loaded through tsx, so this runs on every Node the package supports.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { userInfo } from 'node:os'
import { tsImport } from 'tsx/esm/api'

const { parseTopMemory, appNameOf, displayNameOf, rank, listed } = await tsImport('../server/hogs.ts', import.meta.url)
const { parseSwapUsed, linuxSwapUsed } = await tsImport('../server/resources.ts', import.meta.url)
const { demoHogs, actOnDemoHog } = await tsImport('../shared/demo.ts', import.meta.url)
const { translator } = await tsImport('../shared/i18n/index.ts', import.meta.url)

const MB = 1024 ** 2
const GB = 1024 ** 3
const ME = userInfo().uid
const VSCODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'

/** A process table as processes() builds it */
function table(rows) {
  return new Map(rows.map((row) => [row.pid, {
    ppid: 1, uid: ME, cpuPercent: 0, rssBytes: 0, stopped: false, args: row.exe, memoryBytes: 0, ...row,
  }]))
}

test('H1 top memory reads every unit and the +/- trend marks, and skips everything else', () => {
  const out = 'Processes: 512 total\nPID    MEM\n812    10G\n90     1064M+\n7      7473K-\n3      512B\nnot a row\n'
  assert.deepEqual([...parseTopMemory(out)], [[812, 10 * GB], [90, 1064 * MB], [7, 7473 * 1024], [3, 512]])
})

test('H2 a process is named after its app, and an interpreter after the script it runs', () => {
  assert.equal(appNameOf(VSCODE), 'Visual Studio Code')
  assert.equal(appNameOf('/Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper'), 'Google Chrome', 'the first .app wins')
  assert.equal(appNameOf('/usr/sbin/mDNSResponder'), 'mDNSResponder')
  assert.equal(displayNameOf('/opt/homebrew/bin/python3.12', 'python3.12 -u scripts/train.py --epochs 20'), 'train.py')
  assert.equal(displayNameOf('/usr/local/bin/node', 'node'), 'node', 'no script: the interpreter name stays')
  assert.equal(displayNameOf(VSCODE, 'Electron --type=renderer'), 'Visual Studio Code')
  assert.equal(displayNameOf('/opt/homebrew/bin/python3.12', 'python3.12 -u -c import sys;exec(eval(sys.stdin.readline()))'), 'python3.12',
    'inline code is not a script: its first word is no name')
  assert.equal(displayNameOf('/usr/local/bin/node', 'node -e console.log(1)'), 'node')
})

test('H3 a session folds with its small helpers; a big task splits off under its owner; a paused one always does', () => {
  const procs = table([
    { pid: 100, exe: VSCODE, memoryBytes: 900 * MB },
    { pid: 200, ppid: 100, exe: '/Users/me/.local/bin/claude', memoryBytes: 300 * MB },
    { pid: 210, ppid: 200, exe: '/opt/homebrew/bin/node', args: 'node mcp-server.js', memoryBytes: 60 * MB },
    // a training run started through a shell: the row is named after the worker, not the shell
    { pid: 220, ppid: 200, exe: '/bin/zsh', memoryBytes: 4 * MB },
    { pid: 221, ppid: 220, exe: '/opt/homebrew/bin/python3', args: 'python3 train.py', memoryBytes: 2 * GB, cpuPercent: 180 },
    // small but stopped: still its own row, or there would be nowhere to resume it
    { pid: 230, ppid: 200, exe: '/opt/homebrew/bin/node', args: 'node watch.js', memoryBytes: 20 * MB, stopped: true },
    { pid: 300, exe: '/System/Library/CoreServices/WindowServer', uid: 88, memoryBytes: 500 * MB },
    { pid: 400, ppid: 100, exe: '/opt/homebrew/bin/node', args: 'node dist/server.js', memoryBytes: 150 * MB },
  ])
  const { groups, sessionMemory } = rank(procs, [{ sessionId: 's1', name: 'Train the model', pid: 200 }], 400)
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]))

  assert.equal(sessionMemory.get('s1'), (300 + 60 + 4 + 20) * MB + 2 * GB, 'a session counts everything it started')
  assert.deepEqual(byKey['job:220'], {
    key: 'job:220', name: 'train.py', kind: 'job', memoryBytes: 4 * MB + 2 * GB, cpuPercent: 180, processes: 2,
    owner: 'Train the model', killable: true, pausable: true, paused: false, hostedSessions: 0, pids: [220, 221],
  })
  assert.equal(byKey['job:230'].paused, true)
  assert.equal(byKey.sessions.memoryBytes, (300 + 60) * MB, 'the session and its MCP server fold into one row')
  assert.equal(byKey.sessions.hostedSessions, 1)
  assert.equal(byKey['app:Visual Studio Code'].hostedSessions, 1, 'VS Code hosts the session, so ending it says so')
  assert.equal(byKey['app:Visual Studio Code'].killable, false, 'VS Code is a parent of the dashboard here, so it has no end button')
  assert.equal(byKey['app:WindowServer'].kind, 'system')
  assert.equal(byKey['app:WindowServer'].killable, false)
  const own = groups.find((group) => group.pids.includes(400))
  assert.equal(own.killable, false, 'the dashboard never offers to end itself')
  assert.deepEqual(groups.map((group) => group.memoryBytes), [...groups.map((group) => group.memoryBytes)].sort((a, b) => b - a), 'biggest first')
})

test('H4 the shown rows: the biggest by memory, then the CPU leaders a memory ranking leaves out, then anything paused', () => {
  const row = (key, memoryBytes, cpuPercent = 0, paused = false) => ({
    key, name: key, kind: 'app', memoryBytes, cpuPercent, processes: 1, owner: null, killable: true, pausable: false, paused, hostedSessions: 0, pids: [1],
  })
  const groups = [
    ...Array.from({ length: 10 }, (_, i) => row(`big${i}`, (2000 - i) * MB)),
    row('indexer', 40 * MB, 95),
    row('tiny', 5 * MB),
    row('held', 1 * MB, 0, true),
  ]
  const keys = listed(groups).map((hog) => hog.key)
  assert.deepEqual(keys, ['big0', 'big1', 'big2', 'big3', 'big4', 'big5', 'big6', 'big7', 'indexer', 'held'])
  assert.equal('pids' in listed(groups)[0], false, 'pids stay on the server')
})

test('H5 a task whose heaviest process runs inline code is named after the nearest ancestor that says what it is', () => {
  const PY = '/opt/homebrew/bin/python3.12'
  const XDIST = 'python3.12 -u -c import sys;exec(eval(sys.stdin.readline()))'
  const procs = table([
    { pid: 200, exe: '/Users/me/.local/bin/claude', memoryBytes: 300 * MB },
    // a test gate: shell → pytest → six xdist workers, each heavier than pytest itself
    { pid: 300, ppid: 200, exe: '/bin/zsh', memoryBytes: 4 * MB },
    { pid: 310, ppid: 300, exe: PY, args: 'python3.12 .venv/bin/pytest tests -n 6', memoryBytes: 300 * MB },
    ...Array.from({ length: 6 }, (_, i) => ({ pid: 320 + i, ppid: 310, exe: PY, args: XDIST, memoryBytes: (500 + i) * MB })),
    // inline code with nothing named above it but the shell: the interpreter name, never the code's first word
    { pid: 400, ppid: 200, exe: '/bin/zsh', memoryBytes: 4 * MB },
    { pid: 410, ppid: 400, exe: PY, args: 'python3.12 -c import json,sys; print(1)', memoryBytes: 400 * MB },
  ])
  const { groups } = rank(procs, [{ sessionId: 's1', name: 'Run the gate', pid: 200 }], 999)
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]))
  assert.equal(byKey['job:300'].name, 'pytest')
  assert.equal(byKey['job:300'].processes, 8)
  assert.equal(byKey['job:400'].name, 'python3.12')
})

test('W1 swap in use, from sysctl vm.swapusage and from /proc/meminfo', () => {
  assert.equal(parseSwapUsed('total = 8192.00M  used = 6740.50M  free = 1451.50M  (encrypted)'), 6740.5 * MB)
  assert.equal(parseSwapUsed('total = 2.00G  used = 1.25G  free = 0.75G'), 1.25 * GB)
  assert.equal(parseSwapUsed('no swap here'), null)
  assert.equal(linuxSwapUsed('MemTotal: 100 kB\nSwapTotal:     2097148 kB\nSwapFree:      1048574 kB\n'), (2097148 - 1048574) * 1024)
  assert.equal(linuxSwapUsed('MemTotal: 100 kB\n'), null)
})

test('D1 the demo ranking pauses, resumes and ends in memory, refusing what the real one refuses', () => {
  const t = translator('en')
  const now = Date.now()
  const job = demoHogs(now, t).find((hog) => hog.kind === 'job')
  assert.equal(job.paused, false)
  actOnDemoHog(job.key, 'pause', now, t)
  const paused = demoHogs(now, t).find((hog) => hog.key === job.key)
  assert.equal(paused.paused, true)
  assert.equal(paused.cpuPercent, 0, 'a paused task uses no CPU')
  actOnDemoHog(job.key, 'resume', now, t)
  assert.equal(demoHogs(now, t).find((hog) => hog.key === job.key).paused, false)

  const app = demoHogs(now, t).find((hog) => hog.kind === 'app')
  assert.throws(() => actOnDemoHog(app.key, 'pause', now, t), (err) => err.status === 403, 'an app cannot be paused')
  const system = demoHogs(now, t).find((hog) => hog.kind === 'system')
  assert.throws(() => actOnDemoHog(system.key, 'end', now, t), (err) => err.status === 403, 'a system process cannot be ended')
  assert.throws(() => actOnDemoHog('app:nothing', 'end', now, t), (err) => err.status === 404)

  actOnDemoHog(app.key, 'end', now, t)
  assert.equal(demoHogs(now, t).some((hog) => hog.key === app.key), false, 'an ended row leaves the ranking')
  assert.equal(demoHogs(now, translator('zh')).find((hog) => hog.kind === 'sessions').name, 'Claude 会话', 'the folded row is named in the page language')
})
