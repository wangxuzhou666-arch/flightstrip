// hooks/todo-reminder.mjs, case by case from the reference bash hook's test:
//   S (must print nothing): todo.mjs missing, input not JSON, session id with ../
//   N (must ask for a checklist): no todos yet, corrupt todo file; the contrast to S, proving "silent" isn't "blind"
//   L (must inject the checklist): numbering from 1, ticks matching, and a hint to run `done N`
//   P: the command is written with ~/ under HOME instead of an absolute path in the context
// Each test builds the layout `flightstrip setup` produces (<state dir>/bin/{todo.mjs,todo-reminder.mjs}) in a temp
// HOME, so nothing reads the real ~/.flightstrip.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SID = '5e551011-aaaa-4bbb-8ccc-000000000001'
const CORRUPT = '5e551011-aaaa-4bbb-8ccc-000000000002'
const NO_TODOS = '00000000-0000-0000-0000-000000000000'
const BROKEN_ITEMS = '3f1c2b4a-0000-4000-8000-00000000abcd'
const roots = []

after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

/** A temp HOME with the installed layout under <home>/.flightstrip, or under `stateParent` when given */
function install({ todoScript = true, stateParent } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fs-hook-')))
  roots.push(root)
  const home = join(root, 'home')
  const state = stateParent === undefined ? join(home, '.flightstrip') : join(stateParent, 'state')
  const bin = join(state, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(join(state, 'todos'), { recursive: true })
  copyFileSync(join(REPO, 'hooks', 'todo-reminder.mjs'), join(bin, 'todo-reminder.mjs'))
  if (todoScript) copyFileSync(join(REPO, 'scripts', 'todo.mjs'), join(bin, 'todo.mjs'))
  const todos = (id, text) => writeFileSync(join(state, 'todos', `${id}.json`), text)
  todos(SID, JSON.stringify({ items: [{ text: 'Alpha', done: true }, { text: 'Beta', done: false }], updatedAt: 1 }))
  todos(CORRUPT, '{"items": [')
  todos(BROKEN_ITEMS, JSON.stringify({ items: [{ text: 'fine', done: false }, { done: true }] }))
  return { home, state, hook: join(bin, 'todo-reminder.mjs') }
}

function run({ home, state, hook }, input, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: home, ...extraEnv }
  const result = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env, timeout: 10_000 })
  assert.equal(result.status, 0, `the hook must never fail the prompt, got ${result.status}: ${result.stderr}`)
  return result.stdout
}

const withSession = (id) => JSON.stringify({ session_id: id })

test('S1 stays silent when todo.mjs is not next to the hook', () => {
  assert.equal(run(install({ todoScript: false }), withSession(SID)), '')
})

test('S2 stays silent when the input is not JSON', () => {
  assert.equal(run(install(), 'not json'), '')
})

test('S2b stays silent for JSON that is not an object with a session_id', () => {
  const setup = install()
  for (const input of ['null', '[]', '"text"', '42', '{}', '{"session_id":null}', '{"session_id":123}', '']) {
    assert.equal(run(setup, input), '', `input ${JSON.stringify(input)}`)
  }
})

test('S3 stays silent for a session id that tries to leave the todos directory', () => {
  const setup = install()
  assert.equal(run(setup, withSession('../../etc/passwd-0000-0000-0000-000000')), '')
  assert.equal(run(setup, withSession('../' + SID.slice(3))), '')
  // Right length, right alphabet except one uppercase letter: the shape check is strict
  assert.equal(run(setup, withSession(SID.toUpperCase())), '')
})

test('S4 does not hang or fail on input larger than the 64 KB it reads', () => {
  assert.equal(run(install(), `{"session_id":"${'x'.repeat(200_000)}"}`), '')
})

test('N1 asks for a checklist when the session has none yet', () => {
  const out = run(install(), withSession(NO_TODOS))
  assert.match(out, /^\[flightstrip-todo\] /)
  assert.match(out, /no goal checklist/)
  assert.match(out, / set "…" "…"/)
  assert.match(out, /2–6/)
})

