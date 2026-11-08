// `flightstrip setup` / `flightstrip uninstall`: puts the todo reminder hook into settings.json in Claude's directory
// (~/.claude, or CLAUDE_CONFIG_DIR).
//
// What the hook does: before each prompt, hooks/todo-reminder.mjs tells the session to write its goal checklist with
// todo.mjs, and shows the current checklist once it exists. Both scripts are copied into <state dir>/bin/ first,
// because the package may live in an npx cache that gets cleaned up; the hook command points at that stable copy.
// scripts/statusline.mjs is copied there too, for the same reason, but never enabled: a statusLine is a single slot in
// settings.json that people already use for their own, so setup only says how to point it at the copy.
//
// The settings editing (editSettings*) is pure text in, text out. Only the file handling at the bottom touches disk.
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { claudeDir, stateDir, tildify } from './paths.mjs'

const EVENT = 'UserPromptSubmit'
const TIMEOUT_SECONDS = 5
const HOOK_SCRIPT = 'todo-reminder.mjs'
const TODO_SCRIPT = 'todo.mjs'
const STATUSLINE_SCRIPT = 'statusline.mjs'
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export class SettingsError extends Error {}

/** Paths with spaces or shell characters get double quotes; everything else stays bare so the command reads cleanly */
function shellQuote(path) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, '\\$1')}"`
}

export function hookCommand(scriptPath) {
  return `node ${shellQuote(scriptPath)}`
}

/** The script path out of `node <path>`, or null for any other kind of command */
function scriptOf(command, home) {
  const match = /^node\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/.exec(command)
  if (match === null) return null
  const path = match[1] === undefined ? match[2] : match[1].replace(/\\(.)/g, '$1')
  return path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
}

/** Ours = the exact script for this state dir, or any todo-reminder.mjs in a flightstrip "bin" dir (another state dir) */
function isOurs(hook, expectedScript, home) {
  if (hook === null || typeof hook !== 'object' || hook.type !== 'command' || typeof hook.command !== 'string') return false
  const script = scriptOf(hook.command, home)
  if (script === null) return false
  return script === expectedScript || (basename(script) === HOOK_SCRIPT && basename(dirname(script)) === 'bin' && /flightstrip/i.test(script))
}

/** Indent and line ending of the original, so a one-entry change doesn't reformat the whole file */
function styleOf(text) {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  '
  return { indent, eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

function parseSettings(text) {
  if (text === null || text.trim() === '') return { settings: {}, indent: '  ', eol: '\n' }
  let settings
  try {
    settings = JSON.parse(text)
  } catch (err) {
    throw new SettingsError(`settings.json is not valid JSON (${err.message}). Fix it by hand; nothing was changed.`)
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new SettingsError('settings.json does not contain a JSON object. Nothing was changed.')
  }
  return { settings, ...styleOf(text) }
}

function serialize(settings, { indent, eol }) {
  return `${JSON.stringify(settings, null, indent).replace(/\n/g, eol)}${eol}`
}

/** The UserPromptSubmit matcher groups; undefined when the file has none, SettingsError when the shape is unexpected */
function groupsOf(settings) {
  const hooks = settings.hooks
  if (hooks === undefined) return undefined
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) throw new SettingsError('"hooks" in settings.json is not an object. Nothing was changed.')
  const groups = hooks[EVENT]
  if (groups !== undefined && !Array.isArray(groups)) throw new SettingsError(`"hooks.${EVENT}" in settings.json is not an array. Nothing was changed.`)
  return groups
}

/** The hook entry as it is written into settings.json */
export function hookEntry(scriptPath) {
  return { type: 'command', command: hookCommand(scriptPath), timeout: TIMEOUT_SECONDS }
}

/**
 * Adds the hook as its own matcher group (so removing it later never touches your other hooks).
 * Already there with the right command: unchanged. There with another path (the state dir moved): the command is updated.
 * Returns { text, change: 'added' | 'updated' | 'unchanged' }.
 */
export function editSettingsInstall(text, scriptPath, home = homedir()) {
  const parsed = parseSettings(text)
  const { settings } = parsed
  const groups = groupsOf(settings)
  const entry = hookEntry(scriptPath)
  const existing = (groups ?? []).flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])).filter((hook) => isOurs(hook, scriptPath, home))
  if (existing.length === 0) {
    settings.hooks ??= {}
    settings.hooks[EVENT] = [...(groups ?? []), { hooks: [entry] }]
    return { text: serialize(settings, parsed), change: 'added' }
  }
  const stale = existing.filter((hook) => hook.command !== entry.command)
  for (const hook of stale) hook.command = entry.command
  return { text: stale.length === 0 ? text : serialize(settings, parsed), change: stale.length === 0 ? 'unchanged' : 'updated' }
}

