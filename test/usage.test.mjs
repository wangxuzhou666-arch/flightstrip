// Merging subscription usage reports into the header's weekly and 5-hour figures.
//   U1 one window's reset time differs by a fraction of a second between sources: still one window, the maximum wins
//   U2 a previous window's report doesn't mix into the current one
//   U3 a window past its reset time is empty until a new report arrives (the header says it has reset)
// The TypeScript is loaded through tsx, so this runs on every Node the package supports.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { tsImport } from 'tsx/esm/api'

// usage.ts reads the config, which reads the state dir from here: keep it off ~/.flightstrip
process.env.FLIGHTSTRIP_STATE_DIR = mkdtempSync(join(tmpdir(), 'flightstrip-usage-'))
const { freshest } = await tsImport('../server/usage.ts', import.meta.url)

const HOUR = 60 * 60_000
const RESET = Date.parse('2026-11-14T06:00:00Z')
// "Now" in these tests: this week hasn't reset yet
const NOW = Date.parse('2026-11-12T04:00:00Z')
const week = (r) => r.week

function report(at, percent, resetsAt) {
  return { source: 'statusline', at, week: { percent, resetsAt }, fiveHour: { percent: null, resetsAt: null } }
}

test('U1 one week reported with reset times 0.23 s apart is one week, and the larger figure wins', () => {
  // The 2026-11-11 case: an 11-07 statusline report in whole seconds at 5%; that day's /usage cache in ms at 68%
  const old = report(Date.parse('2026-11-07T20:18:10Z'), 5, RESET)
  const fresh = report(Date.parse('2026-11-12T03:52:52Z'), 68, RESET - 230)
  assert.equal(freshest(week, [old, fresh], NOW).percent, 68)
  assert.equal(freshest(week, [fresh, old], NOW).percent, 68)
})

test('U2 last week\'s report stays out of this week', () => {
  const lastWeek = report(Date.parse('2026-11-06T20:00:00Z'), 97, RESET - 7 * 24 * HOUR)
  const thisWeek = report(Date.parse('2026-11-08T20:00:00Z'), 12, RESET)
  assert.equal(freshest(week, [lastWeek, thisWeek], NOW).percent, 12)
})

test('U3 past its reset time a window is empty until the next report, which then wins', () => {
  const ending = report(Date.parse('2026-11-13T20:00:00Z'), 97, RESET)
  assert.equal(freshest(week, [ending], RESET - 1).percent, 97)
  assert.deepEqual(freshest(week, [ending], RESET + 1), { percent: null, resetsAt: null })
  const next = report(RESET + HOUR, 2, RESET + 7 * 24 * HOUR)
  assert.equal(freshest(week, [ending, next], RESET + 2 * HOUR).percent, 2)
  assert.deepEqual(freshest((r) => r.fiveHour, [ending], NOW), { percent: null, resetsAt: null })
})
