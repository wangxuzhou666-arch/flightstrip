#!/usr/bin/env node
// flightstrip CLI: start the dashboard, demo mode, session-todo hook setup, macOS LaunchAgent.
// The server itself is dist/server.js (built from server/index.ts); this file only decides whether to start it.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { get } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { runSetup } from '../lib/hook-setup.mjs'
import { claudeDir, findOnPath, tildify } from '../lib/paths.mjs'
import { runService } from '../lib/service.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Same default as server/config.ts (test/paths.test.mjs checks they agree)
const DEFAULT_PORT = 4317
const PROBE_TIMEOUT_MS = 1500

const HELP = `flightstrip: live dashboard for your local Claude Code sessions

Usage:
  flightstrip [--no-open]          Start the dashboard and open it in your browser
  flightstrip --demo [--no-open]   Start with fictional sessions: reads nothing from ~/.claude, saves nothing
  flightstrip setup [--yes]        Install the session-todo hook into ~/.claude/settings.json (and copy statusline.mjs)
  flightstrip uninstall [--yes]    Remove that hook again
  flightstrip service <action>     macOS LaunchAgent: install | uninstall | restart | status | logs
                                   (install takes --dry-run to print the plist without touching launchd)
  flightstrip --help | --version

Environment:
  PORT                      Port to listen on, default ${DEFAULT_PORT}. The dashboard only listens on 127.0.0.1
  FLIGHTSTRIP_STATE_DIR     Where groups, summaries and session todos are kept, default ~/.flightstrip
  FLIGHTSTRIP_BRIEFS        on (default) | off. off = no \`claude -p\` calls for goal, progress and job summaries
  FLIGHTSTRIP_CONTEXT_LINE  Token count the context meter treats as "full", default 400000
  FLIGHTSTRIP_LANG          en | zh. The language until you pick one with the toggle in the page, which is then remembered.
                            Default: your system language, English if it is not Chinese
  CLAUDE_CONFIG_DIR         Where Claude Code keeps its data, default ~/.claude (the variable Claude Code itself reads)
  FLIGHTSTRIP_DEMO          1 = same as --demo
`

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        demo: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'dry-run': { type: 'boolean' },
      },
    })
  } catch (err) {
    // parseArgs appends a long hint about `--` to its message; the first sentence is the useful part
    return fail(`${err.message.split('. ')[0].replace(/\.$/, '')}.\nRun \`flightstrip --help\` for usage.`, 2)
  }
}

function portFromEnv() {
  const raw = process.env.PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT must be an integer between 1 and 65535, got "${raw}"`, 2)
  return port
}

/** What is on this port: nothing, a flightstrip (demo or not), or something else */
function probe(port) {
  return new Promise((done) => {
    const request = get({ host: '127.0.0.1', port, path: '/api/health', timeout: PROBE_TIMEOUT_MS }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        if (body.length < 4096) body += chunk
      })
      res.on('end', () => done(describeHealth(body)))
    })
    request.on('timeout', () => {
      request.destroy()
      done({ kind: 'other' })
    })
    request.on('error', (err) => done({ kind: err.code === 'ECONNREFUSED' ? 'free' : 'other' }))
  })
}

function describeHealth(body) {
  let health
  try {
    health = JSON.parse(body)
  } catch {
    return { kind: 'other' }
  }
  return health?.app === 'flightstrip' ? { kind: 'flightstrip', demo: health.demo === true } : { kind: 'other' }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open'
  if (command === null) {
    console.log(`Open ${url} in your browser.`)
    return
  }
  const child = spawn(command, [url], { stdio: 'ignore', detached: true })
  child.on('error', () => console.log(`Could not open a browser automatically. Open ${url} yourself.`))
  child.unref()
}

/** Things worth knowing before the first screen: they don't stop the server, the board just shows less */
function printPreflightNotes() {
  const claudeHome = tildify(claudeDir())
  if (findOnPath('claude') === null) {
    console.warn(`Note: the \`claude\` CLI is not on your PATH. Sessions are still listed from ${claudeHome}, but goal and progress summaries, the usage refresh and stopping background sessions need it. FLIGHTSTRIP_BRIEFS=off turns the summaries off.`)
  }
  if (!existsSync(claudeDir())) {
    console.warn(`Note: ${claudeHome} does not exist yet, so there are no sessions to show. Start a Claude Code session, or look around first with: flightstrip --demo`)
  }
}

async function start({ demo, noOpen }) {
  const port = portFromEnv()
  const url = `http://127.0.0.1:${port}`
  const running = await probe(port)
  if (running.kind === 'other') {
    fail(`Port ${port} is already in use by something that is not flightstrip. Pick another port, e.g.\n  PORT=${port + 1} flightstrip${demo ? ' --demo' : ''}`)
  }
  if (running.kind === 'flightstrip') {
    if (running.demo !== demo) {
      fail(`A flightstrip ${running.demo ? 'demo' : 'dashboard'} is already running on port ${port}. Open ${url}, or use another port for this one, e.g.\n  PORT=${port + 1} flightstrip${demo ? ' --demo' : ''}`)
    }
    console.log(`flightstrip is already running at ${url}`)
    if (!noOpen) openBrowser(url)
    return
  }
  const serverPath = join(ROOT, 'dist', 'server.js')
  if (!existsSync(serverPath)) fail(`${serverPath} does not exist. In a source checkout, run \`npm run build\` first.`)
  if (demo) process.env.FLIGHTSTRIP_DEMO = '1'
  else printPreflightNotes()
  try {
    // The server module listens at import time; when this resolves it is up (it exits by itself if it can't listen)
    await import(pathToFileURL(serverPath).href)
  } catch (err) {
    // A bad FLIGHTSTRIP_* value is reported by config.ts in one readable sentence; anything else is a bug worth a stack trace
    const isConfigMistake = /^(PORT|FLIGHTSTRIP_\w+) must be /.test(err.message)
    fail(`flightstrip could not start: ${isConfigMistake ? err.message : err.stack}`)
  }
  if (!noOpen) openBrowser(url)
}

const { values, positionals } = parseCommandLine()
const [command, subcommand, ...extra] = positionals
const demo = values.demo === true || /^(1|on)$/i.test(process.env.FLIGHTSTRIP_DEMO ?? '')

if (values.help) {
  console.log(HELP)
} else if (values.version) {
  console.log(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version)
} else if (command === undefined) {
  await start({ demo, noOpen: values['no-open'] === true })
} else if (command === 'setup' || command === 'uninstall') {
  process.exitCode = await runSetup({ uninstall: command === 'uninstall', yes: values.yes === true })
} else if (command === 'service' && subcommand !== undefined && extra.length === 0) {
  process.exitCode = runService(subcommand, { dryRun: values['dry-run'] === true })
} else {
  fail(`Unknown command: ${positionals.join(' ')}\nRun \`flightstrip --help\` for usage.`, 2)
}
