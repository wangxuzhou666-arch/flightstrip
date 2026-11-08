// CLI surface that needs no running server: help/version/errors, port conflicts, and `service` (only ever with
// --dry-run or a throwaway plist: the real launchd is never touched).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isEphemeralInstall, plistFor } from '../lib/service.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const roots = []
const macOnly = { skip: process.platform !== 'darwin' }

after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fs-cli-')))
  roots.push(dir)
  return dir
}

/** A copy of the package as it would sit after an install, with a stub server bundle unless `dist` is false */
function installedAt(location, { dist = true } = {}) {
  mkdirSync(location, { recursive: true })
  for (const name of ['bin', 'lib', 'hooks', 'package.json']) cpSync(join(REPO, name), join(location, name), { recursive: true })
  if (dist) {
    mkdirSync(join(location, 'dist'))
    writeFileSync(join(location, 'dist', 'server.js'), '// stub\n')
  }
  return join(location, 'bin', 'flightstrip.mjs')
}

function cli(script, args, env = {}) {
  const home = tempDir()
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, HOME: home, ...env },
  })
  return { status: result.status, out: result.stdout, err: result.stderr, home }
}

const ENTRY = join(REPO, 'bin', 'flightstrip.mjs')

test('--version prints the package version', () => {
  assert.equal(cli(ENTRY, ['--version']).out.trim(), JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version)
})

test('--help lists every command', () => {
  const { out, status } = cli(ENTRY, ['--help'])
  assert.equal(status, 0)
  for (const word of ['--demo', '--no-open', 'setup', 'uninstall', 'service', 'PORT', 'FLIGHTSTRIP_STATE_DIR', 'FLIGHTSTRIP_BRIEFS']) assert.ok(out.includes(word), word)
})

test('unknown flags and commands exit 2 with a pointer to --help', () => {
  for (const args of [['--bogus'], ['frobnicate'], ['service'], ['service', 'install', 'extra']]) {
    const run = cli(ENTRY, args)
    assert.equal(run.status, 2, args.join(' '))
    assert.match(run.err, /--help/)
  }
})

test('a port taken by something else is reported with a PORT=… suggestion, and nothing is started', async () => {
  const other = createServer((_req, res) => res.end('hello, I am not flightstrip'))
  await new Promise((done) => other.listen(0, '127.0.0.1', done))
  const { port } = other.address()
  try {
    const run = await new Promise((done) => {
      const child = spawn(process.execPath, [ENTRY, '--no-open'], { env: { PATH: process.env.PATH, HOME: tempDir(), PORT: String(port) } })
      let err = ''
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('close', (status) => done({ status, err }))
    })
    assert.equal(run.status, 1)
    assert.match(run.err, new RegExp(`Port ${port} is already in use by something that is not flightstrip`))
    assert.ok(run.err.includes(`PORT=${port + 1} flightstrip`), run.err)
  } finally {
    other.close()
  }
})

test('an invalid PORT is rejected before anything starts', () => {
  const run = cli(ENTRY, ['--no-open'], { PORT: 'eighty' })
  assert.equal(run.status, 2)
  assert.match(run.err, /PORT must be an integer/)
})

test('without a build, starting says to build instead of crashing', () => {
  const script = installedAt(join(tempDir(), 'checkout'), { dist: false })
  const run = cli(script, ['--no-open'], { PORT: '48999' })
  assert.equal(run.status, 1)
  assert.match(run.err, /npm run build/)
})

test('isEphemeralInstall recognises npx, pnpm dlx and bunx caches but not a global or local install', () => {
  for (const path of ['/Users/me/.npm/_npx/9f1c2/node_modules/flightstrip', '/home/me/.cache/pnpm/dlx-1234/node_modules/flightstrip', '/Users/me/.bun/install/cache/flightstrip@1.0.0']) {
    assert.ok(isEphemeralInstall(path), path)
  }
  for (const path of ['/usr/local/lib/node_modules/flightstrip', '/Users/me/.nvm/versions/node/v24/lib/node_modules/flightstrip', '/Users/me/code/flightstrip']) {
    assert.ok(!isEphemeralInstall(path), path)
  }
})

test('service install refuses to run from an npx cache and says to install globally', macOnly, () => {
  const script = installedAt(join(tempDir(), '.npm', '_npx', 'abc123', 'node_modules', 'flightstrip'))
  const run = cli(script, ['service', 'install', '--dry-run'])
  assert.equal(run.status, 1)
  assert.match(run.err, /npm i -g flightstrip/)
  assert.ok(!existsSync(join(run.home, 'Library')), 'no plist was written')
})

test('service install --dry-run prints a plist with the stable path and passes config variables on', macOnly, () => {
  const script = installedAt(join(tempDir(), 'lib', 'node_modules', 'flightstrip'))
  const run = cli(script, ['service', 'install', '--dry-run'], { PORT: '4400', FLIGHTSTRIP_BRIEFS: 'off' })
  assert.equal(run.status, 0, run.err)
  assert.ok(run.out.includes(`<string>${join(dirname(dirname(script)), 'dist', 'server.js')}</string>`), run.out)
  assert.ok(run.out.includes('<key>PORT</key><string>4400</string>'))
  assert.ok(run.out.includes('<key>FLIGHTSTRIP_BRIEFS</key><string>off</string>'))
  assert.ok(!run.out.includes('FLIGHTSTRIP_CONTEXT_LINE'), 'unset variables are not written')
  assert.ok(!existsSync(join(run.home, 'Library')), 'a dry run writes nothing')
})

test('service install without a build asks for one', macOnly, () => {
  const script = installedAt(join(tempDir(), 'checkout'), { dist: false })
  const run = cli(script, ['service', 'install', '--dry-run'])
  assert.equal(run.status, 1)
  assert.match(run.err, /npm run build/)
})

test('the plist is valid XML even when paths contain & < >', macOnly, () => {
  const dir = tempDir()
  const plist = plistFor({
    label: 'dev.flightstrip.test', nodePath: '/usr/local/bin/node', serverPath: '/opt/a&b/dist/server.js', workingDir: '/opt/a&b',
    logPath: '/tmp/<log>.log', pathDirs: ['/usr/bin'], env: { FLIGHTSTRIP_STATE_DIR: '/data/x&y' },
  })
  assert.ok(plist.includes('/opt/a&amp;b/dist/server.js') && plist.includes('/tmp/&lt;log&gt;.log'))
  writeFileSync(join(dir, 'x.plist'), plist)
  const lint = spawnSync('plutil', ['-lint', join(dir, 'x.plist')], { encoding: 'utf8' })
  assert.equal(lint.status, 0, lint.stdout + lint.stderr)
})
