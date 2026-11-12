// The dictionaries and the language-dependent text the server writes.
//   D (dictionaries): en.ts and zh.ts have the same keys and the same {placeholders} (a type cannot check the latter),
//     English has no Chinese in it, and plural messages pick the right form.
//   A (tool actions): the digest keeps data, so the same action reads in whichever language is current.
//   B (briefs): Haiku is asked in the page's language, every cache keeps one section per language, switching never shows
//     the other language's text and never pays twice for the same one, and a job name is only translated when it has to be.
// The TypeScript runs through tsx in a subprocess, like test/paths.test.mjs; `claude` is a fake that records its arguments.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TSX = import.meta.resolve('tsx')
const roots = []
const CJK = /[㐀-鿿]/

after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fs-i18n-')))
  roots.push(dir)
  return dir
}

function runTs(script, args = [], env = {}) {
  const result = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', script, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result
}

const placeholders = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))
const forms = (entry) => (typeof entry === 'string' ? [entry] : [entry.one, entry.other])
const placeholdersOf = (entry) => new Set(forms(entry).flatMap((form) => [...placeholders(form)]))

const dump = runTs(`
  const i18n = await import(process.argv[1])
  const { t, langFromLocale, isLang, dictionaries } = i18n
  console.log(JSON.stringify({
    dictionaries,
    sessions: [0, 1, 2].map((n) => t('en', 'status.sessions', { n, time: '12:00' })),
    sessionsZh: t('zh', 'status.sessions', { n: 1, time: '12:00' }),
    needs: [1, 2].map((n) => t('en', 'group.summary.needs', { n })),
    hoursMinutes: t('en', 'time.hoursMinutes', { hours: 1, minutes: 5 }),
    locales: ['zh', 'zh-CN', 'zh_TW.UTF-8', 'ZH-hans', 'en-US', 'fr', '', null, undefined, 'zhx'].map((l) => langFromLocale(l)),
    langs: ['en', 'zh', 'EN', 'fr', null].map((l) => isLang(l)),
  }))
`, [join(REPO, 'shared', 'i18n', 'index.ts')])
const loaded = JSON.parse(dump.stdout)
const { en, zh } = loaded.dictionaries

