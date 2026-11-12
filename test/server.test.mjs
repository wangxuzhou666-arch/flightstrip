// End to end through the CLI and the built server bundle (dist/server.js): demo mode and a first run on a machine with
// no Claude Code data. HOME points at a temp dir, a fake `claude` and `open` on PATH record any call, and the real
// ~/.claude and ~/.flightstrip are never involved.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(REPO, 'bin', 'flightstrip.mjs')
const children = []
const roots = []

// Always rebuild the server bundle so the tests run the current source (client build in dist/ is left alone)
before(() => {
  execFileSync(process.execPath, [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.server.config.ts'], { cwd: REPO, stdio: 'pipe' })
})

after(() => {
  for (const child of children) child.kill('SIGKILL')
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A temp HOME with a fake `claude` and `open` (each appends its arguments to a log) first on PATH, and a canary session in ~/.claude */
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fs-server-')))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  const calls = join(root, 'calls.log')
  for (const name of ['claude', 'open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  // A live-looking session of the "real" user: demo mode must not show it
  writeFileSync(join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: 'cafe0000-0000-4000-8000-00000000cafe', pid: process.pid, name: 'REAL-SESSION-CANARY', cwd: '/real/place', startedAt: Date.now(), status: 'busy' }))
  return { root, home, bin, calls, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } }
}

function freePort() {
  return new Promise((done) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

/** Runs the CLI; resolves once it printed `ready` (or exited) */
function runCli(args, env, ready = /flightstrip is running|already running|could not start|Port \d+/) {
  const child = spawn(process.execPath, [CLI, ...args], { env })
  children.push(child)
  let out = ''
  let err = ''
  const exited = new Promise((done) => child.on('close', (status) => done(status)))
  const started = new Promise((done) => {
    const check = () => { if (ready.test(out + err)) done() }
    child.stdout.on('data', (chunk) => { out += chunk; check() })
    child.stderr.on('data', (chunk) => { err += chunk; check() })
    exited.then(done)
  })
  return { child, exited, started, output: () => out, errors: () => err }
}

/** Reads `count` snapshots from the SSE stream */
async function snapshots(url, count) {
  const controller = new AbortController()
  const res = await fetch(`${url}/api/stream`, { signal: controller.signal })
  const decoder = new TextDecoder()
  const found = []
  let buffer = ''
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const messages = buffer.split('\n\n')
      buffer = messages.pop()
      for (const message of messages) if (message.startsWith('data: ')) found.push(JSON.parse(message.slice(6)))
      if (found.length >= count) break
    }
  } finally {
    controller.abort()
  }
  return found
}

async function post(url, path, body) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Flightstrip': '1', Origin: url },
  })
  return { status: res.status, body: await res.json() }
}

const latest = async (url) => (await snapshots(url, 1))[0]

/** Waits for the first snapshot that satisfies `done`: a write is pushed with the next refresh, not instantly */
async function snapshotWhere(url, done) {
  const deadline = Date.now() + 8000
  for (;;) {
    const [snapshot] = await snapshots(url, 1)
    if (done(snapshot) || Date.now() > deadline) return snapshot
    await new Promise((wait) => setTimeout(wait, 100))
  }
}

async function waitForFile(path) {
  for (let tries = 0; tries < 50 && !existsSync(path); tries += 1) await new Promise((wait) => setTimeout(wait, 100))
  return readFileSync(path, 'utf8')
}
const byName = (snapshot, name) => snapshot.strips.find((strip) => strip.name === name)

async function startDemo() {
  const box = sandbox()
  const port = await freePort()
  const env = { ...box.env, PORT: String(port) }
  const run = runCli(['--demo', '--no-open'], env)
  await run.started
  return { ...box, port, url: `http://127.0.0.1:${port}`, env, run }
}

test('demo: the first snapshot has fictional sessions covering every state the UI renders', async () => {
  const demo = await startDemo()
  const snapshot = await latest(demo.url)
  const { strips } = snapshot
  assert.ok(strips.length >= 7 && strips.length <= 8, `${strips.length} strips`)
  assert.deepEqual(new Set(strips.map((s) => s.stateKind)), new Set(['needs', 'working', 'failed', 'idle']))
  assert.deepEqual(new Set(strips.map((s) => s.bay)), new Set(['needs', 'working', 'done', 'idle']))
  assert.ok(strips.some((s) => s.kind === 'background') && strips.some((s) => s.kind === 'interactive'))

  const jobs = strips.flatMap((s) => s.jobs)
  assert.ok(jobs.some((j) => j.status === 'running' && j.tail), 'a running job with an output tail')
  assert.ok(jobs.some((j) => j.status === 'failed'), 'a failed job')
  assert.ok(jobs.some((j) => j.status === 'completed'), 'a finished job (the "N more finished" link)')
  assert.ok(strips.some((s) => s.subagents.length > 0 && s.subagents.some((a) => a.running)), 'subagents')
  assert.ok(strips.some((s) => s.stateKind === 'needs' && s.now.length > 40), 'a pending question')
  assert.ok(strips.some((s) => s.worktrees.length > 0), 'worktrees')
  assert.ok(strips.some((s) => s.pages.some((p) => p.live)), 'a live page')
  assert.deepEqual(new Set(strips.flatMap((s) => (s.pr ? [s.pr.checks] : []))), new Set(['pass', 'fail', 'pending']))
  assert.ok(strips.some((s) => s.todos?.some((t) => t.done) && s.todos.some((t) => !t.done)), 'a partly done checklist')
  assert.ok(strips.every((s) => s.progress && s.goal))
  assert.ok(strips.some((s) => s.todoSource === 'session') && strips.some((s) => s.todoSource === 'haiku'))
  assert.ok(strips.some((s) => s.segments.some((seg) => seg.state === 'needs')) && strips.some((s) => s.segments.some((seg) => seg.state === 'failed')))

  const contexts = strips.map((s) => s.contextTokens).filter((n) => n !== null)
  assert.ok(contexts.some((n) => n >= 100_000 && n <= 140_000), 'about 120K')
  assert.ok(contexts.some((n) => n >= snapshot.contextLine * 0.75 && n < snapshot.contextLine), 'in the warning zone')
  assert.ok(contexts.some((n) => n > snapshot.contextLine), 'over the line')

  assert.equal(snapshot.groups.length, 3)
  assert.ok(strips.some((s) => s.groupId === null) && strips.every((s) => s.groupId === null || snapshot.groups.some((g) => g.id === s.groupId)))
  assert.ok(snapshot.usage !== null)
  assert.equal(snapshot.error, null)
  const sessionIds = new Set(strips.map((s) => s.sessionId))
  assert.equal(sessionIds.size, strips.length)
  assert.equal(new Set(strips.map((s) => s.sessionId.slice(0, 8))).size, strips.length, 'distinct 8-char prefixes (card ids and view transitions use them)')
  assert.ok(strips.every((s) => /^[0-9a-f-]{36}$/.test(s.sessionId)), 'ids pass the server route check')
  demo.run.child.kill()
})

