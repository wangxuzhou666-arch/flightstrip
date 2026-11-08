#!/usr/bin/env node
// Writes todos from inside any Claude Code session onto that session's strip on the dashboard. Zero dependencies.
// Attributed by CLAUDE_CODE_SESSION_ID, which Claude Code sets in the command-line environment of every session
// (measured 2026-11-07).
// Writes <state dir>/todos/<sessionId>.json; the dashboard watches that directory and shows it within 1 second.
// While that file exists the strip no longer uses the todos Haiku extracted.
// The state dir is FLIGHTSTRIP_STATE_DIR or ~/.flightstrip, the same default as server/config.ts (repeated here because
// this script runs standalone). If the server runs with a custom FLIGHTSTRIP_STATE_DIR, the session's environment
// needs the same variable, or the todos land in the wrong directory.
// Messages are printed in the dashboard's language (see languageOf), English by default.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const STATE_DIR = resolve(process.env.FLIGHTSTRIP_STATE_DIR || join(homedir(), '.flightstrip'))
const TODO_DIR = join(STATE_DIR, 'todos')
const MAX_ITEMS = 12
const MAX_TEXT = 80

/**
 * The language of everything printed here: the choice saved by the page's toggle (<state dir>/settings.json), else
 * FLIGHTSTRIP_LANG, else the system locale, else English: the same order as server/lang.ts, so the checklist a session
 * writes comes out in the language the board shows.
 */
function languageOf() {
  let saved
  try {
    saved = JSON.parse(readFileSync(join(STATE_DIR, 'settings.json'), 'utf8'))?.lang
  } catch {
    // No settings file yet, or one that is not valid JSON: fall through to the environment
  }
  if (saved === 'en' || saved === 'zh') return saved
  const env = (process.env.FLIGHTSTRIP_LANG ?? '').toLowerCase()
  if (env === 'en' || env === 'zh') return env
  // Same last step as server/lang.ts: a Chinese system locale gets Chinese, so the board and the session agree
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const TEXT = {
  en: {
    help: `Usage (run inside a Claude Code session; the list goes onto that session's strip automatically):
  todo.mjs set "item 1" "item 2" …   replace the whole list
  todo.mjs add "item" …              append
  todo.mjs done 2 [3 …]              tick item 2 (counting from 1)
  todo.mjs undo 2 [3 …]              untick
  todo.mjs clear                     empty the list; the strip goes back to the to-dos Haiku extracts from the opening
  todo.mjs show                      print the current list`,
    noSession: 'CLAUDE_CODE_SESSION_ID is not set: run this inside a Claude Code session',
    emptyItem: 'A to-do cannot be empty',
    needNumbers: (command) => `${command} needs item numbers after it, e.g. ${command} 2`,
    noSuchItem: (arg, count) => `There is no item ${arg}; the list has ${count} ${count === 1 ? 'item' : 'items'}`,
    needsOne: (command) => `${command} needs at least one item`,
    unknownCommand: (command, help) => `Unknown command: ${command}\n${help}`,
    tooMany: (count) => `At most ${MAX_ITEMS} items, got ${count}`,
    emptyList: 'This session has no hand-written to-dos on the board (its strip shows the ones Haiku extracted from the opening)',
  },
  zh: {
    help: `用法（在 Claude Code session 里执行，自动归到当前 session 的纸条）：
  todo.mjs set "待办1" "待办2" …   整份替换
  todo.mjs add "待办" …            追加
  todo.mjs done 2 [3 …]           勾掉第 2 条（从 1 数）
  todo.mjs undo 2 [3 …]           取消勾选
  todo.mjs clear                  清空，纸条退回 Haiku 从开场提炼的待办
  todo.mjs show                   看当前清单`,
    noSession: '没有 CLAUDE_CODE_SESSION_ID：要在 Claude Code session 里执行',
    emptyItem: '待办不能是空的',
    needNumbers: (command) => `${command} 后面要跟编号，比如 ${command} 2`,
    noSuchItem: (arg, count) => `没有第 ${arg} 条，现在共 ${count} 条`,
    needsOne: (command) => `${command} 至少要一条`,
    unknownCommand: (command, help) => `不认识的命令：${command}\n${help}`,
    tooMany: (count) => `最多 ${MAX_ITEMS} 条，现在 ${count} 条`,
    emptyList: '看板上这个 session 没有手动待办（纸条显示 Haiku 从开场提炼的）',
  },
}[languageOf()]

function fail(message) {
  console.error(message)
  process.exit(1)
}

const [command = 'help', ...args] = process.argv.slice(2)
if (command === 'help' || command === '--help') {
  console.log(TEXT.help)
  process.exit(0)
}
const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? ''
if (!/^[0-9a-f-]{36}$/.test(sessionId)) fail(TEXT.noSession)
const file = join(TODO_DIR, `${sessionId}.json`)

function load() {
  try {
    const items = JSON.parse(readFileSync(file, 'utf8')).items
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

function save(items) {
  mkdirSync(TODO_DIR, { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify({ items, updatedAt: Date.now() }))
  renameSync(temp, file)
}

function cleanText(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (!flat) fail(TEXT.emptyItem)
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat
}

/** "2", "3" → indexes; out of range fails loudly instead of being ignored */
function positions(items) {
  if (args.length === 0) fail(TEXT.needNumbers(command))
  return args.map((arg) => {
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1 || n > items.length) fail(TEXT.noSuchItem(arg, items.length))
    return n - 1
  })
}

let items = load()
switch (command) {
  case 'set':
    if (args.length === 0) fail(TEXT.needsOne(command))
    items = args.map((text) => ({ text: cleanText(text), done: false }))
    break
  case 'add':
    if (args.length === 0) fail(TEXT.needsOne(command))
    items = [...items, ...args.map((text) => ({ text: cleanText(text), done: false }))]
    break
  case 'done':
  case 'undo':
    for (const i of positions(items)) items[i].done = command === 'done'
    break
  case 'clear':
    items = []
    break
  case 'show':
    break
  default:
    fail(TEXT.unknownCommand(command, TEXT.help))
}
if (items.length > MAX_ITEMS) fail(TEXT.tooMany(items.length))
if (command !== 'show') save(items)

if (items.length === 0) console.log(TEXT.emptyList)
else console.log(items.map((item, i) => `${item.done ? '[x]' : '[ ]'} ${i + 1}. ${item.text}`).join('\n'))
