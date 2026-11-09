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
const MAX_OPEN = 12
// Finished items stay listed only while they are among the last few ticked; older ones drop off and are only counted,
// so a long session's list never fills up with done work. Every item keeps the number it was given when added, and
// numbers are never reused: dropping an item can't shift what `done N` points at, even between two calls in one turn
const KEEP_DONE = 3
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
  todo.mjs done 2 [3 …]              tick item 2 (numbers never change; only the last ${KEEP_DONE} finished items stay listed)
  todo.mjs undo 2 [3 …]              untick
  todo.mjs clear                     empty the list; the strip goes back to the to-dos Haiku extracts from the opening
  todo.mjs show                      print the current list`,
    noSession: 'CLAUDE_CODE_SESSION_ID is not set: run this inside a Claude Code session',
    emptyItem: 'A to-do cannot be empty',
    needNumbers: (command) => `${command} needs item numbers after it, e.g. ${command} 2`,
    noSuchItem: (arg, ids) => `There is no item ${arg}; ${ids.length === 0 ? 'the list is empty' : `the list has ${ids.join(', ')}`}`,
    needsOne: (command) => `${command} needs at least one item`,
    unknownCommand: (command, help) => `Unknown command: ${command}\n${help}`,
    tooMany: (count) => `At most ${MAX_OPEN} unfinished items, got ${count}`,
    earlier: (count) => `(${count} earlier finished ${count === 1 ? 'item is' : 'items are'} no longer listed)`,
    emptyList: 'This session has no hand-written to-dos on the board (its strip shows the ones Haiku extracted from the opening)',
  },
  zh: {
    help: `用法（在 Claude Code session 里执行，自动归到当前 session 的纸条）：
  todo.mjs set "待办1" "待办2" …   整份替换
  todo.mjs add "待办" …            追加
  todo.mjs done 2 [3 …]           勾掉第 2 条（编号固定不变；已完成的只列最近 ${KEEP_DONE} 条）
  todo.mjs undo 2 [3 …]           取消勾选
  todo.mjs clear                  清空，纸条退回 Haiku 从开场提炼的待办
  todo.mjs show                   看当前清单`,
    noSession: '没有 CLAUDE_CODE_SESSION_ID：要在 Claude Code session 里执行',
    emptyItem: '待办不能是空的',
    needNumbers: (command) => `${command} 后面要跟编号，比如 ${command} 2`,
    noSuchItem: (arg, ids) => `没有第 ${arg} 条，${ids.length === 0 ? '清单是空的' : `现有编号：${ids.join('、')}`}`,
    needsOne: (command) => `${command} 至少要一条`,
    unknownCommand: (command, help) => `不认识的命令：${command}\n${help}`,
    tooMany: (count) => `没做完的最多 ${MAX_OPEN} 条，现在 ${count} 条`,
    earlier: (count) => `（更早完成的 ${count} 条已不再列出）`,
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

const emptyList = () => ({ items: [], nextId: 1, doneEarlier: 0 })

/**
 * The saved list: items, the number the next added item gets, and how many finished items have dropped off.
 * Files written before numbers were stored have none: an item's number was its position, so that becomes its number
 */
function load() {
  let saved
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return emptyList()
  }
  if (!Array.isArray(saved?.items)) return emptyList()
  const items = saved.items.map((item, i) => ({ ...item, id: Number.isInteger(item?.id) ? item.id : i + 1 }))
  const nextId = Math.max(Number.isInteger(saved.nextId) ? saved.nextId : 1, ...items.map((item) => item.id + 1))
  return { items, nextId, doneEarlier: Number.isInteger(saved.doneEarlier) ? saved.doneEarlier : 0 }
}

function save({ items, nextId, doneEarlier }) {
  mkdirSync(TODO_DIR, { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify({ items, nextId, doneEarlier, updatedAt: Date.now() }))
  renameSync(temp, file)
}

/** Every unfinished item stays; of the finished ones only the KEEP_DONE most recently ticked do, the rest are counted */
function prune(list) {
  // Items ticked before tick times were stored count as the oldest; among equal times the later-added one is newer
  const done = list.items.filter((item) => item.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.id - a.id)
  const dropped = new Set(done.slice(KEEP_DONE))
  return { ...list, items: list.items.filter((item) => !dropped.has(item)), doneEarlier: list.doneEarlier + dropped.size }
}

function cleanText(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (!flat) fail(TEXT.emptyItem)
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat
}

/** "2", "3" → the items with those numbers; a number not on the list fails loudly instead of being ignored */
function itemsNamed(items) {
  if (args.length === 0) fail(TEXT.needNumbers(command))
  return args.map((arg) => {
    const item = items.find((candidate) => candidate.id === Number(arg))
    if (item === undefined) fail(TEXT.noSuchItem(arg, items.map((candidate) => candidate.id)))
    return item
  })
}

let list = load()
switch (command) {
  case 'set':
    if (args.length === 0) fail(TEXT.needsOne(command))
    list = { items: args.map((text, i) => ({ id: i + 1, text: cleanText(text), done: false })), nextId: args.length + 1, doneEarlier: 0 }
    break
  case 'add':
    if (args.length === 0) fail(TEXT.needsOne(command))
    list.items.push(...args.map((text, i) => ({ id: list.nextId + i, text: cleanText(text), done: false })))
    list.nextId += args.length
    break
  case 'done': {
    const now = Date.now()
    for (const item of itemsNamed(list.items)) {
      // Ticking a finished item again keeps its original time, so it doesn't push a later one off the list
      if (!item.done) Object.assign(item, { done: true, doneAt: now })
    }
    break
  }
  case 'undo':
    for (const item of itemsNamed(list.items)) {
      item.done = false
      delete item.doneAt
    }
    break
  case 'clear':
    list = emptyList()
    break
  case 'show':
    break
  default:
    fail(TEXT.unknownCommand(command, TEXT.help))
}
list = prune(list)
const open = list.items.filter((item) => !item.done).length
if (open > MAX_OPEN) fail(TEXT.tooMany(open))
if (command !== 'show') save(list)

const lines = list.items.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.id}. ${item.text}`)
if (list.doneEarlier > 0) lines.push(TEXT.earlier(list.doneEarlier))
console.log(list.items.length === 0 ? TEXT.emptyList : lines.join('\n'))