test('N2 treats a corrupt todo file as "none yet"', () => {
  const out = run(install(), withSession(CORRUPT))
  assert.match(out, /no goal checklist/)
  assert.match(out, / set /)
})

test('N3 treats items without text as "none yet", so numbers can never point at the wrong item', () => {
  assert.match(run(install(), withSession(BROKEN_ITEMS)), /no goal checklist/)
})

test('L1 injects the checklist numbered from 1 with the right ticks, and says to run done N', () => {
  const out = run(install(), withSession(SID))
  assert.match(out, /^\[flightstrip-todo\] /)
  assert.ok(out.includes('1✓ Alpha; 2☐ Beta'), out)
  assert.match(out, / done N/)
  assert.doesNotMatch(out, /no goal checklist/)
})

test('P1 writes the command with ~/ when the state dir is under HOME', () => {
  const out = run(install(), withSession(SID))
  assert.ok(out.includes('node ~/.flightstrip/bin/todo.mjs done N'), out)
})

test('P2 keeps ~/ when HOME itself sits behind a symlink (macOS /var -> /private/var)', () => {
  const setup = install()
  const link = join(dirname(setup.home), 'home-link')
  symlinkSync(setup.home, link)
  const out = run({ ...setup, home: link }, withSession(SID))
  assert.ok(out.includes('node ~/.flightstrip/bin/todo.mjs done N'), out)
})

test('P3 writes an absolute path for a state dir outside HOME', () => {
  const setup = install({ stateParent: join(realpathSync(mkdtempSync(join(tmpdir(), 'fs-hook-out-'))), 'elsewhere') })
  roots.push(dirname(dirname(setup.state)))
  const out = run(setup, withSession(SID), { FLIGHTSTRIP_STATE_DIR: setup.state })
  assert.ok(out.includes(`node ${join(setup.state, 'bin', 'todo.mjs')} done N`), out)
  assert.ok(!out.includes('~'), out)
})

test('P4 quotes a path with spaces so the command can be pasted as is', () => {
  const setup = install({ stateParent: join(realpathSync(mkdtempSync(join(tmpdir(), 'fs-hook-out-'))), 'my dir') })
  roots.push(dirname(dirname(setup.state)))
  const out = run(setup, withSession(SID), { FLIGHTSTRIP_STATE_DIR: setup.state })
  assert.ok(out.includes(`node "${join(setup.state, 'bin', 'todo.mjs')}" done N`), out)
})

test('R1 shows what todo.mjs wrote: set, then done 1', () => {
  const setup = install()
  const id = 'aaaaaaaa-1111-4222-8333-444444444444'
  const todo = (...args) => spawnSync(process.execPath, [join(setup.state, 'bin', 'todo.mjs'), ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: setup.home, CLAUDE_CODE_SESSION_ID: id },
  })
  assert.equal(todo('set', 'Write the parser', 'Ship it').status, 0)
  assert.ok(run(setup, withSession(id)).includes('1☐ Write the parser; 2☐ Ship it'))
  assert.equal(todo('done', '1').status, 0)
  assert.ok(run(setup, withSession(id)).includes('1✓ Write the parser; 2☐ Ship it'))
})

// ---- language: the hook, todo.mjs and statusline.mjs print in the dashboard's language ----
//   saved choice (<state dir>/settings.json) first, then FLIGHTSTRIP_LANG, then the system locale, then English;
//   anything unusable is skipped

const saveSettings = ({ state }, text) => writeFileSync(join(state, 'settings.json'), text)
const saveLang = (setup, lang) => saveSettings(setup, JSON.stringify({ lang }))

test('Z1 the hook speaks Chinese when the dashboard is set to Chinese', () => {
  const setup = install()
  saveLang(setup, 'zh')
  const ask = run(setup, withSession(NO_TODOS))
  assert.match(ask, /^\[flightstrip-todo\] /)
  assert.match(ask, /还没有目标清单/)
  assert.ok(ask.includes('node ~/.flightstrip/bin/todo.mjs set "…" "…"'), ask)
  assert.doesNotMatch(ask, /no goal checklist/)
  const list = run(setup, withSession(SID))
  assert.ok(list.includes('1✓ Alpha; 2☐ Beta'), list)
  assert.match(list, /目标清单/)
  assert.ok(list.includes('done N'), list)
})

