// The static demo build for GitHub Pages (`vite build --mode pages`): a board assembled in the browser, no server.
//   B (build output): the pages build is served under /flightstrip/, has the demo in it and not one /api path or
//     EventSource; the normal build is unchanged (talks to /api, carries no demo fixtures, ships no extra chunk).
//   S (static board): the client's own api layer and board, loaded through Vite with the real vite.config.ts, with
//     fetch and EventSource replaced by recorders. Every kind of write, the language and the ticking must work without
//     either of them being touched. The same recorders watch a normal-mode load, so a recorder that never fires can't pass.
// Builds run as separate vite processes into temp dirs; dist/ and dist-pages/ are not touched.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, mock, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const VITE = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js')
const temps = []
const servers = []
const stoppers = []

after(async () => {
  for (const stop of stoppers) stop()
  await Promise.all(servers.map((server) => server.close()))
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fs-pages-')))
  temps.push(dir)
  return dir
}

// ---------- B: build output

function buildClient(args) {
  const out = tempDir()
  execFileSync(process.execPath, [VITE, 'build', ...args, '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: REPO, stdio: 'pipe' })
  return out
}

function filesOf(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesOf(join(dir, entry.name)) : [join(dir, entry.name)]))
}

const textOf = (dir) => filesOf(dir).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
// A string literal that starts with /api: the paths api.ts and useSnapshot.ts talk to. Fixture text such as the branch "docs/api-v2" does not start with it
const API_PATH = /["'`]\/api\b/

let pagesBuild
let normalBuild
before(() => {
  pagesBuild = buildClient(['--mode', 'pages'])
  normalBuild = buildClient([])
})

test('B1 the pages build is served under /flightstrip/ and holds the demo', () => {
  const html = readFileSync(join(pagesBuild, 'index.html'), 'utf8')
  assert.match(html, /src="\/flightstrip\/assets\/[^"]+\.js"/)
  assert.match(html, /href="\/flightstrip\/assets\/[^"]+\.css"/)
  const all = textOf(pagesBuild).map((file) => file.text).join('\n')
  for (const needle of ['acme-shop', 'Sample sessions. Run', '这些是示例 session']) assert.ok(all.includes(needle), `the pages build should contain "${needle}"`)
})

test('B2 the pages build has no /api path and no EventSource, so the page cannot call the server', () => {
  const files = textOf(pagesBuild)
  assert.ok(files.some((file) => file.path.endsWith('.js')), 'there must be scripts to check')
  for (const { path, text } of files) {
    assert.doesNotMatch(text, API_PATH, `${path} mentions an /api path`)
    assert.ok(!text.includes('EventSource'), `${path} mentions EventSource`)
  }
})

test('B3 the normal build is unchanged: it talks to /api, and carries no demo fixtures or extra chunk', () => {
  const files = textOf(normalBuild)
  const scripts = files.filter((file) => file.path.endsWith('.js'))
  assert.equal(scripts.length, 1, scripts.map((file) => file.path).join(', '))
  assert.match(scripts[0].text, /["'`]\/api\/stream/)
  assert.ok(scripts[0].text.includes('EventSource'))
  assert.ok(!files.some((file) => file.text.includes('acme-shop')), 'the demo fixtures must stay out of the normal build')
  assert.match(readFileSync(join(normalBuild, 'index.html'), 'utf8'), /src="\/assets\/[^"]+\.js"/)
})

// ---------- S: the static board, through the real api layer

/** navigator.language is read when i18n.tsx and staticDemo.ts load; Node 20 has no navigator at all */
async function withNavigator(language, load) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true, writable: true })
  try {
    return await load()
  } finally {
    if (saved === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', saved)
  }
}

/** Loads client/src/api.ts (and the board, in pages mode) in a module graph of its own, so no state carries over from another test */
async function openBoard(mode, { language = 'en-US', subscribe = true } = {}) {
  const calls = { fetch: [], eventSource: 0 }
  const saved = { fetch: globalThis.fetch, eventSource: globalThis.EventSource }
  globalThis.fetch = async (url) => {
    calls.fetch.push(String(url))
    return { ok: true, json: async () => ({}) }
  }
  globalThis.EventSource = class {
    constructor() { calls.eventSource += 1 }
  }
  const server = await createServer({
    configFile: join(REPO, 'vite.config.ts'), root: join(REPO, 'client'), mode, cacheDir: join(tempDir(), 'vite'),
    logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true },
  })
  servers.push(server)
  const { api, board } = await withNavigator(language, async () => ({
    api: await server.ssrLoadModule('/src/api.ts'),
    board: mode === 'pages' ? await server.ssrLoadModule('/src/staticDemo.ts') : null,
  }))
  const received = []
  if (subscribe && board !== null) stoppers.push(board.subscribe((snapshot) => received.push(snapshot)))
  const restore = () => Object.assign(globalThis, { fetch: saved.fetch, EventSource: saved.eventSource })
  stoppers.push(restore)
  return { api, board, calls, received, latest: () => received.at(-1), restore }
}

const byName = (snapshot, name) => snapshot.strips.find((strip) => strip.name === name)
const groupNamed = (snapshot, name) => snapshot.groups.find((group) => group.name === name)
const noNetwork = (page) => {
  assert.deepEqual(page.calls.fetch, [], 'the static build made a request')
  assert.equal(page.calls.eventSource, 0, 'the static build opened an event stream')
}

test('S1 the first snapshot is the demo board, and nothing touches the network', async () => {
  const page = await openBoard('pages')
  const snapshot = page.latest()
  assert.equal(snapshot.strips.length + snapshot.retired.length, 8)
  assert.deepEqual(snapshot.groups.map((group) => group.name), ['Platform', 'Checkout', 'Docs'])
  assert.equal(snapshot.lang, 'en')
  assert.equal(snapshot.error, null)
  assert.ok(snapshot.usage !== null)
  assert.ok(snapshot.strips.every((strip) => typeof strip.surface === 'string' && strip.surface !== ''))
  noNetwork(page)
  page.restore()
})

test('S2 the language follows navigator.language (zh* -> zh, else en) and the toggle switches it', async () => {
  for (const [language, expected] of [['zh-CN', 'zh'], ['zh_TW.UTF-8', 'zh'], ['en-US', 'en'], ['fr-FR', 'en']]) {
    const page = await openBoard('pages', { language })
    assert.equal(page.latest().lang, expected, language)
    page.restore()
  }
  const page = await openBoard('pages', { language: 'en-US' })
  const auth = () => byName(page.latest(), 'Migrate auth to OAuth2')
  assert.equal(auth().surface, 'VS Code')
  assert.ok(auth().now.startsWith('Waiting for your answer: '))
  await page.api.postLang('zh')
  assert.equal(page.latest().lang, 'zh')
  assert.equal(auth().surface, 'VSCode')
  assert.ok(auth().now.startsWith('等你回答：'), auth().now)
  await page.api.postLang('en')
  assert.equal(page.latest().lang, 'en')
  noNetwork(page)
  page.restore()
})

test('S3 session writes: rename, group, retire, restore, with the server rules and wording', async () => {
  const page = await openBoard('pages')
  const first = page.latest()
  const auth = byName(first, 'Migrate auth to OAuth2')
  await page.api.postAction(auth.sessionId, 'rename', { name: '  Renamed in demo  ' })
  assert.equal(page.latest().strips.some((strip) => strip.sessionId === auth.sessionId && strip.name === 'Renamed in demo'), true)
  await assert.rejects(page.api.postAction(auth.sessionId, 'rename', { name: '' }), (err) => err.status === 400)
  await assert.rejects(page.api.postAction(auth.sessionId, 'rename', { name: 'two\nlines' }), (err) => err.status === 400)
  await assert.rejects(page.api.postAction('de100099-0000-4000-8000-000000000000', 'rename', { name: 'x' }), (err) => err.status === 404)

  const checkout = groupNamed(first, 'Checkout')
  await page.api.postAction(auth.sessionId, 'group', { groupId: checkout.id })
  assert.equal(page.latest().strips.find((strip) => strip.sessionId === auth.sessionId).groupId, checkout.id)
  await page.api.postAction(auth.sessionId, 'group', { groupId: null })
  assert.equal(page.latest().strips.find((strip) => strip.sessionId === auth.sessionId).groupId, null)

  // An interactive session is only hidden; a running background session is stopped first, so it stays hidden instead of coming straight back
  const docs = byName(first, 'Write v2 API docs')
  const audit = byName(first, 'Nightly dependency audit')
  await page.api.postAction(docs.sessionId, 'retire')
  await page.api.postAction(audit.sessionId, 'retire')
  await page.api.postLang('en')
  const retired = page.latest()
  assert.deepEqual(new Set(retired.retired.map((row) => row.name)), new Set(['Write v2 API docs', 'Nightly dependency audit']))
  assert.equal(retired.strips.some((strip) => strip.sessionId === audit.sessionId), false)

  await page.api.postAction(docs.sessionId, 'unretire')
  assert.deepEqual(page.latest().retired.map((row) => row.name), ['Nightly dependency audit'])
  assert.equal(page.latest().strips.some((strip) => strip.sessionId === docs.sessionId), true)
  noNetwork(page)
  page.restore()
})

test('S4 group writes: create, rename, drag reorder, delete, with the server rules', async () => {
  const page = await openBoard('pages')
  const auth = byName(page.latest(), 'Migrate auth to OAuth2')
  await page.api.postGroup('create', { name: 'Scratch', sessionId: auth.sessionId })
  const scratch = groupNamed(page.latest(), 'Scratch')
  assert.equal(page.latest().strips.find((strip) => strip.sessionId === auth.sessionId).groupId, scratch.id)
  assert.match(scratch.id, /^g[0-9a-f]{8}$/)

  await page.api.postGroup('rename', { id: scratch.id, name: 'Scratch pad' })
  assert.ok(groupNamed(page.latest(), 'Scratch pad'))
  await assert.rejects(page.api.postGroup('rename', { id: scratch.id, name: '' }), (err) => err.status === 400)
  await assert.rejects(page.api.postGroup('create', { name: 'Platform' }), (err) => err.status === 409)
  await assert.rejects(page.api.postGroup('rename', { id: 'g00000000', name: 'x' }), (err) => err.status === 404)
  await assert.rejects(page.api.postGroup('create', { name: 'x'.repeat(31) }), (err) => err.status === 400)

  // Dragging a header sends "move before whom"; null means the end. "Ungrouped" (id none) takes part like a group
  const names = () => page.latest().groups.map((group) => group.name)
  const ids = Object.fromEntries(page.latest().groups.map((group) => [group.name, group.id]))
  assert.deepEqual(names(), ['Platform', 'Checkout', 'Docs', 'Scratch pad'])
  await page.api.postGroup('move', { id: ids['Scratch pad'], before: ids.Platform })
  assert.deepEqual(names(), ['Scratch pad', 'Platform', 'Checkout', 'Docs'])
  await page.api.postGroup('move', { id: ids['Scratch pad'], before: null })
  assert.deepEqual(names(), ['Platform', 'Checkout', 'Docs', 'Scratch pad'])
  await page.api.postGroup('move', { id: 'none', before: ids.Platform })
  assert.equal(page.latest().ungroupedAt, 0)
  await assert.rejects(page.api.postGroup('move', { id: ids.Docs, before: 'g00000000' }), (err) => err.status === 404)

  // Deleting a group sends its sessions back to ungrouped
  await page.api.postGroup('delete', { id: scratch.id })
  assert.equal(groupNamed(page.latest(), 'Scratch pad'), undefined)
  assert.equal(page.latest().strips.find((strip) => strip.sessionId === auth.sessionId).groupId, null)
  noNetwork(page)
  page.restore()
})

test('S5 writes live in memory only: a fresh load starts from the fixtures again', async () => {
  const one = await openBoard('pages')
  await one.api.postGroup('rename', { id: groupNamed(one.latest(), 'Docs').id, name: 'Changed' })
  await one.api.postLang('zh')
  const two = await openBoard('pages')
  assert.deepEqual(two.latest().groups.map((group) => group.name), ['Platform', 'Checkout', 'Docs'])
  assert.equal(two.latest().lang, 'en')
  one.restore()
  two.restore()
})

test('S6 a delivered snapshot is a copy: a later write does not change it behind the page', async () => {
  const page = await openBoard('pages')
  const before = page.latest()
  await page.api.postGroup('rename', { id: groupNamed(before, 'Docs').id, name: 'Changed' })
  assert.ok(groupNamed(before, 'Docs'), 'the earlier snapshot was edited in place')
  assert.ok(groupNamed(page.latest(), 'Changed'))
  page.restore()
})

test('S7 the board refreshes every few seconds while someone watches, and stops when the last one leaves', async () => {
  const page = await openBoard('pages', { subscribe: false })
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const seen = []
    const stop = page.board.subscribe((snapshot) => seen.push(snapshot))
    assert.equal(seen.length, 1, 'the first snapshot arrives at once')
    mock.timers.tick(2900)
    assert.equal(seen.length, 1)
    mock.timers.tick(100)
    assert.equal(seen.length, 2, 'a new one after 3 s')
    stop()
    mock.timers.tick(10_000)
    assert.equal(seen.length, 2, 'nothing after the last subscriber left')
  } finally {
    mock.timers.reset()
  }
  page.restore()
})

test('S8 contrast: the same api layer in a normal build does call the server', async () => {
  const page = await openBoard('development')
  await page.api.postLang('zh')
  await page.api.postGroup('create', { name: 'x' })
  await page.api.postAction('de100001-7e57-4000-8000-000000000001', 'retire')
  assert.deepEqual(page.calls.fetch, ['/api/settings', '/api/groups/create', '/api/sessions/de100001-7e57-4000-8000-000000000001/retire'])
  page.restore()
})