test('demo: nothing personal, nothing read from ~/.claude, no claude process, nothing written to disk', async () => {
  const demo = await startDemo()
  const snapshot = await latest(demo.url)
  const text = JSON.stringify(snapshot)
  assert.ok(!text.includes('REAL-SESSION-CANARY') && !text.includes('/real/place'), 'the real session must not show up')
  for (const personal of [userInfo().username, '/Users/', '/home/', demo.home]) assert.ok(!text.includes(personal), `snapshot mentions ${personal}`)
  assert.ok(snapshot.strips.every((s) => s.cwd.startsWith('~/projects/acme-shop') && s.project === 'acme-shop'))

  // Exercise every kind of write, then check nothing reached the disk or the claude CLI
  const [auth, docs, audit] = ['Migrate auth to OAuth2', 'Write v2 API docs', 'Nightly dependency audit'].map((name) => byName(snapshot, name))
  assert.equal((await post(demo.url, '/api/groups/create', { name: 'Scratch', sessionId: auth.sessionId })).status, 200)
  assert.equal((await post(demo.url, `/api/sessions/${auth.sessionId}/rename`, { name: 'Renamed in demo' })).status, 200)
  assert.equal((await post(demo.url, `/api/sessions/${docs.sessionId}/retire`, {})).status, 200)
  assert.equal((await post(demo.url, `/api/sessions/${audit.sessionId}/retire`, {})).status, 200)
  assert.equal(existsSync(join(demo.home, '.flightstrip')), false, 'the state dir must not be created')
  assert.equal(existsSync(demo.calls), false, 'claude must never be spawned in demo mode')
  assert.equal(readFileSync(join(demo.home, '.claude', 'sessions', `${process.pid}.json`), 'utf8').includes('REAL-SESSION-CANARY'), true)
  demo.run.child.kill()
})

test('demo: group, rename and retire work in memory and show up in the next snapshot', async () => {
  const demo = await startDemo()
  const first = await latest(demo.url)
  const auth = byName(first, 'Migrate auth to OAuth2')
  const created = await post(demo.url, '/api/groups/create', { name: 'Scratch', sessionId: auth.sessionId })
  assert.equal(created.status, 200)
  assert.equal((await post(demo.url, `/api/sessions/${auth.sessionId}/rename`, { name: 'Renamed in demo' })).status, 200)
  const docs = byName(first, 'Write v2 API docs')
  assert.equal((await post(demo.url, `/api/sessions/${docs.sessionId}/retire`, {})).status, 200)
  const audit = byName(first, 'Nightly dependency audit')
  assert.equal(audit.stateKind, 'working')
  assert.equal((await post(demo.url, `/api/sessions/${audit.sessionId}/retire`, {})).status, 200)

  const second = await snapshotWhere(demo.url, (snapshot) => snapshot.retired.length === 2 && byName(snapshot, 'Renamed in demo') !== undefined)
  const renamed = second.strips.find((s) => s.sessionId === auth.sessionId)
  assert.equal(renamed.name, 'Renamed in demo')
  assert.equal(renamed.groupId, created.body.id)
  assert.ok(second.groups.some((g) => g.name === 'Scratch'))
  assert.deepEqual(new Set(second.retired.map((r) => r.name)), new Set(['Write v2 API docs', 'Nightly dependency audit']), 'a stopped demo background session stays retired')
  assert.ok(!second.strips.some((s) => s.sessionId === docs.sessionId))

  const restored = await post(demo.url, `/api/sessions/${docs.sessionId}/unretire`, {})
  assert.equal(restored.status, 200)
  assert.ok((await snapshotWhere(demo.url, (snapshot) => snapshot.retired.length === 1)).strips.some((s) => s.sessionId === docs.sessionId))
  assert.equal((await post(demo.url, '/api/groups/rename', { id: created.body.id, name: '' })).status, 400, 'the real validation still applies')
  assert.equal((await post(demo.url, `/api/sessions/de100099-0000-4000-8000-000000000000/rename`, { name: 'x' })).status, 404)
  demo.run.child.kill()
})

test('demo: it keeps ticking, so working strips look live', async () => {
  const demo = await startDemo()
  const [a, b] = await snapshots(demo.url, 2)
  assert.ok(b.takenAt > a.takenAt)
  const e2e = (snapshot) => byName(snapshot, 'Fix flaky checkout e2e test')
  assert.ok(e2e(b).segments.at(-1).to > e2e(a).segments.at(-1).to, 'the activity band grows')
  assert.ok(e2e(b).updatedAt > e2e(a).updatedAt)
  assert.equal(e2e(a).jobs[0].startedAt, e2e(b).jobs[0].startedAt, 'the job keeps its start time, so its runtime counts up')
  demo.run.child.kill()
})

test('a second `flightstrip` on a running instance opens the browser instead of starting another server', async () => {
  const demo = await startDemo()
  const again = runCli(['--demo'], demo.env, /already running/)
  assert.equal(await again.exited, 0)
  assert.match(again.output(), /already running at/)
  assert.match(await waitForFile(demo.calls), new RegExp(`open ${demo.url}`))

  const plain = runCli(['--no-open'], demo.env)
  assert.equal(await plain.exited, 1, 'a normal start must not silently attach to a demo')
  assert.match(plain.errors(), /demo is already running on port/)
  assert.match(plain.errors(), new RegExp(`PORT=${demo.port + 1} flightstrip`))
  demo.run.child.kill()
})

