// The data pipeline: when a background job counts as ended, bad page addresses, where "running for" starts, reading
// Haiku's names, and telling a live session process from a reused pid.
//   J (jobs): TaskStop ends a job; quiet output with nobody writing it ends one, a process still writing keeps it
//     running; an exit line gives the status.
//   P (pages): an address with an impossible port is skipped, not a crash.
//   T (time): the current state counts from the last unbroken run; a permission approval doesn't start a new turn.
//   N (names): Haiku's numbered lines are matched by number.
//   A (agents): a recorded process start that doesn't match is another process; subagents that went quiet aren't running.
// HOME, CLAUDE_CONFIG_DIR and FLIGHTSTRIP_STATE_DIR point at a temp dir, so the real ~/.claude and ~/.flightstrip are
// never read. The TypeScript is loaded through tsx, so this runs on every Node the package supports.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { tsImport } from 'tsx/esm/api'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'fs-pipeline-')))
mkdirSync(join(home, '.claude'), { recursive: true })
mkdirSync(join(home, 'state'), { recursive: true })
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
process.env.FLIGHTSTRIP_STATE_DIR = join(home, 'state')

const { digestTranscript, readSubagents } = await tsImport('../server/transcript.ts', import.meta.url)
const { jobsOf, pagesOf } = await tsImport('../server/jobs.ts', import.meta.url)
const { stateSinceOf, nextTurn } = await tsImport('../server/collect.ts', import.meta.url)
const { parseNames } = await tsImport('../server/brief.ts', import.meta.url)
const { parseStarts, sameStart } = await tsImport('../server/agents.ts', import.meta.url)

const children = []
after(() => {
  for (const child of children) child.kill()
  rmSync(home, { recursive: true, force: true })
})

const MIN = 60_000
const at = (ms) => new Date(ms).toISOString()

function transcript(sessionId, rows) {
  const dir = join(home, '.claude', 'projects', '-tmp-lane')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function outputFile(name, text, quietMs) {
  const path = join(home, name)
  writeFileSync(path, text)
  const when = (Date.now() - quietMs) / 1000
  utimesSync(path, when, when)
  return path
}

const rawJob = (id, outputPath) => ({ id, description: id, command: id, startedAt: Date.now() - 60 * MIN, outputPath, status: null, endedAt: null })
const same = (description) => description

// Seen 2026-11-11: a job stopped with TaskStop sometimes gets neither a notice nor a [killed] line, and showed as running
test('J1 a TaskStop result marks its job stopped', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const t0 = Date.now() - 30 * MIN
  transcript(id, [
    { type: 'assistant', timestamp: at(t0), message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'npx tsx server/index.ts', description: 'Start dev server', run_in_background: true } }] } },
    { type: 'user', timestamp: at(t0 + 1000), toolUseResult: { backgroundTaskId: 'bjob1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Command running in background with ID: bjob1. Output is being written to: /tmp/none.output' }] } },
    { type: 'assistant', timestamp: at(t0 + 60_000), message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'TaskStop', input: { task_id: 'bjob1' } }] } },
    { type: 'user', timestamp: at(t0 + 61_000), toolUseResult: { message: 'Successfully stopped task: bjob1 (npx tsx server/index.ts)', task_id: 'bjob1', task_type: 'local_bash' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: '{"message":"Successfully stopped task: bjob1"}' }] } },
  ])
  const digest = await digestTranscript(id)
  assert.equal(digest?.jobs.bjob1?.status, 'stopped')
  assert.equal(digest?.jobs.bjob1?.endedAt, t0 + 61_000)
})

// A job taken down by a session restart: its output stopped, it has no exit line, and nothing writes the file any more
test('J2 a job whose output went quiet with nobody writing it is stopped; one a process still writes keeps running', async () => {
  const orphan = outputFile('orphan.output', 'step 3/8\n', 5 * MIN)
  const silent = outputFile('silent.output', 'waiting for requests\n', 0)
  const writer = spawn('/bin/sh', ['-c', `exec sleep 30 >> '${silent}'`], { stdio: 'ignore' })
  children.push(writer)
  await new Promise((done) => setTimeout(done, 300))
  utimesSync(silent, (Date.now() - 5 * MIN) / 1000, (Date.now() - 5 * MIN) / 1000)
  const fresh = outputFile('fresh.output', 'epoch 1/20\n', 0)
  const jobs = await jobsOf({ orphan: rawJob('orphan', orphan), silent: rawJob('silent', silent), fresh: rawJob('fresh', fresh) }, same)
  assert.deepEqual(Object.fromEntries(jobs.map((job) => [job.id, job.status])), { orphan: 'stopped', silent: 'running', fresh: 'running' })
})

