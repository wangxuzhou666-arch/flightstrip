// The memory ranking: how processes fold into rows, and what each row may be asked to do.
//   H (ranking): top's memory column, application and script names (inline code named after its parent), a session's big
//     tasks split off with their owner,
//     paused tasks kept, the dashboard's own line and the system left without an end button, the CPU leaders added;
//     processes outside an app grouped by process tree, no buttons without a session list, the dashboard inside a task,
//     another user's process, stranded paused processes, sessions inside sessions, Linux paths.
//   S (signals): which processes get which signal, and what counts as refused.
//   W (swap): the swap figure from sysctl on macOS and /proc/meminfo on Linux.
//   D (demo): pause, resume and end change only the in-memory demo ranking, under the same rules as the real one.
// The TypeScript is loaded through tsx, so this runs on every Node the package supports.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { userInfo } from 'node:os'
import { tsImport } from 'tsx/esm/api'

const { parseTopMemory, appNameOf, displayNameOf, rank, listed, planSignal, deliver, linuxPath } = await tsImport('../server/hogs.ts', import.meta.url)
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
    key: 'job:220', name: 'train.py', kind: 'job', memoryBytes: 4 * MB + 2 * GB, cpuPercent: 180, processes: 2, stopped: 0,
    owner: 'Train the model', killable: true, pausable: true, paused: false, hostedSessions: 0, pids: [220, 221],
  })
  assert.equal(byKey['job:230'].paused, true)
  assert.equal(byKey.sessions.memoryBytes, (300 + 60) * MB, 'the session and its MCP server fold into one row')
  assert.equal(byKey.sessions.hostedSessions, 1)
  assert.equal(byKey['app:Visual Studio Code'].hostedSessions, 1, 'VS Code hosts the session, so ending it says so')
  assert.equal(byKey['app:Visual Studio Code'].killable, false, 'VS Code is a parent of the dashboard here, so it has no end button')
  // not in an .app: grouped by its process tree, keyed by the tree's root
  assert.equal(byKey['proc:300'].name, 'WindowServer')
  assert.equal(byKey['proc:300'].kind, 'system')
  assert.equal(byKey['proc:300'].killable, false)
  const own = groups.find((group) => group.pids.includes(400))
  assert.equal(own.killable, false, 'the dashboard never offers to end itself')
  assert.deepEqual(groups.map((group) => group.memoryBytes), [...groups.map((group) => group.memoryBytes)].sort((a, b) => b - a), 'biggest first')
})