test('FLIGHTSTRIP_DEMO=1 works like --demo', async () => {
  const box = sandbox()
  const port = await freePort()
  const run = runCli(['--no-open'], { ...box.env, PORT: String(port), FLIGHTSTRIP_DEMO: '1' })
  await run.started
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
  assert.deepEqual({ app: health.app, demo: health.demo }, { app: 'flightstrip', demo: true })
  run.child.kill()
})

test('first run with no ~/.claude and no claude CLI: starts, shows an empty board and explains', async () => {
  const box = sandbox()
  rmSync(join(box.home, '.claude'), { recursive: true })
  const port = await freePort()
  const env = { PATH: dirname(box.bin), HOME: box.home, PORT: String(port) }
  const run = runCli(['--no-open'], env, /flightstrip is running/)
  await run.started
  const url = `http://127.0.0.1:${port}`
  assert.match(run.errors(), /`claude` CLI is not on your PATH/)
  assert.match(run.errors(), /~\/\.claude does not exist/)
  assert.match(run.errors(), /--demo/)
  const snapshot = await latest(url)
  assert.deepEqual({ strips: snapshot.strips, retired: snapshot.retired, error: snapshot.error }, { strips: [], retired: [], error: null })
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<div id="root">/)
  assert.equal(run.child.exitCode, null, 'still running')
  run.child.kill()
})

test('a bad FLIGHTSTRIP_* value is reported in one sentence, not a stack trace', async () => {
  const box = sandbox()
  const run = runCli(['--demo', '--no-open'], { ...box.env, PORT: String(await freePort()), FLIGHTSTRIP_BRIEFS: 'maybe' })
  assert.equal(await run.exited, 1)
  assert.match(run.errors(), /flightstrip could not start: FLIGHTSTRIP_BRIEFS must be "on" or "off", got "maybe"/)
  assert.doesNotMatch(run.errors(), /\n\s+at /)
})

// ---- language ----

/** A server on a real (non-demo) HOME with no ~/.claude, so only what the test puts in place is read */
async function startReal(extraEnv = {}, box = sandbox()) {
  const port = await freePort()
  const env = { ...box.env, PORT: String(port), FLIGHTSTRIP_BRIEFS: 'off', ...extraEnv }
  const run = runCli(['--no-open'], env, /flightstrip is running|could not start/)
  await run.started
  return { ...box, port, url: `http://127.0.0.1:${port}`, env, run }
}

test('lang: FLIGHTSTRIP_LANG sets the first language, the toggle switches it, and the server text follows', async () => {
  const box = sandbox()
  const port = await freePort()
  const run = runCli(['--demo', '--no-open'], { ...box.env, PORT: String(port), FLIGHTSTRIP_LANG: 'zh' })
  await run.started
  const url = `http://127.0.0.1:${port}`
  const first = await latest(url)
  assert.equal(first.lang, 'zh')
  const surfaces = (snapshot) => new Set(snapshot.strips.map((s) => s.surface))
  assert.ok(surfaces(first).has('后台') && surfaces(first).has('终端'), [...surfaces(first)].join())
  assert.ok(byName(first, 'Migrate auth to OAuth2').now.startsWith('等你回答：Should sign-in'), byName(first, 'Migrate auth to OAuth2').now)

  const switched = await post(url, '/api/settings', { lang: 'en' })
  assert.deepEqual(switched, { status: 200, body: { ok: true } })
  const second = await snapshotWhere(url, (snapshot) => snapshot.lang === 'en')
  assert.equal(second.lang, 'en')
  assert.ok(surfaces(second).has('Background') && surfaces(second).has('Terminal'), [...surfaces(second)].join())
  assert.ok(byName(second, 'Migrate auth to OAuth2').now.startsWith('Waiting for your answer: Should sign-in'))
  assert.equal(existsSync(join(box.home, '.flightstrip')), false, 'demo mode keeps the choice in memory')

  // Demo text that is page chrome, not fixture: the line after a retire
  const audit = byName(second, 'Nightly dependency audit')
  assert.equal((await post(url, `/api/sessions/${audit.sessionId}/retire`, {})).status, 200)
  await post(url, '/api/settings', { lang: 'zh' })
  const third = await snapshotWhere(url, (snapshot) => snapshot.lang === 'zh' && snapshot.retired.length === 1)
  assert.equal(third.lang, 'zh')
  run.child.kill()
})

test('lang: the settings route is checked like the other writes and rejects anything but en and zh', async () => {
  const demo = await startDemo()
  const send = (headers, body) => fetch(`${demo.url}/api/settings`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } })
  const trusted = { 'X-Flightstrip': '1', Origin: demo.url }
  assert.equal((await send({}, { lang: 'zh' })).status, 403, 'no header, no origin')
  assert.equal((await send({ 'X-Flightstrip': '1' }, { lang: 'zh' })).status, 403, 'no origin')
  assert.equal((await send({ ...trusted, Origin: 'http://evil.example' }, { lang: 'zh' })).status, 403, 'foreign origin')
  assert.equal((await send(trusted, { lang: 'zh' })).status, 200)
  for (const body of [{ lang: 'fr' }, { lang: 'EN' }, { lang: null }, { lang: 1 }, {}]) {
    const res = await send(trusted, body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal((await res.json()).error, '语言只能是 "en" 或 "zh"', 'the error is in the language that was current')
  }
  assert.equal((await latest(demo.url)).lang, 'zh', 'a rejected request changed nothing')
  demo.run.child.kill()
})

