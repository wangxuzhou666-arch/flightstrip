#!/usr/bin/env node
// UserPromptSubmit hook: makes each Claude Code session write its goal checklist onto its strip on the flightstrip
// dashboard. Zero dependencies; `flightstrip setup` copies this file and todo.mjs into <state dir>/bin/ and wires it
// into ~/.claude/settings.json.
//
// Claude Code passes {"session_id": …} on stdin and injects whatever this prints on stdout into the session's context:
//   no checklist yet -> ask for one: "if this takes several steps, write 2-6 plain-language goals with `set`".
//                       Whether to write one is the model's call: single-step tasks and Q&A don't need it.
//   checklist exists -> show it numbered with ✓/☐ and say to run `done N` when an item is finished (no `show` first).
// Silent when: the input is not JSON, session_id is not a UUID shape, or todo.mjs is not next to this file.
// A corrupt checklist file counts as "none yet": the next `set` replaces the whole file.
// Only goals are handled here; progress, background jobs and pages are read from the transcript by the dashboard.
//
// The state dir is FLIGHTSTRIP_STATE_DIR or ~/.flightstrip, the same default as todo.mjs and server/config.ts (repeated
// because this runs standalone). todo.mjs is expected beside this file, which is where `flightstrip setup` puts it.
// The reminder is written in the dashboard's language: the choice saved in <state dir>/settings.json, else FLIGHTSTRIP_LANG,
// else the system locale, else English (the same order as server/lang.ts and todo.mjs).
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_INPUT_BYTES = 65536
// The session id goes into a file path below: this shape check is what keeps `../` out
const SESSION_ID = /^[0-9a-f-]{36}$/
const TODO_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'todo.mjs')
const STATE_DIR = resolve(process.env.FLIGHTSTRIP_STATE_DIR || join(homedir(), '.flightstrip'))
const TODO_DIR = join(STATE_DIR, 'todos')

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

const REMINDERS = {
  en: {
    ask: (command) => `[flightstrip-todo] This session has no goal checklist on the flightstrip dashboard yet. If this task takes several steps, first write the final goals of this session as 2–6 plain-language items: ${command} set "…" "…". Skip it for single-step or mechanical tasks and plain Q&A.`,
    show: (listing, command) => `[flightstrip-todo] This session's goal checklist on the flightstrip dashboard: ${listing}. When you finish an item this turn, run ${command} done N; if the goals change, use add to append or set to replace the whole list.`,
  },
  zh: {
    ask: (command) => `[flightstrip-todo] 这个 session 在 flightstrip 看板上还没有目标清单。如果这个任务要分好几步，先把这个 session 的最终目标写成 2–6 条大白话：${command} set "…" "…"。单步或机械的任务、纯问答就不用写了。`,
    show: (listing, command) => `[flightstrip-todo] 这个 session 在 flightstrip 看板上的目标清单：${listing}。这一轮做完某条就运行 ${command} done N；目标有变就用 add 追加，或用 set 整份替换。`,
  },
}

function readStdin() {
  const chunks = []
  let size = 0
  return new Promise((done) => {
    process.stdin.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size >= MAX_INPUT_BYTES) done()
    })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  }).then(() => Buffer.concat(chunks).subarray(0, MAX_INPUT_BYTES).toString('utf8'))
}

/**
 * `node <path>` as the session should type it: ~/… when under HOME, quoted when the path has spaces.
 * TODO_SCRIPT comes from import.meta.url, which Node resolves to the real path, so a HOME behind a symlink
 * (macOS /var -> /private/var) has to be matched by its real path too.
 */
function todoCommand() {
  if (!/^[\w@%+=:,./-]+$/.test(TODO_SCRIPT)) return `node "${TODO_SCRIPT.replace(/(["\\$`])/g, '\\$1')}"`
  const home = [homedir(), realpathSync(homedir())].find((dir) => TODO_SCRIPT.startsWith(`${dir}/`))
  return `node ${home === undefined ? TODO_SCRIPT : `~${TODO_SCRIPT.slice(home.length)}`}`
}

/** The saved items; [] for a missing file, a corrupt one, or items that don't look like todo.mjs wrote them */
function savedItems(sessionId) {
  let saved
  try {
    saved = JSON.parse(readFileSync(join(TODO_DIR, `${sessionId}.json`), 'utf8'))
  } catch {
    return []
  }
  const items = saved?.items
  return Array.isArray(items) && items.every((item) => typeof item?.text === 'string') ? items : []
}

/** The text to inject, or null to stay silent */
function reminderFor(input) {
  let data
  try {
    data = JSON.parse(input)
  } catch {
    return null
  }
  const sessionId = data?.session_id
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null
  if (!existsSync(TODO_SCRIPT)) return null
  const command = todoCommand()
  const items = savedItems(sessionId)
  const reminders = REMINDERS[languageOf()]
  if (items.length === 0) return reminders.ask(command)
  const listing = items.map((item, i) => `${i + 1}${item.done ? '✓' : '☐'} ${item.text}`).join('; ')
  return reminders.show(listing, command)
}

// Do not hang a prompt if stdin never closes (the hook is also runnable by hand)
setTimeout(() => process.exit(0), 3000).unref()
try {
  const reminder = reminderFor(await readStdin())
  if (reminder !== null) process.stdout.write(`${reminder}\n`)
} catch {
  // Whole-hook boundary: a reminder is a nicety, so whatever goes wrong here must never fail or delay the user's prompt
}
process.exitCode = 0
