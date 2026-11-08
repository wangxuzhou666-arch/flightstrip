// The single place that reads environment variables. Everything else imports `config`.
// Invalid values throw at startup instead of silently falling back: a typo in FLIGHTSTRIP_BRIEFS
// quietly leaving paid model calls on is worse than refusing to start.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isLang, type Lang } from '../shared/i18n/index.ts'

const DEFAULT_PORT = 4317
const DEFAULT_CONTEXT_LINE = 400_000

/** Port of the Vite dev server (`npm run dev`); the API server accepts its Host header and the proxy lives in vite.config.ts */
export const DEV_CLIENT_PORT = 5317

/** Empty string counts as unset, so `PORT= npm start` behaves like not exporting it */
function fromEnv(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

function integerFromEnv(name: string, fallback: number, max: number): number {
  const raw = fromEnv(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}, got "${raw}"`)
  }
  return value
}

function langFromEnv(name: string): Lang | null {
  const raw = fromEnv(name)?.toLowerCase()
  if (raw === undefined) return null
  if (!isLang(raw)) throw new Error(`${name} must be "en" or "zh", got "${raw}"`)
  return raw
}

/** on/1 and off/0 both work, so `FLIGHTSTRIP_DEMO=1 flightstrip` reads naturally */
function switchFromEnv(name: string, fallback: boolean): boolean {
  const raw = fromEnv(name)?.toLowerCase()
  if (raw === undefined) return fallback
  if (raw !== 'on' && raw !== 'off' && raw !== '1' && raw !== '0') throw new Error(`${name} must be "on" or "off", got "${raw}"`)
  return raw === 'on' || raw === '1'
}

/**
 * Resolves symlinks in the part of the path that exists (/tmp/x -> /private/tmp/x on macOS) and keeps the rest as is.
 * Claude Code records a session's cwd from the process, which is always the real path; the own-cwd filter in
 * collect.ts compares against this value, so it has to be the real path too.
 * Walks up instead of mkdir + realpath: this module is also imported by vite.config.ts, and loading a config must not
 * create ~/.flightstrip as a side effect (`npm pack` runs the build).
 */
function realPath(path: string): string {
  let existing = path
  const missing: string[] = []
  while (!existsSync(existing)) {
    missing.unshift(basename(existing))
    existing = dirname(existing)
  }
  return join(realpathSync(existing), ...missing)
}

const customClaudeDir = fromEnv('CLAUDE_CONFIG_DIR')

export const config = {
  /** Fixed: the dashboard exposes session content, so it never listens on another interface */
  host: '127.0.0.1',
  /** PORT */
  port: integerFromEnv('PORT', DEFAULT_PORT, 65535),
  /** FLIGHTSTRIP_STATE_DIR: groups, retired list, brief cache, usage reports, session-written todos.
   *  Outside the repo on purpose: a package run from the npx cache is ephemeral.
   *  scripts/todo.mjs, scripts/statusline.mjs, hooks/todo-reminder.mjs and lib/paths.mjs repeat this default because
   *  they run standalone (test/paths.test.mjs checks they agree). */
  stateDir: realPath(resolve(fromEnv('FLIGHTSTRIP_STATE_DIR') ?? join(homedir(), '.flightstrip'))),
  /** CLAUDE_CONFIG_DIR, or ~/.claude: where Claude Code keeps sessions, jobs, transcripts and settings.json.
   *  Claude Code's own variable, so a custom location needs no second setting here. lib/paths.mjs repeats this for the CLI */
  claudeDir: resolve(customClaudeDir ?? join(homedir(), '.claude')),
  /** Claude Code's global config (it caches the usage numbers here): ~/.claude.json, or inside CLAUDE_CONFIG_DIR when that is set
   *  (read off the installed claude binary, 2026-11-08: join(configDir || homedir(), ".claude.json")) */
  claudeJson: join(customClaudeDir === undefined ? homedir() : resolve(customClaudeDir), '.claude.json'),
  /** FLIGHTSTRIP_LANG (en | zh): the language when nothing is saved in <state dir>/settings.json yet; null = follow the system locale */
  lang: langFromEnv('FLIGHTSTRIP_LANG'),
  /** FLIGHTSTRIP_DEMO=1 (or `flightstrip --demo`): serve fictional sessions from server/demo.ts. Reads nothing from
   *  the Claude directory, never runs `claude`, keeps every write (groups, renames, retire) in memory */
  demo: switchFromEnv('FLIGHTSTRIP_DEMO', false),
  /** FLIGHTSTRIP_BRIEFS=off: no `claude -p` calls for goals, progress or job names */
  briefsEnabled: switchFromEnv('FLIGHTSTRIP_BRIEFS', true),
  /** FLIGHTSTRIP_CONTEXT_LINE: the token count the context meter treats as "full" */
  contextLine: integerFromEnv('FLIGHTSTRIP_CONTEXT_LINE', DEFAULT_CONTEXT_LINE, Number.MAX_SAFE_INTEGER),
} as const