test('D1 zh has exactly the keys of en', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('D2 every message has the same {placeholders} in both languages', () => {
  for (const key of Object.keys(en)) {
    assert.deepEqual([...placeholdersOf(zh[key])].sort(), [...placeholdersOf(en[key])].sort(), key)
  }
})

test('D3 a plural message uses {n}, and only plural messages are objects', () => {
  for (const [key, entry] of Object.entries(en)) {
    if (typeof entry === 'string') continue
    assert.deepEqual(Object.keys(entry).sort(), ['one', 'other'], key)
    assert.ok(forms(entry).every((form) => placeholders(form).has('n')), `${key} should use {n} in both forms`)
  }
  for (const [key, entry] of Object.entries(zh)) {
    assert.ok(typeof entry === 'string' || typeof en[key] !== 'string', `${key}: zh has a plural for a plain English message`)
  }
})

test('D4 the English dictionary has no Chinese and no empty message', () => {
  for (const [key, entry] of Object.entries(en)) {
    for (const form of forms(entry)) {
      assert.ok(!CJK.test(form), `${key}: ${form}`)
      assert.ok(form.trim() !== '', key)
    }
  }
  for (const [key, entry] of Object.entries(zh)) assert.ok(forms(entry).every((form) => form.trim() !== ''), key)
})

test('D5 English plurals pick the right form, Chinese has just one', () => {
  assert.deepEqual(loaded.sessions, [
    '0 sessions on this machine, updated 12:00', '1 session on this machine, updated 12:00', '2 sessions on this machine, updated 12:00',
  ])
  assert.equal(loaded.sessionsZh, '本机 1 个 session，12:00 更新')
  assert.deepEqual(loaded.needs, ['1 needs you', '2 need you'])
  assert.equal(loaded.hoursMinutes, '1 h 5 min')
})

test('D6 locale and language detection', () => {
  assert.deepEqual(loaded.locales, ['zh', 'zh', 'zh', 'zh', 'en', 'en', 'en', 'en', 'en', 'zh'])
  assert.deepEqual(loaded.langs, [true, true, false, false, false])
})

test('A1 a tool action reads in the current language, and unknown tools keep their own name', () => {
  const out = JSON.parse(runTs(`
    const { describeAction } = await import(process.argv[1])
    const { translator } = await import(process.argv[2])
    const [en, zh] = [translator('en'), translator('zh')]
    const read = { kind: 'tool', tool: 'Read', hint: 'src/a.ts' }
    console.log(JSON.stringify({
      en: describeAction(read, en), zh: describeAction(read, zh),
      task: describeAction({ kind: 'tool', tool: 'Task', hint: null }, en),
      mcp: describeAction({ kind: 'tool', tool: 'mcp__x__y', hint: null }, en),
      proto: describeAction({ kind: 'tool', tool: 'constructor', hint: null }, en),
      none: describeAction({ kind: 'tool', tool: null, hint: null }, en),
      answered: [describeAction({ kind: 'answered' }, en), describeAction({ kind: 'answered' }, zh)],
    }))
  `, [join(REPO, 'server', 'transcript.ts'), join(REPO, 'shared', 'i18n', 'index.ts')]).stdout)
  assert.deepEqual(out, {
    en: 'Reading a file: src/a.ts', zh: '读文件：src/a.ts', task: 'Starting a subtask', mcp: 'mcp__x__y',
    proto: 'constructor', none: 'Using a tool', answered: ['Got your answer, continuing', '收到你的回答，继续中'],
  })
})

// ---- briefs ----

/** A stand-in for `claude -p`: logs the system prompt and the input, and answers in the language the prompt asked for */
function fakeClaude(dir) {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const script = join(bin, 'claude')
  writeFileSync(script, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.indexOf('--system-prompt') + 1] ?? ''
const input = readFileSync(0, 'utf8')
appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({ prompt, input }) + '\\n')
const english = /Write in English|plain English|English name/.test(prompt)
let result
if (prompt.includes('"done"')) result = JSON.stringify({ done: [1], progress: english ? 'Login works; waiting for review.' : '登录已经好了，等人看。' })
else if (/English name|16 个汉字/.test(prompt)) result = input.split('\\n').map((_, i) => (i + 1) + '. ' + (english ? 'Name ' : '名字') + (i + 1)).join('\\n')
else result = english ? '- Fix the login\\n- Ship it' : '- 修好登录\\n- 上线'
console.log(JSON.stringify({ result, num_turns: 1, total_cost_usd: 0.0001 }))
`)
  chmodSync(script, 0o755)
  return { bin, calls: () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []) }
}

const briefScript = `
  const { startBriefs, requestBrief, briefOf, jobNameOf } = await import(process.argv[1])
  const { saveLang } = await import(process.argv[2])
  await startBriefs(() => {})
  const wait = async (done) => { for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 25)) }
  const id = 'aaaaaaaa-1111-4222-8333-444444444444'
  const job = { sessionId: id, opening: ['Please fix the login bug'], manual: null, activityKey: 'k1', settled: true, priority: 0,
    recent: [{ role: 'you', text: 'fix it' }, { role: 'agent', text: 'done' }, { role: 'now', text: 'idle' }] }
  const seen = {}
  requestBrief(job)
  await wait(() => briefOf(id).progress !== null)
  seen.en = briefOf(id)
  await saveLang('zh')
  seen.zhBefore = briefOf(id)
  requestBrief(job)
  await wait(() => briefOf(id).progress !== null)
  seen.zh = briefOf(id)
  await saveLang('en')
  seen.enAgain = briefOf(id)
  requestBrief(job)
  await new Promise((r) => setTimeout(r, 200))
  const english = 'Run the checkout spec 50 times'
  seen.nameEn = jobNameOf(english)
  await new Promise((r) => setTimeout(r, 200))
  await saveLang('zh')
  seen.nameZhFirst = jobNameOf(english)
  await wait(() => jobNameOf(english) !== english)
  seen.nameZh = jobNameOf(english)
  seen.chineseInZh = jobNameOf('跑一遍结账测试')
  await saveLang('en')
  seen.chineseInEn = jobNameOf('跑一遍结账测试')
  await wait(() => jobNameOf('跑一遍结账测试') !== '跑一遍结账测试')
  seen.chineseInEnNamed = jobNameOf('跑一遍结账测试')
  console.log('RESULT ' + JSON.stringify(seen))
