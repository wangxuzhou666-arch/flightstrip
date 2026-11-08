// `flightstrip setup` / `flightstrip uninstall`: edits ~/.claude/settings.json. Every test runs the real CLI with HOME
// pointing at a temp dir, so the real settings.json is never touched.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { editSettingsInstall, SettingsError } from '../lib/hook-setup.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(REPO, 'bin', 'flightstrip.mjs')
const roots = []

after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function tempHome(name = 'home') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fs-setup-')))
  roots.push(root)
  const home = join(root, name)
  mkdirSync(home, { recursive: true })
  return { root, home, settings: join(home, '.claude', 'settings.json'), bin: join(home, '.flightstrip', 'bin') }
}

function cli(home, args, { input = '', env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, HOME: home, ...env },
  })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

function writeSettings({ home, settings }, value, indent = 2) {
  mkdirSync(dirname(settings), { recursive: true })
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, indent)}\n`
  writeFileSync(settings, text)
  return text
}

const readSettings = ({ settings }) => JSON.parse(readFileSync(settings, 'utf8'))
const backups = ({ settings }) => readdirSync(dirname(settings)).filter((name) => name.startsWith('settings.json.bak-'))
const ours = (settings) => (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) => group.hooks).filter((hook) => hook.command.includes('todo-reminder.mjs'))

const EXISTING = {
  env: { FOO: '1' },
  permissions: { allow: ['Bash(ls:*)'] },
  statusLine: { type: 'command', command: 'node /somewhere/else.mjs' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash ~/other-hook.sh', timeout: 10 }] }],
  },
}

test('fresh install: creates settings.json with exactly one hook and copies both scripts', () => {
  const t = tempHome()
  const run = cli(t.home, ['setup', '--yes'])
  assert.equal(run.status, 0, run.err)
  const hooks = ours(readSettings(t))
  assert.equal(hooks.length, 1)
  assert.deepEqual(hooks[0], { type: 'command', command: `node ${join(t.bin, 'todo-reminder.mjs')}`, timeout: 5 })
  assert.ok(existsSync(join(t.bin, 'todo.mjs')) && existsSync(join(t.bin, 'todo-reminder.mjs')))
  assert.deepEqual(backups(t), [], 'there was no file to back up')
})

test('existing settings are kept: other hooks, other keys, key order, indent and trailing newline', () => {
  const t = tempHome()
  const original = writeSettings(t, EXISTING, 4)
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const after = readSettings(t)
  assert.deepEqual(Object.keys(after), Object.keys(EXISTING))
  assert.deepEqual(after.env, EXISTING.env)
  assert.deepEqual(after.permissions, EXISTING.permissions)
  assert.deepEqual(after.statusLine, EXISTING.statusLine)
  assert.deepEqual(after.hooks.PreToolUse, EXISTING.hooks.PreToolUse)
  assert.deepEqual(after.hooks.UserPromptSubmit[0], EXISTING.hooks.UserPromptSubmit[0])
  assert.equal(after.hooks.UserPromptSubmit.length, 2)
  assert.equal(ours(after).length, 1)
  const text = readFileSync(t.settings, 'utf8')
  assert.match(text, /^ {4}"env"/m, 'the 4-space indent survives')
  assert.ok(text.endsWith('}\n'))
  const [backup] = backups(t)
  assert.equal(readFileSync(join(dirname(t.settings), backup), 'utf8'), original, 'the backup is the file as it was')
})

test('idempotent: a second run changes nothing and makes no second backup', () => {
  const t = tempHome()
  writeSettings(t, EXISTING)
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const afterFirst = readFileSync(t.settings, 'utf8')
  const second = cli(t.home, ['setup', '--yes'])
  assert.equal(second.status, 0, second.err)
  assert.match(second.out, /Already installed/)
  assert.equal(readFileSync(t.settings, 'utf8'), afterFirst)
  assert.equal(ours(readSettings(t)).length, 1)
  assert.equal(backups(t).length, 1)
})

test('re-running after the scripts changed refreshes them without touching settings.json', () => {
  const t = tempHome()
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const settingsBefore = readFileSync(t.settings, 'utf8')
  writeFileSync(join(t.bin, 'todo.mjs'), '// stale copy\n')
  const run = cli(t.home, ['setup', '--yes'])
  assert.equal(run.status, 0, run.err)
  assert.equal(readFileSync(join(t.bin, 'todo.mjs'), 'utf8'), readFileSync(join(REPO, 'scripts', 'todo.mjs'), 'utf8'))
  assert.equal(readFileSync(t.settings, 'utf8'), settingsBefore)
})

test('an entry that points at another state dir is updated, not duplicated', () => {
  const t = tempHome()
  const stale = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /old/place/.flightstrip/bin/todo-reminder.mjs', timeout: 5 }] }] } }
  writeSettings(t, stale)
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const hooks = ours(readSettings(t))
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].command, `node ${join(t.bin, 'todo-reminder.mjs')}`)
})

test('uninstall removes only our entry and leaves everything else as it was', () => {
  const t = tempHome()
  writeSettings(t, EXISTING)
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const run = cli(t.home, ['uninstall', '--yes'])
  assert.equal(run.status, 0, run.err)
  assert.deepEqual(readSettings(t), EXISTING)
  assert.equal(backups(t).length, 2, 'setup and uninstall each saved a backup')
  assert.ok(existsSync(join(t.bin, 'todo.mjs')), 'the scripts stay')
})

test('uninstall keeps your other hooks even when our entry shares a matcher group with them', () => {
  const t = tempHome()
  const ourCommand = `node ${join(t.bin, 'todo-reminder.mjs')}`
  const shared = { hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash ~/mine.sh' }, { type: 'command', command: ourCommand, timeout: 5 }] }] } }
  writeSettings(t, shared)
  const run = cli(t.home, ['uninstall', '--yes'])
  assert.equal(run.status, 0, run.err)
  assert.deepEqual(readSettings(t), { hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash ~/mine.sh' }] }] } })
})

test('uninstall after a fresh install leaves an empty settings object, not a dangling hooks key', () => {
  const t = tempHome()
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  assert.equal(cli(t.home, ['uninstall', '--yes']).status, 0)
  assert.deepEqual(readSettings(t), {})
})

test('uninstall with nothing installed says so and does not touch the file', () => {
  const t = tempHome()
  const original = writeSettings(t, EXISTING)
  const run = cli(t.home, ['uninstall', '--yes'])
  assert.equal(run.status, 0)
  assert.match(run.out, /Nothing to remove/)
  assert.equal(readFileSync(t.settings, 'utf8'), original)
  assert.deepEqual(backups(t), [])
  assert.equal(cli(tempHome().home, ['uninstall', '--yes']).status, 0, 'no settings.json at all is fine too')
})

test('invalid JSON is refused with a message and nothing is changed', () => {
  const t = tempHome()
  const original = writeSettings(t, '{ "hooks": { // a comment\n}')
  const run = cli(t.home, ['setup', '--yes'])
  assert.equal(run.status, 1)
  assert.match(run.err, /not valid JSON/)
  assert.equal(readFileSync(t.settings, 'utf8'), original)
  assert.deepEqual(backups(t), [])
  assert.ok(!existsSync(t.bin), 'no scripts were copied either')
})

test('an unexpected hooks shape is refused, not overwritten', () => {
  assert.throws(() => editSettingsInstall('{"hooks": []}', '/x/.flightstrip/bin/todo-reminder.mjs', '/home/me'), SettingsError)
  assert.throws(() => editSettingsInstall('{"hooks": {"UserPromptSubmit": {}}}', '/x/.flightstrip/bin/todo-reminder.mjs', '/home/me'), SettingsError)
  assert.throws(() => editSettingsInstall('[]', '/x/.flightstrip/bin/todo-reminder.mjs', '/home/me'), SettingsError)
})

test('without --yes nothing happens unless you answer y', () => {
  const t = tempHome()
  const original = writeSettings(t, EXISTING)
  const declined = cli(t.home, ['setup'], { input: 'n\n' })
  assert.equal(declined.status, 0)
  assert.match(declined.out, /Nothing was changed/)
  assert.equal(readFileSync(t.settings, 'utf8'), original)
  const noAnswer = cli(t.home, ['setup'], { input: '' })
  assert.match(noAnswer.out, /Nothing was changed/)
  assert.equal(readFileSync(t.settings, 'utf8'), original)
  assert.ok(!existsSync(t.bin))
  const accepted = cli(t.home, ['setup'], { input: 'y\n' })
  assert.equal(accepted.status, 0, accepted.err)
  assert.equal(ours(readSettings(t)).length, 1)
})

test('it shows what will change before asking', () => {
  const t = tempHome()
  const run = cli(t.home, ['setup'], { input: 'n\n' })
  assert.match(run.out, /will make these changes/)
  assert.match(run.out, /todo\.mjs and todo-reminder\.mjs|todo-reminder\.mjs and todo\.mjs|todo\.mjs/)
  assert.ok(run.out.includes('"command":"node ' + join(t.bin, 'todo-reminder.mjs') + '"'), run.out)
  assert.match(run.out, /does not exist yet and will be created/)
})

test('a custom FLIGHTSTRIP_STATE_DIR is used, and uninstall finds the entry without it', () => {
  const t = tempHome()
  const state = join(t.root, 'flightstrip-state')
  assert.equal(cli(t.home, ['setup', '--yes'], { env: { FLIGHTSTRIP_STATE_DIR: state } }).status, 0)
  assert.equal(ours(readSettings(t))[0].command, `node ${join(state, 'bin', 'todo-reminder.mjs')}`)
  assert.ok(existsSync(join(state, 'bin', 'todo.mjs')))
  assert.equal(cli(t.home, ['uninstall', '--yes']).status, 0)
  assert.equal(ours(readSettings(t)).length, 0)
})

test('a HOME with spaces gets a quoted command, and uninstall still recognises it', () => {
  const t = tempHome('my home')
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const [hook] = ours(readSettings(t))
  assert.equal(hook.command, `node "${join(t.bin, 'todo-reminder.mjs')}"`)
  assert.equal(cli(t.home, ['uninstall', '--yes']).status, 0)
  assert.equal(ours(readSettings(t)).length, 0)
})

test('a symlinked settings.json stays a symlink and the target is updated', () => {
  const t = tempHome()
  const target = join(t.root, 'dotfiles-settings.json')
  writeFileSync(target, `${JSON.stringify(EXISTING, null, 2)}\n`)
  mkdirSync(dirname(t.settings), { recursive: true })
  symlinkSync(target, t.settings)
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  assert.ok(lstatSync(t.settings).isSymbolicLink())
  assert.equal(ours(JSON.parse(readFileSync(target, 'utf8'))).length, 1)
})

test('CRLF files keep their line endings', () => {
  const t = tempHome()
  writeSettings(t, JSON.stringify(EXISTING, null, 2).replace(/\n/g, '\r\n') + '\r\n')
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const text = readFileSync(t.settings, 'utf8')
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF was introduced')
})

test('setup also copies statusline.mjs next to the hook scripts, and never installs a statusLine', () => {
  const t = tempHome()
  const fresh = cli(t.home, ['setup', '--yes'])
  assert.equal(fresh.status, 0, fresh.err)
  assert.equal(readFileSync(join(t.bin, 'statusline.mjs'), 'utf8'), readFileSync(join(REPO, 'scripts', 'statusline.mjs'), 'utf8'))
  assert.equal(readSettings(t).statusLine, undefined, 'a fresh settings.json gets no statusLine')
  assert.match(fresh.out, /statusline\.mjs sits next to them but is not enabled/)
  assert.ok(fresh.out.includes(`"command":"node ${join(t.bin, 'statusline.mjs')}"`), fresh.out)

  const other = tempHome()
  writeSettings(other, EXISTING)
  assert.equal(cli(other.home, ['setup', '--yes']).status, 0)
  assert.deepEqual(readSettings(other).statusLine, EXISTING.statusLine, "someone else's statusLine is left alone")
  assert.ok(existsSync(join(other.bin, 'statusline.mjs')))
})

test('a stale statusline copy is refreshed on the next run, without touching settings.json', () => {
  const t = tempHome()
  assert.equal(cli(t.home, ['setup', '--yes']).status, 0)
  const settingsBefore = readFileSync(t.settings, 'utf8')
  writeFileSync(join(t.bin, 'statusline.mjs'), '// stale copy\n')
  const run = cli(t.home, ['setup', '--yes'])
  assert.equal(run.status, 0, run.err)
  assert.match(run.out, /Copy statusline\.mjs to /)
  assert.equal(readFileSync(join(t.bin, 'statusline.mjs'), 'utf8'), readFileSync(join(REPO, 'scripts', 'statusline.mjs'), 'utf8'))
  assert.equal(readFileSync(t.settings, 'utf8'), settingsBefore)
})

test('CLAUDE_CONFIG_DIR moves settings.json: setup and uninstall use it and leave ~/.claude alone', () => {
  const t = tempHome()
  const custom = join(t.root, 'claude-config')
  const env = { CLAUDE_CONFIG_DIR: custom }
  const customSettings = join(custom, 'settings.json')
  const install = cli(t.home, ['setup', '--yes'], { env })
  assert.equal(install.status, 0, install.err)
  assert.equal(ours(JSON.parse(readFileSync(customSettings, 'utf8'))).length, 1)
  assert.ok(!existsSync(join(t.home, '.claude')), 'the default directory was not created')
  assert.ok(cli(t.home, ['setup', '--yes'], { env, input: '' }).out.includes('Already installed'))

  const wrongPlace = cli(t.home, ['uninstall', '--yes'])
  assert.match(wrongPlace.out, /Nothing to remove/, 'without the variable the default directory is looked at')
  assert.equal(ours(JSON.parse(readFileSync(customSettings, 'utf8'))).length, 1)
  assert.equal(cli(t.home, ['uninstall', '--yes'], { env }).status, 0)
  assert.equal(ours(JSON.parse(readFileSync(customSettings, 'utf8'))).length, 0)
  assert.equal(readdirSync(custom).filter((name) => name.startsWith('settings.json.bak-')).length, 1, 'uninstall made its backup next to the file')
})
