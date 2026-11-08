#!/usr/bin/env node
// Claude Code statusLine command: on every status bar refresh Claude Code passes the session info
// (including rate_limits) in on stdin.
// It does only two things: store rate_limits for the dashboard to read, and print one line of weekly usage in the status bar.
// A status bar script must never error or hang, so any exception just prints an empty line and exits.
// Zero dependencies, fast startup.
//
// Each session keeps its own file: rate_limits is the value from that session's latest model request, so an idle
// session keeps reporting a stale number. Within one window usage only goes up and the dashboard takes the maximum
// across files, so a stale number can't cover a fresh one.
// The state dir is FLIGHTSTRIP_STATE_DIR or ~/.flightstrip, the same default as server/config.ts (repeated here because
// this script runs standalone); Claude Code's environment must carry the same variable if the server uses a custom one.
// The status line is worded in the dashboard's language: the choice saved in <state dir>/settings.json, else
// FLIGHTSTRIP_LANG, else the system locale, else English (the same order as server/lang.ts).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const STATE_DIR = resolve(process.env.FLIGHTSTRIP_STATE_DIR || join(homedir(), '.flightstrip'))
const USAGE_DIR = join(STATE_DIR, 'usage')
const LABELS = { en: { week: 'Week', hours: '5 h' }, zh: { week: '本周', hours: '5 小时' } }

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

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { text += chunk })
    process.stdin.on('end', () => resolve(text))
  })
}

function percent(window) {
  const value = window?.used_percentage
  return typeof value === 'number' ? `${Math.round(value)}%` : null
}

function record(rateLimits, sessionId) {
  mkdirSync(USAGE_DIR, { recursive: true })
  const target = join(USAGE_DIR, `${sessionId.replace(/[^0-9a-zA-Z-]/g, '')}.json`)
  // Write a temp file first, then rename, so the dashboard never reads a half-written file
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ at: Date.now(), sessionId, rateLimits }))
  renameSync(temp, target)
}

try {
  const input = JSON.parse(await readStdin())
  const limits = input.rate_limits
  if (limits && typeof limits === 'object' && typeof input.session_id === 'string') {
    record(limits, input.session_id)
    const week = percent(limits.seven_day)
    const hours = percent(limits.five_hour)
    const labels = LABELS[languageOf()]
    process.stdout.write([week && `${labels.week} ${week}`, hours && `${labels.hours} ${hours}`].filter(Boolean).join('  '))
  }
} catch {
  // Parse or write failure: leave the status bar empty, don't disturb Claude Code
}