test('lang: a saved choice beats FLIGHTSTRIP_LANG, which beats the system locale; the choice survives a restart', async () => {
  const box = sandbox()
  rmSync(join(box.home, '.claude'), { recursive: true })
  const stateFile = join(box.home, '.flightstrip', 'settings.json')

  const first = await startReal({ FLIGHTSTRIP_LANG: 'zh' }, box)
  assert.equal((await latest(first.url)).lang, 'zh')
  assert.equal((await post(first.url, '/api/settings', { lang: 'en' })).status, 200)
  assert.equal((await snapshotWhere(first.url, (s) => s.lang === 'en')).lang, 'en')
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { lang: 'en' })
  first.run.child.kill()
  await first.run.exited

  const restarted = await startReal({ FLIGHTSTRIP_LANG: 'zh' }, box)
  assert.equal((await latest(restarted.url)).lang, 'en', 'saved en beats env zh')
  restarted.run.child.kill()
  await restarted.run.exited

  rmSync(stateFile)
  const fromEnv = await startReal({ FLIGHTSTRIP_LANG: 'zh', LANG: 'en_US.UTF-8' }, box)
  assert.equal((await latest(fromEnv.url)).lang, 'zh', 'env beats the system locale')
  fromEnv.run.child.kill()
  await fromEnv.run.exited

  for (const [locale, expected] of [['zh_CN.UTF-8', 'zh'], ['en_US.UTF-8', 'en'], ['fr_FR.UTF-8', 'en']]) {
    const located = await startReal({ LANG: locale }, box)
    assert.equal((await latest(located.url)).lang, expected, `system locale ${locale}`)
    located.run.child.kill()
    await located.run.exited
  }

  writeFileSync(stateFile, '{ not json')
  const corrupt = await startReal({ FLIGHTSTRIP_LANG: 'zh' }, box)
  assert.equal((await latest(corrupt.url)).lang, 'zh', 'a corrupt settings file is ignored, not a crash')
  corrupt.run.child.kill()
})

test('CLAUDE_CONFIG_DIR: sessions and transcripts come from it, and the text read off a transcript follows a language switch', async () => {
  const box = sandbox()
  const custom = join(box.root, 'claude-config')
  const sessionId = 'cafe0001-0000-4000-8000-00000000cafe'
  mkdirSync(join(custom, 'sessions'), { recursive: true })
  mkdirSync(join(custom, 'projects', 'lane'), { recursive: true })
  // cwd = HOME: a session that belongs to no project
  writeFileSync(join(custom, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId, pid: process.pid, name: 'CUSTOM-DIR-SESSION', cwd: box.home, startedAt: Date.now(), status: 'busy', entrypoint: 'cli' }))
  const at = new Date().toISOString()
  writeFileSync(join(custom, 'projects', 'lane', `${sessionId}.jsonl`), [
    { type: 'user', timestamp: at, message: { content: 'Please fix the login bug' } },
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }], usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 45 } } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')

  const server = await startReal({ CLAUDE_CONFIG_DIR: custom, FLIGHTSTRIP_LANG: 'zh' }, box)
  const strip = (snapshot) => snapshot.strips.find((s) => s.name === 'CUSTOM-DIR-SESSION')
  const first = await snapshotWhere(server.url, (snapshot) => strip(snapshot) !== undefined)
  assert.ok(strip(first), 'the session in CLAUDE_CONFIG_DIR is listed')
  assert.ok(!JSON.stringify(first).includes('REAL-SESSION-CANARY'), 'the one in ~/.claude is not')
  assert.equal(strip(first).project, null, 'a session in the home directory belongs to no project')
  assert.equal(strip(first).now, '读文件：src/a.ts')
  assert.equal(strip(first).surface, '终端')
  // Counted like VS Code's "tokens in context": the input, both cache figures and the reply's own output
  assert.equal(strip(first).contextTokens, 10 + 200 + 3000 + 45)

  assert.equal((await post(server.url, '/api/settings', { lang: 'en' })).status, 200)
  const second = await snapshotWhere(server.url, (snapshot) => snapshot.lang === 'en')
  assert.equal(strip(second).now, 'Reading a file: src/a.ts', 'the cached transcript digest is worded again in the new language')
  assert.equal(strip(second).surface, 'Terminal')
  server.run.child.kill()
})