test('H4 the shown rows: the biggest by memory, then the CPU leaders a memory ranking leaves out, then anything paused', () => {
  const row = (key, memoryBytes, cpuPercent = 0, paused = false) => ({
    // a row holding stopped processes always offers resume, so it is pausable
    key, name: key, kind: 'app', memoryBytes, cpuPercent, processes: 1, stopped: paused ? 1 : 0, owner: null, killable: true, pausable: paused, paused, hostedSessions: 0, pids: [1],
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

const HELPER = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'
const CLAUDE = '/Users/me/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude'
const NODE = '/opt/homebrew/bin/node'
const PY = '/Users/me/.venv/bin/python3.12'
const DASHBOARD = 999

/** VS Code running one session, which started a 2 GB training run; the dashboard runs on its own */
function desk() {
  return table([
    { pid: 1, ppid: 0, exe: '/sbin/launchd', memoryBytes: 20 * MB, uid: 0 },
    { pid: 10, exe: VSCODE, memoryBytes: 400 * MB },
    { pid: 11, ppid: 10, exe: HELPER, memoryBytes: 600 * MB },
    { pid: 100, ppid: 11, exe: CLAUDE, args: 'claude', memoryBytes: 300 * MB },
    { pid: 200, ppid: 100, exe: '/bin/zsh', args: '/bin/zsh -c python train.py', memoryBytes: 2 * MB },
    { pid: 201, ppid: 200, exe: PY, args: `${PY} train.py`, memoryBytes: 2 * GB },
    { pid: DASHBOARD, exe: NODE, args: `${NODE} dist/server.js`, memoryBytes: 150 * MB },
  ])
}
const SESSION = [{ sessionId: 's1', name: 'Train', pid: 100 }]
const keyed = (groups) => Object.fromEntries(groups.map((group) => [group.key, group]))

// The alert samples even when no board is open, and then there is no session list: the claude process and the VS Code
// holding it must not turn into ordinary programs with an end button
test('H6 with no session list, no app or process tree gets an end button', () => {
  const { groups } = rank(desk(), null, DASHBOARD)
  for (const group of groups) assert.equal(group.killable, false, group.name)
  assert.equal(keyed(groups)['app:Visual Studio Code'].hostedSessions, 0)
})

test('H7 with the sessions known: the task is its own pausable row, and VS Code says how many sessions it holds', () => {
  const byKey = keyed(rank(desk(), SESSION, DASHBOARD).groups)
  assert.equal(byKey['job:200'].name, 'train.py')
  assert.equal(byKey['job:200'].pausable, true)
  assert.equal(byKey['app:Visual Studio Code'].killable, true)
  assert.equal(byKey['app:Visual Studio Code'].hostedSessions, 1)
  assert.equal(byKey[`proc:${DASHBOARD}`].killable, false, 'the dashboard\'s own tree')
})

// npx flightstrip started from a session's terminal: the dashboard is inside the task, and pausing it would leave
// nobody to press resume
test('H8 a task with the dashboard inside it offers neither pause nor end', () => {
  const procs = desk()
  procs.get(DASHBOARD).ppid = 201
  const job = keyed(rank(procs, SESSION, DASHBOARD).groups)['job:200']
  assert.equal(job.pausable, false)
  assert.equal(job.killable, false)
})

test('H9 a task with another user\'s process in it (sudo) gets no buttons', () => {
  const procs = desk()
  procs.set(202, { ...procs.get(201), pid: 202, ppid: 201, exe: '/usr/bin/sudo', args: 'sudo make install', uid: 0, memoryBytes: 400 * MB })
  const job = keyed(rank(procs, SESSION, DASHBOARD).groups)['job:200']
  assert.equal(job.killable, false)
  assert.equal(job.pausable, false)
})

// Grouping by name merged two unrelated node servers into one row, and ending it took both
test('H10 processes outside an app split by process tree, never by name; one .app stays one row', () => {
  const procs = desk()
  for (const row of [
    { pid: 300, exe: NODE, args: `${NODE} vite`, memoryBytes: 200 * MB },
    { pid: 301, ppid: 300, exe: NODE, args: `${NODE} esbuild-worker.js`, memoryBytes: 150 * MB },
    { pid: 400, exe: NODE, args: `${NODE} other-server.js`, memoryBytes: 180 * MB },
  ]) procs.set(row.pid, { ...procs.get(DASHBOARD), ...row })
  const byKey = keyed(rank(procs, SESSION, DASHBOARD).groups)
  assert.equal(byKey['proc:300'].processes, 2)
  assert.equal(byKey['proc:400'].name, 'other-server.js')
  assert.equal(byKey['app:Visual Studio Code'].processes, 2)
})

// The session ended first and launchd adopted its paused task: it still needs a resume button, or it stays stopped
test('H11 a paused process nobody owns offers resume and stays listed', () => {
  const procs = desk()
  procs.set(500, { ...procs.get(201), pid: 500, ppid: 1, memoryBytes: 50 * MB, stopped: true })
  const groups = rank(procs, SESSION, DASHBOARD).groups
  const row = keyed(groups)['proc:500']
  assert.deepEqual([row.pausable, row.paused, row.stopped], [true, true, 1])
  assert.ok(listed(groups).some((hog) => hog.key === 'proc:500'), 'kept however small')
  assert.equal(keyed(rank(desk(), SESSION, DASHBOARD).groups)[`proc:${DASHBOARD}`].pausable, false, 'nothing stopped: no resume')
})

test('H12 a session started inside another session\'s task: the outer task leaves it out', () => {
  const procs = desk()
  procs.set(600, { ...procs.get(100), pid: 600, ppid: 201, args: 'claude -p', memoryBytes: 350 * MB })
  procs.set(601, { ...procs.get(201), pid: 601, ppid: 600, args: `${PY} big.py`, memoryBytes: 900 * MB })
  const { groups, sessionMemory } = rank(procs, [...SESSION, { sessionId: 's2', name: 'Inner', pid: 600 }], DASHBOARD)
  const byKey = keyed(groups)
  assert.equal(byKey['job:200'].processes, 2)
  assert.equal(byKey['job:601'].owner, 'Inner')
  assert.equal(sessionMemory.get('s2'), 1250 * MB)
})

// On Linux ps only gives a 15-character name, so the system rule needs the path from /proc/<pid>/exe; where that can't
// be read (not our process, or no /proc), the command line's first word if it is a path
test('H13 Linux: the path falls back to the command line, and /usr, /lib and /bin count as the system but /usr/local does not', async () => {
  const gone = 2 ** 30
  assert.equal(await linuxPath(gone, 'gnome-shell', '/usr/bin/gnome-shell --wayland'), '/usr/bin/gnome-shell')
  assert.equal(await linuxPath(gone, 'node', 'node server.js'), 'node')
  const procs = table([
    { pid: 2, exe: '/usr/bin/gnome-shell' },
    { pid: 3, exe: '/lib/systemd/systemd', args: '/lib/systemd/systemd --user' },
    { pid: 4, exe: '/usr/local/bin/node', args: 'node app.js' },
    { pid: 5, exe: '/home/me/.local/bin/tool' },
  ])
  const byKey = keyed(rank(procs, [], DASHBOARD).groups)
  assert.deepEqual(['proc:2', 'proc:3', 'proc:4', 'proc:5'].map((key) => byKey[key].kind), ['system', 'system', 'app', 'app'])
})

test('S1 ending an app signals its top processes only; a task or process tree, pausing and forcing reach the whole tree', () => {
  const procs = desk()
  const byKey = keyed(rank(procs, SESSION, DASHBOARD).groups)
  const code = byKey['app:Visual Studio Code']
  assert.deepEqual(planSignal(code, procs, 'end', false), { targets: [10], signal: 'SIGTERM' })
  assert.deepEqual(planSignal(code, procs, 'end', true).targets.sort((a, b) => a - b), [10, 11])
  assert.equal(planSignal(code, procs, 'end', true).signal, 'SIGKILL')
  const job = byKey['job:200']
  assert.deepEqual(planSignal(job, procs, 'pause', false), { targets: job.pids, signal: 'SIGSTOP' })
  assert.deepEqual(planSignal(job, procs, 'end', false), { targets: job.pids, signal: 'SIGTERM' })
  assert.deepEqual(planSignal(job, procs, 'resume', false), { targets: job.pids, signal: 'SIGCONT' })
})

test('S2 no permission is reported, a process that just exited is no failure, and a stopped one is let go after SIGTERM', () => {
  const procs = desk()
  procs.get(201).stopped = true
  const sent = []
  const kill = (pid, signal) => {
    if (pid === 7) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    if (pid === 8) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    sent.push(`${pid}:${signal}`)
  }
  assert.deepEqual(deliver([201, 7, 8], 'SIGTERM', procs, kill), { signalled: 1, refused: 1 })
  assert.deepEqual(sent, ['201:SIGTERM', '201:SIGCONT'])
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
  assert.throws(() => actOnDemoHog('app:nothing', 'end', now, t), (err) => err.status === 409, 'a row gone from the ranking is a conflict, like the real one')

  actOnDemoHog(app.key, 'end', now, t)
  assert.equal(demoHogs(now, t).some((hog) => hog.key === app.key), false, 'an ended row leaves the ranking')
  assert.equal(demoHogs(now, translator('zh')).find((hog) => hog.kind === 'sessions').name, 'Claude 会话', 'the folded row is named in the page language')
})