test('J3 an exit line with nobody writing the file gives the status', async () => {
  const [job] = await jobsOf({ done: rawJob('done', outputFile('done.output', 'ok\n[exited with code 1]\n', 0)) }, same)
  assert.equal(job.status, 'failed')
})

// new URL used to throw here and the whole strip failed to read
test('P1 an address with an impossible port is skipped and the other pages stay', async () => {
  const pages = await pagesOf({ 'http://localhost:70000/x': 2, 'http://127.0.0.1:5999/': 1 }, 4317, Date.now())
  assert.deepEqual(pages.map((page) => page.label), ['localhost:5999'])
})

test('T1 the current state counts from its last unbroken run: a gap is not bridged', () => {
  const runs = [
    { from: 0, to: 10, state: 'working' },
    { from: 100, to: 120, state: 'working' },
    { from: 120, to: 200, state: 'working' },
  ]
  assert.equal(stateSinceOf(runs, 'working'), 100)
  assert.equal(stateSinceOf(runs, 'needs'), null)
})

// statusUpdatedAt moves when a permission is approved (waiting → busy), so "running for" restarted mid-turn
test('T2 a turn starts at idle → busy: an approval doesn\'t start one, and with the board closed only the last change is known', () => {
  // The board open: one look every 3 seconds
  let mark = nextTurn(undefined, 'busy', 1_000, 1_500)
  for (let t = 4_500; t <= 30_000; t += 3_000) mark = nextTurn(mark, 'busy', 1_000, t)
  mark = nextTurn(mark, 'waiting', 31_000, 33_000)
  mark = nextTurn(mark, 'busy', 35_000, 36_000)
  assert.equal(mark?.since, 1_000)
  const idle = nextTurn(mark, 'idle', 38_000, 39_000)
  assert.equal(nextTurn(idle, 'busy', 40_000, 42_000)?.since, 40_000)
  assert.equal(nextTurn(mark, 'busy', 90_000, 200_000)?.since, 90_000, 'after a long gap the last change is all there is')
})

test('N1 names are matched by number: explanations and missing numbers are no error, and a long name is cut', () => {
  const named = parseNames('Here are the names:\n1. Run the full test suite\n- 3) Deploy to staging\nNote: number 2 is unclear\n9. One too many', 3, 40)
  assert.deepEqual([...named.entries()], [[1, 'Run the full test suite'], [3, 'Deploy to staging']])
  assert.equal(parseNames('1、跑全量测试并把结果写回去再部署', 1, 8).get(1), '跑全量测试并把结…')
})

test('A1 a reused pid: a start time that doesn\'t match is another process, and a format we can\'t read counts as the same', () => {
  const starts = parseStarts('14018 Thu Nov 12 02:03:15 2026\n  7 Sat Nov  7 21:52:02 2026\n')
  assert.equal(starts.get(7), 'Sat Nov  7 21:52:02 2026')
  assert.equal(sameStart('Thu Nov 12 02:03:15 2026', starts.get(14018)), true)
  assert.equal(sameStart('Thu Nov 12 02:03:16 2026', starts.get(14018)), true, 'within the rounding of a second')
  assert.equal(sameStart('Thu Nov 12 01:00:00 2026', starts.get(14018)), false)
  assert.equal(sameStart('some future format', starts.get(14018)), true)
})

// An interrupted subagent never gets `finished` written: how long its own log has been quiet decides
test('A2 a subagent with no finished mark whose log has been quiet a long time is not running', async () => {
  const dir = join(home, 'parent', 'subagents')
  mkdirSync(dir, { recursive: true })
  for (const [id, quietMs] of [['old', 60 * MIN], ['live', 0]]) {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'Explore', description: id }))
    const log = join(dir, `agent-${id}.jsonl`)
    writeFileSync(log, '{}\n')
    utimesSync(log, (Date.now() - quietMs) / 1000, (Date.now() - quietMs) / 1000)
  }
  const rows = await readSubagents(join(home, 'parent.jsonl'), Date.now() - 3 * 60 * MIN)
  assert.deepEqual(rows.map((row) => [row.id, row.running]), [['live', true], ['old', false]])
})