test('background jobs: both ways of starting one are tracked, every ending signal ends one, and only jobs with no ending show as running', async () => {
  const box = sandbox()
  const custom = join(box.root, 'claude-config')
  const tasks = join(box.root, 'tasks')
  const sessionId = 'cafe0002-0000-4000-8000-00000000cafe'
  mkdirSync(join(custom, 'sessions'), { recursive: true })
  mkdirSync(join(custom, 'projects', 'lane'), { recursive: true })
  mkdirSync(tasks)
  writeFileSync(join(custom, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId, pid: process.pid, name: 'JOBS-SESSION', cwd: box.home, startedAt: Date.now(), status: 'busy', entrypoint: 'cli' }))
  const at = new Date().toISOString()
  const notice = (id, status) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>tu-${id}</tool-use-id>\n<output-file>${join(tasks, `${id}.output`)}</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`
  // id → what its output file holds (null = no file) and how its end is recorded
  const jobs = {
    oldUserRow: { output: 'done\n[exited with code 0]\n' },
    attachmentRow: { output: 'sh: foo: command not found\n[exited with code 127]\n' },
    queueRow: { output: 'ok\n[exited with code 0]\n' },
    exitZero: { output: 'built\n[exited with code 0]\n' },
    exitOne: { output: 'Error: boom\n[exited with code 1]\n' },
    stillGoing: { output: 'step 3 of 10\n' },
    fileGone: { output: null },
    stoppedByTaskStop: { output: 'partial\n[killed]\n' },
    // A foreground command that ran past its timeout and was moved to the background
    timedOut: { output: 'scanning…\n', foreground: true },
  }
  const rows = []
  for (const [id, job] of Object.entries(jobs)) {
    if (job.output !== null) writeFileSync(join(tasks, `${id}.output`), job.output)
    const outputPath = join(tasks, `${id}.output`)
    const result = job.foreground
      ? { content: `Command did not complete within its 120s timeout and was moved to the background (ID: ${id}). Output is being written to: ${outputPath}. You will be notified when it completes.`, toolUseResult: { stdout: '', backgroundTaskId: id, timedOutAfterMs: 120000 } }
      : { content: `Command running in background with ID: ${id}. Output is being written to: ${outputPath}. You will be notified when it completes`, toolUseResult: id === 'oldUserRow' ? undefined : { stdout: '', backgroundTaskId: id } }
    rows.push(
      { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: `run ${id}`, description: `Job ${id}`, run_in_background: !job.foreground } }], usage: { input_tokens: 10 } } },
      { type: 'user', timestamp: at, toolUseResult: result.toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: result.content }] } },
    )
  }
  // A foreground command that finished, whose output only quotes a launch message, starts no job
  rows.push(
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'tu-quote', name: 'Bash', input: { command: 'grep ID log.txt', description: 'Search the log' } }], usage: { input_tokens: 10 } } },
    { type: 'user', timestamp: at, toolUseResult: { stdout: 'Command running in background with ID: quoted.' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu-quote', content: 'Command running in background with ID: quoted. Output is being written to: /x/quoted.output' }] } },
  )
  // The format observed 2026-11-07: a user entry
  rows.push({ type: 'user', timestamp: at, message: { content: [{ type: 'text', text: notice('oldUserRow', 'completed') }] } })
  // The format observed 2026-11-08: an attachment entry, and queue-operation entries (enqueue, then remove)
  rows.push({ type: 'attachment', timestamp: at, isSidechain: false, attachment: { type: 'queued_command', prompt: notice('attachmentRow', 'failed'), commandMode: 'task-notification' } })
  rows.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: notice('queueRow', 'completed') })
  rows.push({ type: 'queue-operation', operation: 'remove', timestamp: at, content: notice('queueRow', 'completed') })
  // A notice for a job whose start isn't in the transcript adds nothing
  rows.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: notice('neverStarted', 'completed') })
  writeFileSync(join(custom, 'projects', 'lane', `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

  const server = await startReal({ CLAUDE_CONFIG_DIR: custom }, box)
  const strip = (snapshot) => snapshot.strips.find((s) => s.name === 'JOBS-SESSION')
  const snapshot = await snapshotWhere(server.url, (s) => (strip(s)?.jobs.length ?? 0) > 0)
  const shown = Object.fromEntries(strip(snapshot).jobs.map((job) => [job.id, job]))
  assert.deepEqual(Object.keys(shown).sort(), ['attachmentRow', 'exitOne', 'exitZero', 'oldUserRow', 'queueRow', 'stillGoing', 'stoppedByTaskStop', 'timedOut'], 'a job whose output file is gone and that got no notice is not shown')
  const statuses = Object.fromEntries(Object.entries(shown).map(([id, job]) => [id, job.status]))
  assert.deepEqual(statuses, { oldUserRow: 'completed', attachmentRow: 'failed', queueRow: 'completed', exitZero: 'completed', exitOne: 'failed', stillGoing: 'running', stoppedByTaskStop: 'stopped', timedOut: 'running' })
  for (const [id, job] of Object.entries(shown)) {
    if (id === 'stillGoing' || id === 'timedOut') {
      assert.equal(job.endedAt, null)
      assert.equal(job.tail, jobs[id].output.trim(), 'a running job shows its last line of output')
    } else {
      assert.equal(typeof job.endedAt, 'number', `${id} has an end time`)
      assert.equal(job.tail, null, `${id} shows no live output line`)
    }
  }
  server.run.child.kill()
})