`

/** Runs the scenario above once; B1 and B2 read different parts of it */
let scenario = null
function briefScenario() {
  if (scenario === null) {
    const dir = tempDir()
    const state = join(dir, 'state')
    mkdirSync(state)
    const claude = fakeClaude(dir)
    // brief.ts logs its call costs to stdout; the scenario's own result is the line marked RESULT
    const stdout = runTs(briefScript, [join(REPO, 'server', 'brief.ts'), join(REPO, 'server', 'lang.ts')], {
      HOME: dir, FLIGHTSTRIP_STATE_DIR: state, FLIGHTSTRIP_LANG: 'en', PATH: `${claude.bin}:${process.env.PATH}`,
    }).stdout
    const out = JSON.parse(stdout.split('\n').find((line) => line.startsWith('RESULT ')).slice('RESULT '.length))
    scenario = { out, state, claude }
  }
  return scenario
}

test('B1 briefs are asked for and cached per language, and switching never shows the other one', () => {
  const { out, state, claude } = briefScenario()

  assert.deepEqual(out.en.todos.map((todo) => todo.text), ['Fix the login', 'Ship it'])
  assert.equal(out.en.progress, 'Login works; waiting for review.')
  assert.deepEqual(out.zhBefore, { todos: null, progress: null, progressAt: null }, 'English text must not show up in the Chinese page')
  assert.deepEqual(out.zh.todos.map((todo) => todo.text), ['修好登录', '上线'])
  assert.equal(out.zh.progress, '登录已经好了，等人看。')
  assert.deepEqual(out.enAgain.todos.map((todo) => todo.text), ['Fix the login', 'Ship it'], 'switching back finds the English text still cached')

  const calls = claude.calls()
  const askedFor = (pattern) => calls.filter((call) => pattern.test(call.prompt))
  assert.equal(askedFor(/Write in English/).length, 1, 'one English todo call, none after switching back')
  assert.equal(askedFor(/in plain English/).length, 1, 'one English progress call')
  assert.equal(askedFor(/待办/).length >= 2, true, 'Chinese prompts were used for the Chinese page')
  assert.ok(calls.every((call) => !(CJK.test(call.prompt) && /Write in/.test(call.prompt))), 'a prompt is in one language only')
  const enProgress = calls.find((call) => /in plain English/.test(call.prompt))
  assert.match(enProgress.input, /^To-do list:\n1\. Fix the login\n2\. Ship it\n\nRecent conversation:\nUser: fix it\nAI: done\nNow: idle$/)
  const zhProgress = calls.find((call) => call.prompt.includes('"done"') && CJK.test(call.prompt))
  assert.match(zhProgress.input, /^待办清单：\n1\. 修好登录\n2\. 上线\n\n最近的对话记录：\n用户：fix it\nAI：done\n现在：idle$/)

  const saved = JSON.parse(readFileSync(join(state, 'briefs.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved).sort(), ['en', 'zh'])
  assert.ok(saved.en['aaaaaaaa-1111-4222-8333-444444444444'] && saved.zh['aaaaaaaa-1111-4222-8333-444444444444'])
  assert.equal(JSON.parse(readFileSync(join(state, 'settings.json'), 'utf8')).lang, 'en', 'the last switch was saved')
})

test('B2 a job description is translated only when its language differs from the page', () => {
  const { out, state, claude } = briefScenario()

  const english = 'Run the checkout spec 50 times'
  assert.equal(out.nameEn, english, 'an English description in an English page is shown as is')
  assert.equal(out.nameZhFirst, english, 'until its Chinese name arrives the original is shown')
  assert.match(out.nameZh, /^名字\d+$/)
  assert.equal(out.chineseInZh, '跑一遍结账测试', 'a Chinese description in a Chinese page is shown as is')
  assert.equal(out.chineseInEn, '跑一遍结账测试')
  assert.match(out.chineseInEnNamed, /^Name \d+$/, 'a Chinese description in an English page gets an English name')

  const nameCalls = claude.calls().filter((call) => /English name|16 个汉字/.test(call.prompt))
  assert.equal(nameCalls.length, 2, 'exactly one call per direction, none for the untranslated cases')
  assert.equal(nameCalls.some((call) => call.input.includes(english) && /English name/.test(call.prompt)), false, 'English text was never sent to be "translated" into English')
  const names = JSON.parse(readFileSync(join(state, 'job-names.json'), 'utf8'))
  assert.deepEqual(Object.keys(names.zh), [english])
  assert.deepEqual(Object.keys(names.en), ['跑一遍结账测试'])
})

test('B3 an older cache file in the flat format is ignored, not misread as a language', () => {
  const dir = tempDir()
  const state = join(dir, 'state')
  mkdirSync(state)
  writeFileSync(join(state, 'briefs.json'), JSON.stringify({ 'aaaaaaaa-1111-4222-8333-444444444444': { todoKey: 'x', todos: ['旧的'], progressKey: null, progress: '旧的进展', done: [], progressAt: 1, failedAt: null } }))
  writeFileSync(join(state, 'job-names.json'), JSON.stringify({ en: 'a job whose description is the word en', 'a description': '旧名字' }))
  const out = JSON.parse(runTs(`
    const { startBriefs, briefOf } = await import(process.argv[1])
    await startBriefs(() => {})
    console.log('RESULT ' + JSON.stringify(briefOf('aaaaaaaa-1111-4222-8333-444444444444')))
  `, [join(REPO, 'server', 'brief.ts')], { HOME: dir, FLIGHTSTRIP_STATE_DIR: state, PATH: process.env.PATH }).stdout.split('\n').find((line) => line.startsWith('RESULT ')).slice('RESULT '.length))
  assert.deepEqual(out, { todos: null, progress: null, progressAt: null })
})