/** Removes only our entries; groups and containers that this leaves empty go with them. Returns { text, removed } */
export function editSettingsUninstall(text, scriptPath, home = homedir()) {
  const parsed = parseSettings(text)
  const { settings } = parsed
  const groups = groupsOf(settings)
  let removed = 0
  const kept = []
  for (const group of groups ?? []) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : null
    const rest = hooks?.filter((hook) => !isOurs(hook, scriptPath, home))
    if (hooks === null || rest.length === hooks.length) {
      kept.push(group)
      continue
    }
    removed += hooks.length - rest.length
    if (rest.length > 0) kept.push({ ...group, hooks: rest })
  }
  if (removed === 0) return { text, removed }
  if (kept.length > 0) {
    settings.hooks[EVENT] = kept
  } else {
    delete settings.hooks[EVENT]
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  }
  return { text: serialize(settings, parsed), removed }
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Write via a temp file in the same directory; a symlinked settings.json (dotfile managers) is written through, not replaced */
function writeAtomically(path, text) {
  const target = existsSync(path) ? realpathSync(path) : path
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.flightstrip-tmp`
  writeFileSync(temp, text)
  renameSync(temp, target)
}

function copyIfDifferent(source, destination) {
  const wanted = readFileSync(source)
  if (existsSync(destination) && readFileSync(destination).equals(wanted)) return false
  mkdirSync(dirname(destination), { recursive: true })
  const temp = `${destination}.flightstrip-tmp`
  writeFileSync(temp, wanted)
  renameSync(temp, destination)
  return true
}

/** "a", "a and b", "a, b and c" */
function listOf(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')
}

async function confirm(question) {
  const lines = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise((resolve) => {
      lines.once('close', () => resolve(''))
      lines.question(question, resolve)
    })
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    lines.close()
  }
}

/** Exit code: 0 done / nothing to do / declined, 1 settings.json or the scripts could not be handled */
export async function runSetup({ uninstall, yes, env = process.env }) {
  const home = homedir()
  const binDir = join(stateDir(env), 'bin')
  const script = join(binDir, HOOK_SCRIPT)
  const settingsPath = join(claudeDir(env), 'settings.json')
  const shown = tildify(settingsPath, home)
  try {
    return uninstall ? await uninstallHook({ settingsPath, shown, script, binDir, home, yes }) : await installHook({ settingsPath, shown, script, binDir, home, yes })
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err
    console.error(`${shown}: ${err.message}`)
    return 1
  }
}

/** settings.json.bak-<timestamp>; a second backup in the same second gets a -2, -3… suffix instead of overwriting the first */
function backup(settingsPath) {
  const base = `${settingsPath}.bak-${timestamp()}`
  let backupPath = base
  for (let n = 2; existsSync(backupPath); n += 1) backupPath = `${base}-${n}`
  copyFileSync(settingsPath, backupPath, constants.COPYFILE_EXCL)
  console.log(`Backup saved: ${tildify(backupPath)}`)
}

async function installHook({ settingsPath, shown, script, binDir, home, yes }) {
  const before = readIfExists(settingsPath)
  const { text, change } = editSettingsInstall(before, script, home)
  const sources = [
    [join(PACKAGE_ROOT, 'scripts', TODO_SCRIPT), join(binDir, TODO_SCRIPT)],
    [join(PACKAGE_ROOT, 'hooks', HOOK_SCRIPT), script],
    [join(PACKAGE_ROOT, 'scripts', STATUSLINE_SCRIPT), join(binDir, STATUSLINE_SCRIPT)],
  ]
  const staleFiles = sources.filter(([from, to]) => !existsSync(to) || !readFileSync(to).equals(readFileSync(from)))
  if (change === 'unchanged' && staleFiles.length === 0) {
    console.log(`Already installed: the todo hook is in ${shown} and its scripts in ${tildify(binDir, home)} are up to date. Nothing to do.`)
    return 0
  }
  console.log('flightstrip setup will make these changes:')
  if (staleFiles.length > 0) {
    console.log(`  1. Copy ${listOf(staleFiles.map(([, to]) => basename(to)))} to ${tildify(binDir, home)}/ (a stable location; an npx cache is temporary)`)
  }
  if (change !== 'unchanged') {
    console.log(`  ${staleFiles.length > 0 ? '2' : '1'}. ${change === 'added' ? 'Add' : 'Update'} this hook in ${shown} under hooks.${EVENT}:`)
    console.log(`       ${JSON.stringify(hookEntry(script))}`)
    console.log(`     ${before === null ? `${shown} does not exist yet and will be created.` : 'A backup of the file is saved first.'}`)
  }
  console.log('Each new Claude Code session is then reminded to write its goal checklist, which shows on its strip.')
  if (!yes && !(await confirm('Proceed? [y/N] '))) {
    console.log('Nothing was changed.')
    return 0
  }
  for (const [from, to] of staleFiles) copyIfDifferent(from, to)
  if (change !== 'unchanged') {
    if (before !== null) backup(settingsPath)
    writeAtomically(settingsPath, text)
  }
  console.log(`Done. Hooks are loaded when a session starts, so open a new Claude Code session to see the reminder. Undo with: flightstrip uninstall`)
  console.log(`${STATUSLINE_SCRIPT} sits next to them but is not enabled. To feed the usage meters from your status bar, set "statusLine" in ${shown} to ${JSON.stringify({ type: 'command', command: hookCommand(join(binDir, STATUSLINE_SCRIPT)) })}.`)
  return 0
}

async function uninstallHook({ settingsPath, shown, script, binDir, home, yes }) {
  const before = readIfExists(settingsPath)
  const { text, removed } = before === null ? { text: null, removed: 0 } : editSettingsUninstall(before, script, home)
  if (removed === 0) {
    console.log(`Nothing to remove: no flightstrip hook found in ${shown}.`)
    return 0
  }
  console.log(`flightstrip uninstall will remove ${removed} flightstrip hook ${removed === 1 ? 'entry' : 'entries'} from ${shown} (hooks.${EVENT}). Your other settings stay as they are, and a backup is saved first.`)
  if (!yes && !(await confirm('Proceed? [y/N] '))) {
    console.log('Nothing was changed.')
    return 0
  }
  backup(settingsPath)
  writeAtomically(settingsPath, text)
  console.log(`Done. The scripts in ${tildify(binDir, home)}/ were left in place; delete the folder if you do not need them any more.`)
  return 0
}
