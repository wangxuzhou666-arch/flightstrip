// The state dir and port defaults are written down in several places that run standalone (server/config.ts, the CLI,
// todo.mjs, statusline.mjs, the hook). These tests run each one against a temp HOME and require them to agree,
// and cover config.ts resolving a symlinked FLIGHTSTRIP_STATE_DIR to its real path.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SID = '5e551011-aaaa-4bbb-8ccc-000000000001'
const roots = []

after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function tempHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fs-paths-')))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  return { root, home }
}

function node(home, args, { input = '', env = {}, cwd = REPO } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd, input, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, HOME: home, ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

const configValue = (name, home, env = {}, cwd) =>
  node(home, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `const { config } = await import(process.argv[1]); console.log(config.${name})`, join(REPO, 'server', 'config.ts')], { env, cwd })
const configStateDir = (home, env = {}, cwd) => configValue('stateDir', home, env, cwd)
const cliClaudeDir = (home, env = {}) =>
  node(home, ['--input-type=module', '-e', "const { claudeDir } = await import(process.argv[1]); console.log(claudeDir())", join(REPO, 'lib', 'paths.mjs')], { env })

test('the default state dir is ~/.flightstrip everywhere, and it can be overridden the same way', () => {
  for (const overridden of [false, true]) {
    const { root, home } = tempHome()
    const state = overridden ? join(root, 'custom-state') : join(home, '.flightstrip')
    const env = overridden ? { FLIGHTSTRIP_STATE_DIR: state } : {}
    assert.equal(configStateDir(home, env), state, 'server/config.ts')
    assert.equal(node(home, ['--input-type=module', '-e', "const { stateDir } = await import(process.argv[1]); console.log(stateDir())", join(REPO, 'lib', 'paths.mjs')], { env }), state, 'lib/paths.mjs')
    node(home, [join(REPO, 'scripts', 'todo.mjs'), 'set', 'one'], { env: { ...env, CLAUDE_CODE_SESSION_ID: SID } })
    assert.ok(existsSync(join(state, 'todos', `${SID}.json`)), 'scripts/todo.mjs')
    node(home, [join(REPO, 'scripts', 'statusline.mjs')], { env, input: JSON.stringify({ session_id: SID, rate_limits: { seven_day: { used_percentage: 10 } } }) })
    assert.ok(existsSync(join(state, 'usage', `${SID}.json`)), 'scripts/statusline.mjs')
  }
})

test("Claude's directory is ~/.claude or CLAUDE_CONFIG_DIR, the same for the server and the CLI, and .claude.json moves with it", () => {
  const { root, home } = tempHome()
  assert.equal(configValue('claudeDir', home), join(home, '.claude'))
  assert.equal(cliClaudeDir(home), join(home, '.claude'))
  assert.equal(configValue('claudeJson', home), join(home, '.claude.json'), 'without the variable the global config sits in HOME')
  const custom = join(root, 'cc')
  assert.equal(configValue('claudeDir', home, { CLAUDE_CONFIG_DIR: custom }), custom)
  assert.equal(cliClaudeDir(home, { CLAUDE_CONFIG_DIR: custom }), custom)
  assert.equal(configValue('claudeJson', home, { CLAUDE_CONFIG_DIR: custom }), join(custom, '.claude.json'))
  assert.equal(configValue('claudeDir', home, { CLAUDE_CONFIG_DIR: '' }), join(home, '.claude'), 'empty counts as unset')
  assert.equal(cliClaudeDir(home, { CLAUDE_CONFIG_DIR: '' }), join(home, '.claude'))
})

test('FLIGHTSTRIP_LANG is validated at startup like the other FLIGHTSTRIP_* values', () => {
  const { home } = tempHome()
  assert.equal(configValue('lang', home, { FLIGHTSTRIP_LANG: 'ZH' }), 'zh')
  assert.equal(configValue('lang', home), 'null')
  const bad = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', 'await import(process.argv[1])', join(REPO, 'server', 'config.ts')], {
    cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, FLIGHTSTRIP_LANG: 'fr' },
  })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /FLIGHTSTRIP_LANG must be "en" or "zh", got "fr"/)
})

test('config.ts and the CLI use the same default port', () => {
  const fromConfig = /DEFAULT_PORT = (\d+)/.exec(readFileSync(join(REPO, 'server', 'config.ts'), 'utf8'))?.[1]
  const fromCli = /DEFAULT_PORT = (\d+)/.exec(readFileSync(join(REPO, 'bin', 'flightstrip.mjs'), 'utf8'))?.[1]
  assert.ok(fromConfig !== undefined && fromConfig === fromCli, `config.ts ${fromConfig}, CLI ${fromCli}`)
})

test('a state dir reached through a symlink resolves to its real path, even when it does not exist yet', () => {
  const { root, home } = tempHome()
  const real = join(root, 'real')
  mkdirSync(real)
  symlinkSync(real, join(root, 'link'))
  assert.equal(configStateDir(home, { FLIGHTSTRIP_STATE_DIR: join(root, 'link', 'state') }), join(real, 'state'))
  mkdirSync(join(real, 'existing'))
  assert.equal(configStateDir(home, { FLIGHTSTRIP_STATE_DIR: join(root, 'link', 'existing') }), join(real, 'existing'))
  assert.ok(!existsSync(join(real, 'state')), 'loading the config must not create the directory')
})

test('a relative state dir is resolved against the working directory', () => {
  const { root, home } = tempHome()
  assert.equal(configStateDir(home, { FLIGHTSTRIP_STATE_DIR: 'rel/state' }, root), join(root, 'rel', 'state'))
})

test('the macOS /tmp alias counts as a symlink too', { skip: process.platform !== 'darwin' }, () => {
  const { home } = tempHome()
  const name = `fs-alias-${process.pid}`
  assert.equal(configStateDir(home, { FLIGHTSTRIP_STATE_DIR: `/tmp/${name}` }), `/private/tmp/${name}`)
})