test('background jobs: a running one shows its progress, when it last printed and what its processes use; the snapshot carries the machine load', async () => {
  const box = sandbox()
  const custom = join(box.root, 'claude-config')
  const tasks = join(box.root, 'tasks')
  const sessionId = 'cafe0005-0000-4000-8000-00000000cafe'
  mkdirSync(join(custom, 'sessions'), { recursive: true })
  mkdirSync(join(custom, 'projects', 'lane'), { recursive: true })
  mkdirSync(tasks)
  writeFileSync(join(custom, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId, pid: process.pid, name: 'PROGRESS-SESSION', cwd: box.home, startedAt: Date.now(), status: 'busy', entrypoint: 'cli' }))
  const output = (id) => join(tasks, `${id}.output`)
  // A step header followed by its log: the bar comes from the header, and the last line is still shown under it
  writeFileSync(output('stepping'), '==> [3/8] Sync code\ncopying 12 files\n')
  const quietSince = Date.now() - 10 * 60_000
  utimesSync(output('stepping'), quietSince / 1000, quietSince / 1000)
  // Nothing printed yet: no time to judge a stall by
  writeFileSync(output('silent'), '')
  // A real process with the output file as its stdout, as Claude Code starts one; its child counts too
  writeFileSync(output('held'), 'serving\n')
  const fd = openSync(output('held'), 'a')
  const holder = spawn('/bin/sh', ['-c', 'sleep 60 & wait'], { stdio: ['ignore', fd, fd] })
  closeSync(fd)
  children.push(holder)
  const at = new Date().toISOString()
  const rows = ['stepping', 'silent', 'held'].flatMap((id) => [
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: `run ${id}`, description: `Job ${id}`, run_in_background: true } }], usage: { input_tokens: 10 } } },
    { type: 'user', timestamp: at, toolUseResult: { stdout: '', backgroundTaskId: id }, message: { content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: `Command running in background with ID: ${id}. Output is being written to: ${output(id)}. You will be notified when it completes` }] } },
  ])
  writeFileSync(join(custom, 'projects', 'lane', `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

  const server = await startReal({ CLAUDE_CONFIG_DIR: custom }, box)
  const strip = (snapshot) => snapshot.strips.find((s) => s.name === 'PROGRESS-SESSION')
  const held = (snapshot) => strip(snapshot)?.jobs.find((job) => job.id === 'held')
  const snapshot = await snapshotWhere(server.url, (s) => held(s)?.usage != null)
  const shown = Object.fromEntries(strip(snapshot).jobs.map((job) => [job.id, job]))

  assert.deepEqual(shown.stepping.progress, { fraction: 3 / 8, mark: '3/8', label: 'Sync code', lineIsTail: false })
  assert.equal(shown.stepping.tail, 'copying 12 files')
  assert.equal(Math.round(shown.stepping.lastOutputAt / 1000), Math.round(quietSince / 1000), 'the output file\'s change time is when it last printed')
  assert.equal(shown.stepping.usage, null, 'no process writes its output file, so there is nothing to measure')
  assert.equal(shown.silent.lastOutputAt, null)
  assert.equal(shown.silent.progress, null)
  const usage = shown.held.usage
  assert.ok(usage.processes >= 2, `the shell and its child are both counted (got ${usage.processes})`)
  assert.ok(usage.memoryBytes > 0 && usage.cpuPercent >= 0)

  const { machine } = snapshot
  assert.ok(machine.cores > 0)
  assert.ok(machine.memory.totalBytes > 0 && machine.memory.usedBytes > 0 && machine.memory.usedBytes <= machine.memory.totalBytes)
  assert.ok(machine.disk.freeBytes > 0 && machine.disk.freeBytes <= machine.disk.totalBytes)
  assert.ok(machine.cpuPercent === null || (machine.cpuPercent >= 0 && machine.cpuPercent <= 100))

  // A long step pushes its header out of the part of the output that is read: the bar it set stays
  appendFileSync(output('stepping'), `${'log line\n'.repeat(10_000)}still syncing\n`)
  const later = await snapshotWhere(server.url, (s) => strip(s)?.jobs.find((job) => job.id === 'stepping')?.tail === 'still syncing')
  const stepping = strip(later).jobs.find((job) => job.id === 'stepping')
  assert.equal(stepping.tail, 'still syncing')
  assert.deepEqual(stepping.progress, { fraction: 3 / 8, mark: '3/8', label: 'Sync code', lineIsTail: false })
  holder.kill()
  server.run.child.kill()
})

test('background jobs: one started before the tail of a long transcript, which is all a first read parses, still shows', async () => {
  const box = sandbox()
  const custom = join(box.root, 'claude-config')
  const tasks = join(box.root, 'tasks')
  const sessionId = 'cafe0003-0000-4000-8000-00000000cafe'
  mkdirSync(join(custom, 'sessions'), { recursive: true })
  mkdirSync(join(custom, 'projects', 'lane'), { recursive: true })
  mkdirSync(tasks)
  writeFileSync(join(custom, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId, pid: process.pid, name: 'LONG-SESSION', cwd: box.home, startedAt: Date.now(), status: 'busy', entrypoint: 'cli' }))
  const at = new Date().toISOString()
  const outputs = { earlyRunning: 'epoch 4 of 20\n', earlyEnded: 'ok\n[exited with code 0]\n', earlyTimedOut: 'partial\n[killed]\n' }
  for (const [id, output] of Object.entries(outputs)) writeFileSync(join(tasks, `${id}.output`), output)
  const launch = (id, background) => [
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: `run ${id}`, description: `Job ${id}`, run_in_background: background } }], usage: { input_tokens: 10 } } },
    { type: 'user', timestamp: at, toolUseResult: { stdout: '', backgroundTaskId: id }, message: { content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: `${background ? `Command running in background with ID: ${id}` : `Command did not complete within its 120s timeout and was moved to the background (ID: ${id})`}. Output is being written to: ${join(tasks, `${id}.output`)}. You will be notified when it completes` }] } },
  ]
  const rows = [
    ...launch('earlyRunning', true),
    ...launch('earlyEnded', true),
    { type: 'attachment', timestamp: at, isSidechain: false, attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>earlyEnded</task-id>\n<status>completed</status>\n</task-notification>` } },
    ...launch('earlyTimedOut', false),
  ]
  // About 1.2 MB of plain conversation after them, more than the tail a first read parses (768 KB)
  for (let i = 0; i < 1200; i++) rows.push({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: `Thinking step ${i}: ${'x'.repeat(1000)}` }], usage: { input_tokens: 10 } } })
  rows.push({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 't-last', name: 'Read', input: { file_path: 'src/last.ts' } }], usage: { input_tokens: 10 } } })
  const transcript = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  assert.ok(transcript.length > 1024 * 1024, 'the job starts lie outside the tail')
  writeFileSync(join(custom, 'projects', 'lane', `${sessionId}.jsonl`), transcript)

  const server = await startReal({ CLAUDE_CONFIG_DIR: custom }, box)
  const strip = (snapshot) => snapshot.strips.find((s) => s.name === 'LONG-SESSION')
  const snapshot = await snapshotWhere(server.url, (s) => strip(s) !== undefined && strip(s).now.includes('src/last.ts'))
  const statuses = Object.fromEntries(strip(snapshot).jobs.map((job) => [job.id, job.status]))
  assert.deepEqual(statuses, { earlyRunning: 'running', earlyEnded: 'completed', earlyTimedOut: 'stopped' })
  assert.equal(strip(snapshot).jobs.find((job) => job.id === 'earlyRunning').tail, 'epoch 4 of 20')
  server.run.child.kill()
})

// The checks that a process still writes an output file use lsof
const hasLsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].some((path) => existsSync(path))