test('Z2 the saved choice beats FLIGHTSTRIP_LANG, which beats the system locale, then English; unusable values are skipped', () => {
  const setup = install()
  assert.match(run(setup, withSession(NO_TODOS)), /no goal checklist/, 'nothing set: English')
  assert.match(run(setup, withSession(NO_TODOS), { LANG: 'zh_CN.UTF-8' }), /还没有目标清单/, 'Chinese system locale: Chinese')
  assert.match(run(setup, withSession(NO_TODOS), { LANG: 'zh_CN.UTF-8', FLIGHTSTRIP_LANG: 'en' }), /no goal checklist/, 'env beats the locale')
  assert.match(run(setup, withSession(NO_TODOS), { FLIGHTSTRIP_LANG: 'zh' }), /还没有目标清单/, 'env: Chinese')
  assert.match(run(setup, withSession(NO_TODOS), { FLIGHTSTRIP_LANG: 'ZH' }), /还没有目标清单/, 'env is case-insensitive')
  assert.match(run(setup, withSession(NO_TODOS), { FLIGHTSTRIP_LANG: 'fr' }), /no goal checklist/, 'an unknown env value falls back to English')
  saveLang(setup, 'en')
  assert.match(run(setup, withSession(NO_TODOS), { FLIGHTSTRIP_LANG: 'zh' }), /no goal checklist/, 'saved en beats env zh')
  saveLang(setup, 'zh')
  assert.match(run(setup, withSession(NO_TODOS), { FLIGHTSTRIP_LANG: 'en' }), /还没有目标清单/, 'saved zh beats env en')
  for (const junk of ['{"lang":"fr"}', '{"lang":null}', '{"lang": ', 'null', '[]']) {
    saveSettings(setup, junk)
    assert.match(run(setup, withSession(NO_TODOS), { FLIGHTSTRIP_LANG: 'zh' }), /还没有目标清单/, `junk ${junk} is skipped for the env value`)
    assert.match(run(setup, withSession(NO_TODOS)), /no goal checklist/, `junk ${junk} falls back to English`)
  }
})

test('Z3 todo.mjs words its messages in the same language', () => {
  const setup = install()
  const id = 'bbbbbbbb-1111-4222-8333-444444444444'
  const todo = (...args) => spawnSync(process.execPath, [join(setup.state, 'bin', 'todo.mjs'), ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: setup.home, CLAUDE_CODE_SESSION_ID: id },
  })
  assert.match(todo('show').stdout, /no hand-written to-dos/)
  assert.match(todo('done', '9').stderr, /There is no item 9; the list has 0 items/)
  assert.match(todo('help').stdout, /replace the whole list/)
  saveLang(setup, 'zh')
  assert.match(todo('show').stdout, /没有手动待办/)
  const bad = todo('done', '9')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /没有第 9 条，现在共 0 条/)
  assert.match(todo('help').stdout, /整份替换/)
  assert.equal(todo('set', 'One').status, 0)
  assert.equal(todo('show').stdout.trim(), '[ ] 1. One', 'the list itself is not translated')
})

test('Z4 the statusline words its labels in the same language', () => {
  const setup = install()
  const bar = (env = {}) => spawnSync(process.execPath, [join(REPO, 'scripts', 'statusline.mjs')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: setup.home, ...env },
    input: JSON.stringify({ session_id: SID, rate_limits: { seven_day: { used_percentage: 41 }, five_hour: { used_percentage: 27.4 } } }),
  }).stdout
  assert.equal(bar(), 'Week 41%  5 h 27%')
  assert.equal(bar({ FLIGHTSTRIP_LANG: 'zh' }), '本周 41%  5 小时 27%')
  saveLang(setup, 'en')
  assert.equal(bar({ FLIGHTSTRIP_LANG: 'zh' }), 'Week 41%  5 h 27%')
})