/** A session in CLAUDE_CONFIG_DIR whose transcript is `rows`, plus a tasks dir for output files */
function jobSession(name, sessionId) {
  const box = sandbox()
  const custom = join(box.root, 'claude-config')
  const tasks = join(box.root, 'tasks')
  mkdirSync(join(custom, 'sessions'), { recursive: true })
  mkdirSync(join(custom, 'projects', 'lane'), { recursive: true })
  mkdirSync(tasks)
  writeFileSync(join(custom, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId, pid: process.pid, name, cwd: box.home, startedAt: Date.now(), status: 'busy', entrypoint: 'cli' }))
  const output = (id) => join(tasks, `${id}.output`)
  const launch = (id, at, padding = '') => [
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: `run ${id}`, description: `Job ${id}`, run_in_background: true } }], usage: { input_tokens: 10 } } },
    { type: 'user', timestamp: at, toolUseResult: { stdout: padding, backgroundTaskId: id }, message: { content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: `Command running in background with ID: ${id}. Output is being written to: ${output(id)}. You will be notified when it completes` }] } },
  ]
  const write = (rows) => writeFileSync(join(custom, 'projects', 'lane', `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const strip = (snapshot) => snapshot.strips.find((s) => s.name === name)
  return { box, custom, output, launch, write, strip }
}

const filler = (at, i) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: `Thinking step ${i}: ${'x'.repeat(1000)}` }], usage: { input_tokens: 10 } } })
const lastRead = (at) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 't-last', name: 'Read', input: { file_path: 'src/last.ts' } }], usage: { input_tokens: 10 } } })

test('background jobs: one whose start record straddles the boundary of the tail a first read parses still shows', async () => {
  const s = jobSession('STRADDLE-SESSION', 'cafe0004-0000-4000-8000-00000000cafe')
  const at = new Date().toISOString()
  writeFileSync(s.output('straddler'), 'step 1\n')
  // The result row carries 40 KB, and is followed by just under 768 KB minus 20 KB of conversation, so the tail's
  // first byte (size - 768 KB) lands about 20 KB before the end of that row
  const [launchRow, resultRow] = s.launch('straddler', at, 'y'.repeat(40_000))
  const after = []
  let afterBytes = 0
  for (let i = 0; ; i++) {
    const row = filler(at, i)
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1
    if (afterBytes + bytes > 768 * 1024 - 20_000) break
    after.push(row)
    afterBytes += bytes
  }
  after.push(lastRead(at))
  afterBytes += Buffer.byteLength(JSON.stringify(after.at(-1))) + 1
  const before = Buffer.byteLength(JSON.stringify(launchRow)) + 1
  const resultBytes = Buffer.byteLength(JSON.stringify(resultRow)) + 1
  const tailStart = before + resultBytes + afterBytes - 768 * 1024
  assert.ok(tailStart > before && tailStart < before + resultBytes, 'the tail boundary falls inside the result row')
  s.write([launchRow, resultRow, ...after])

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  const snapshot = await snapshotWhere(server.url, (snap) => s.strip(snap)?.now.includes('src/last.ts'))
  assert.deepEqual(s.strip(snapshot).jobs.map((job) => [job.id, job.status]), [['straddler', 'running']])
  server.run.child.kill()
})

test('background jobs: a running job whose own output ends with an exit line stays running until it really ends', { skip: !hasLsof && 'needs lsof' }, async () => {
  const s = jobSession('POLLER-SESSION', 'cafe0005-0000-4000-8000-00000000cafe')
  const at = new Date().toISOString()
  // A polling loop that printed the last line of another task's output, and is still going
  writeFileSync(s.output('poller'), 'other task: [exited with code 0]\n[exited with code 0]\n')
  const fd = openSync(s.output('poller'), 'a')
  const holder = spawn('sleep', ['60'], { stdio: ['ignore', fd, 'ignore'] })
  children.push(holder)
  closeSync(fd)
  s.write([...s.launch('poller', at), lastRead(at)])

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  const job = (snap) => s.strip(snap)?.jobs.find((j) => j.id === 'poller')
  const first = await snapshotWhere(server.url, (snap) => job(snap) !== undefined)
  assert.equal(job(first).status, 'running', 'a process still has the output open')
  assert.equal(job(first).tail, '[exited with code 0]')

  holder.kill()
  const deadline = Date.now() + 15_000
  let later = first
  while (job(later).status === 'running' && Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 500))
    ;[later] = await snapshots(server.url, 1)
  }
  assert.equal(job(later).status, 'completed', 'once nothing holds the file, the exit line ends the job')
  assert.equal(typeof job(later).endedAt, 'number')
  server.run.child.kill()
})

test('background jobs: a long run of ended jobs does not push out an earlier one still running', async () => {
  const s = jobSession('CROWDED-SESSION', 'cafe0006-0000-4000-8000-00000000cafe')
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString()
  writeFileSync(s.output('longRun'), 'epoch 9 of 50\n')
  const rows = [...s.launch('longRun', hoursAgo(31))]
  // 61 later jobs that were stopped (no notice, [killed] as the last line), more than the 60 kept
  for (let i = 0; i < 61; i++) {
    writeFileSync(s.output(`stopped${i}`), 'partial\n[killed]\n')
    rows.push(...s.launch(`stopped${i}`, hoursAgo(30)))
  }
  rows.push(lastRead(new Date().toISOString()))
  s.write(rows)

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  const snapshot = await snapshotWhere(server.url, (snap) => (s.strip(snap)?.jobs.length ?? 0) > 0)
  const longRun = s.strip(snapshot).jobs.find((job) => job.id === 'longRun')
  assert.ok(longRun, 'the early job is still listed')
  assert.equal(longRun.status, 'running')
  assert.ok(s.strip(snapshot).jobs.filter((job) => job.id !== 'longRun').every((job) => job.status === 'stopped'))
  server.run.child.kill()
})

test('background jobs: a reader left on the output does not keep a stopped job running, and a later notice corrects an ending read off the file', { skip: !hasLsof && 'needs lsof' }, async () => {
  const s = jobSession('READER-SESSION', 'cafe0007-0000-4000-8000-00000000cafe')
  const at = new Date().toISOString()
  writeFileSync(s.output('watched'), 'partial\n[killed]\n')
  writeFileSync(s.output('corrected'), 'done\n[exited with code 0]\n')
  // Someone left `tail -f` on the stopped job's output: it holds the file open, but only for reading
  const reader = spawn('tail', ['-f', s.output('watched')], { stdio: 'ignore' })
  children.push(reader)
  const rows = [...s.launch('watched', at), ...s.launch('corrected', at), lastRead(at)]
  s.write(rows)

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  const status = (snap, id) => s.strip(snap)?.jobs.find((job) => job.id === id)?.status
  const first = await snapshotWhere(server.url, (snap) => status(snap, 'watched') !== undefined && status(snap, 'corrected') !== undefined)
  assert.equal(status(first, 'watched'), 'stopped', 'a read-only holder is not a writer')
  assert.equal(status(first, 'corrected'), 'completed')

  // The official notice says otherwise, and arrives after the ending was read off the file
  appendFileSync(join(s.custom, 'projects', 'lane', 'cafe0007-0000-4000-8000-00000000cafe.jsonl'), JSON.stringify({ type: 'attachment', timestamp: new Date().toISOString(), isSidechain: false, attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>corrected</task-id>\n<status>failed</status>\n</task-notification>' } }) + '\n')
  const later = await snapshotWhere(server.url, (snap) => status(snap, 'corrected') === 'failed')
  assert.equal(status(later, 'corrected'), 'failed', 'the notice wins over the output file')
  reader.kill()
  server.run.child.kill()
})

test('background jobs: one that ended long ago, read off its output file, is cleared even while the transcript stays the same', async () => {
  const s = jobSession('STALE-SESSION', 'cafe0008-0000-4000-8000-00000000cafe')
  const at = new Date(Date.now() - 31 * 3_600_000).toISOString()
  writeFileSync(s.output('old'), 'partial\n[killed]\n')
  const longAgo = new Date(Date.now() - 30 * 3_600_000)
  utimesSync(s.output('old'), longAgo, longAgo)
  s.write([...s.launch('old', at), lastRead(new Date().toISOString())])

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  await snapshotWhere(server.url, (snap) => s.strip(snap) !== undefined)
  const cleared = await snapshotWhere(server.url, (snap) => s.strip(snap) !== undefined && s.strip(snap).jobs.length === 0)
  assert.deepEqual(s.strip(cleared).jobs, [], 'stopped 30 hours ago, past the window')
  server.run.child.kill()
})

test('background jobs: an unfinished record longer than the tail, at the boundary on startup, is parsed once it is finished', async () => {
  const sessionId = 'cafe0009-0000-4000-8000-00000000cafe'
  const s = jobSession('UNFINISHED-SESSION', sessionId)
  const at = new Date().toISOString()
  writeFileSync(s.output('huge'), 'working\n')
  const [launchRow, resultRow] = s.launch('huge', at, 'z'.repeat(900_000))
  // The result row is still being written: no newline after it yet
  writeFileSync(join(s.custom, 'projects', 'lane', `${sessionId}.jsonl`), JSON.stringify(launchRow) + '\n' + JSON.stringify(resultRow))

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  await snapshotWhere(server.url, (snap) => s.strip(snap) !== undefined)
  appendFileSync(join(s.custom, 'projects', 'lane', `${sessionId}.jsonl`), '\n' + JSON.stringify(lastRead(at)) + '\n')
  const snapshot = await snapshotWhere(server.url, (snap) => s.strip(snap)?.now.includes('src/last.ts'))
  assert.deepEqual(s.strip(snapshot).jobs.map((job) => [job.id, job.status]), [['huge', 'running']])
  server.run.child.kill()
})

test('background jobs: 25 commands sent in one reply before the tail, with their results inside it, all show', async () => {
  const s = jobSession('PARALLEL-SESSION', 'cafe000a-0000-4000-8000-00000000cafe')
  const at = new Date().toISOString()
  const ids = Array.from({ length: 25 }, (_, i) => `par${i}`)
  for (const id of ids) writeFileSync(s.output(id), 'working\n')
  const pairs = ids.map((id) => s.launch(id, at))
  const sent = { type: 'assistant', timestamp: at, message: { content: pairs.map(([launchRow]) => launchRow.message.content[0]), usage: { input_tokens: 10 } } }
  // About 600 KB between the reply and its results, then about 300 KB after them: the tail (768 KB) starts in between
  const rows = [sent]
  for (let i = 0; i < 600; i++) rows.push(filler(at, i))
  rows.push(...pairs.map(([, resultRow]) => resultRow))
  for (let i = 0; i < 300; i++) rows.push(filler(at, 1000 + i))
  rows.push(lastRead(at))
  s.write(rows)

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  const snapshot = await snapshotWhere(server.url, (snap) => s.strip(snap)?.now.includes('src/last.ts'))
  assert.deepEqual(s.strip(snapshot).jobs.map((job) => job.id).sort(), [...ids].sort())
  assert.ok(s.strip(snapshot).jobs.every((job) => job.status === 'running'))
  server.run.child.kill()
})

test('background jobs: an ending read off the output file is decided again when the file changes afterwards', async () => {
  const s = jobSession('REDECIDE-SESSION', 'cafe000b-0000-4000-8000-00000000cafe')
  const at = new Date().toISOString()
  writeFileSync(s.output('redecided'), 'step 1\n[exited with code 0]\n')
  s.write([...s.launch('redecided', at), lastRead(at)])

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  const status = (snap) => s.strip(snap)?.jobs.find((job) => job.id === 'redecided')?.status
  const first = await snapshotWhere(server.url, (snap) => status(snap) !== undefined)
  assert.equal(status(first), 'completed')
  // The exit line was the command's own output; it went on and was stopped later
  appendFileSync(s.output('redecided'), 'step 2\n[killed]\n')
  const later = await snapshotWhere(server.url, (snap) => status(snap) === 'stopped')
  assert.equal(status(later), 'stopped')
  server.run.child.kill()
})

test('todos: finished items todo.mjs no longer lists still count on the strip', async () => {
  const sessionId = 'cafe0099-0000-4000-8000-00000000cafe'
  const s = jobSession('TODO-SESSION', sessionId)
  s.write([lastRead(new Date().toISOString())])
  const todo = (...args) => execFileSync(process.execPath, [join(REPO, 'scripts', 'todo.mjs'), ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: s.box.home, CLAUDE_CODE_SESSION_ID: sessionId },
  })
  todo('set', 'A', 'B', 'C', 'D', 'E', 'F')
  for (const n of ['1', '2', '3', '4', '5']) todo('done', n)

  const server = await startReal({ CLAUDE_CONFIG_DIR: s.custom }, s.box)
  const snapshot = await snapshotWhere(server.url, (snap) => s.strip(snap)?.todoSource === 'session')
  const strip = s.strip(snapshot)
  assert.deepEqual(strip.todos.map((t) => `${t.done ? 'x' : ' '} ${t.text}`), ['x C', 'x D', 'x E', '  F'])
  assert.equal(strip.todosDoneEarlier, 2, 'A and B dropped off the list but still count as done')
  server.run.child.kill()
})
