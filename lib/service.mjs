// `flightstrip service …`: runs the dashboard as a macOS LaunchAgent, so it starts at login and restarts if it exits.
// Ported from the old scripts/service.sh. The agent runs `node <package>/dist/server.js` directly (no CLI, no tsx).
//
// A LaunchAgent stores the absolute path of the package, so that path has to outlive this command. A package run by
// `npx` lives in a cache npm cleans up: install refuses there and asks for `npm i -g flightstrip` first.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findOnPath, stateDir, tildify } from './paths.mjs'

export const SERVICE_LABEL = 'dev.flightstrip'
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// launchd does not inherit the shell environment: these are copied into the plist when set in the shell that runs `install`
const CONFIG_VARIABLES = ['PORT', 'FLIGHTSTRIP_STATE_DIR', 'FLIGHTSTRIP_BRIEFS', 'FLIGHTSTRIP_CONTEXT_LINE', 'FLIGHTSTRIP_LANG', 'CLAUDE_CONFIG_DIR']
const LOG_LINES = 40
const LOG_TAIL_BYTES = 64 * 1024
// npm's npx cache (~/.npm/_npx/<hash>/…), pnpm dlx and bunx temporary installs
const EPHEMERAL_PATH = /[\\/](_npx|dlx-[^\\/]+|\.bun[\\/]install[\\/]cache)[\\/]/

export function isEphemeralInstall(packageRoot) {
  return EPHEMERAL_PATH.test(packageRoot)
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The LaunchAgent plist. launchd gives a minimal PATH, so the directories of node, claude and gh (all called by the server) are written in */
export function plistFor({ label, nodePath, serverPath, workingDir, logPath, pathDirs, env }) {
  const entry = (key, value) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`
  const variables = CONFIG_VARIABLES.filter((name) => env[name]).map((name) => entry(name, env[name]))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(serverPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${[entry('PATH', pathDirs.join(':')), ...variables].join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`
}

function launchctl(args, { quiet = false } = {}) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: quiet ? 'ignore' : ['ignore', 'pipe', 'pipe'] })
}

/** Exit code: 0 done, 1 could not do it. `label` is a parameter so tests can use a throwaway agent next to a real one */
export function runService(action, { dryRun = false, label = SERVICE_LABEL, env = process.env, packageRoot = PACKAGE_ROOT } = {}) {
  if (process.platform !== 'darwin') {
    console.error('`flightstrip service` manages a macOS LaunchAgent and only works on macOS. On Linux, run flightstrip from a systemd user unit or your shell profile.')
    return 1
  }
  const domain = `gui/${process.getuid()}`
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  const logPath = join(stateDir(env), 'server.log')
  switch (action) {
    case 'install':
      return install({ label, domain, plistPath, logPath, env, packageRoot, dryRun })
    case 'uninstall':
      return uninstall({ label, domain, plistPath, dryRun })
    case 'restart':
      return restart({ label, domain })
    case 'status':
      return status({ label, domain })
    case 'logs':
      return logs(logPath)
    default:
      console.error(`Unknown service action "${action}". Use: install | uninstall | restart | status | logs`)
      return 2
  }
}

function install({ label, domain, plistPath, logPath, env, packageRoot, dryRun }) {
  if (isEphemeralInstall(packageRoot)) {
    console.error(`flightstrip is running from a temporary location (${packageRoot}), and a LaunchAgent needs a path that stays.\nInstall it first:  npm i -g flightstrip\nthen run:          flightstrip service install`)
    return 1
  }
  const serverPath = join(packageRoot, 'dist', 'server.js')
  if (!existsSync(serverPath)) {
    console.error(`${serverPath} does not exist. In a source checkout, run \`npm run build\` first.`)
    return 1
  }
  const claudePath = findOnPath('claude', env)
  const toolDirs = [process.execPath, claudePath, findOnPath('gh', env)].filter((path) => path !== null).map(dirname)
  const pathDirs = [...new Set([...toolDirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
  const plist = plistFor({ label, nodePath: process.execPath, serverPath, workingDir: packageRoot, logPath, pathDirs, env })
  if (claudePath === null) {
    console.warn('Note: `claude` was not found on PATH. The service still lists sessions, but summaries, usage refresh and stopping background sessions need it.')
  }
  if (dryRun) {
    console.log(`Dry run: nothing is written and launchctl is not called.\nWould write ${plistPath}:\n\n${plist}\nWould run: launchctl bootout ${domain}/${label} (ignoring "not loaded")\nWould run: launchctl bootstrap ${domain} ${plistPath}`)
    return 0
  }
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(plistPath, plist)
  bootout({ label, domain })
  return bootstrap({ label, domain, plistPath, logPath })
}

/** Stops and unloads the agent; an agent that is not loaded is not an error */
function bootout({ label, domain }) {
  try {
    launchctl(['bootout', `${domain}/${label}`], { quiet: true })
  } catch {
    // Not loaded: nothing to stop
  }
}

function bootstrap({ label, domain, plistPath, logPath }) {
  try {
    launchctl(['bootstrap', domain, plistPath])
  } catch (err) {
    console.error(`launchctl bootstrap failed: ${(err.stderr || err.message).toString().trim()}`)
    return 1
  }
  console.log(`Installed ${label}: ${tildify(plistPath)}\nLogs: ${tildify(logPath)}  (flightstrip service logs)`)
  // A bookmarked address opens the board read-only: the write token comes with the link the CLI opens
  console.log('Open the board with `flightstrip`: it finds the running service and opens a tab that can act on it.')
  return 0
}

function uninstall({ label, domain, plistPath, dryRun }) {
  if (dryRun) {
    console.log(`Dry run: would run launchctl bootout ${domain}/${label} and delete ${plistPath}`)
    return 0
  }
  bootout({ label, domain })
  rmSync(plistPath, { force: true })
  console.log('Uninstalled.')
  return 0
}

function restart({ label, domain }) {
  try {
    launchctl(['kickstart', '-k', `${domain}/${label}`])
  } catch (err) {
    console.error(`Could not restart ${label}: ${(err.stderr || err.message).toString().trim()}\nIs it installed? Try: flightstrip service install`)
    return 1
  }
  console.log('Restarted.')
  return 0
}

function status({ label, domain }) {
  let report
  try {
    report = launchctl(['print', `${domain}/${label}`])
  } catch {
    console.log('Not installed.')
    return 0
  }
  console.log(report.split('\n').filter((line) => /^\s*(state|pid|last exit code)\b/.test(line)).join('\n'))
  return 0
}

function logs(logPath) {
  if (!existsSync(logPath)) {
    console.error(`No log yet at ${logPath}.`)
    return 1
  }
  // Only the end of the file: a long-running service's log can be large
  const fd = openSync(logPath, 'r')
  try {
    const { size } = fstatSync(fd)
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    console.log(buffer.toString('utf8').split('\n').slice(-LOG_LINES - 1).join('\n'))
  } finally {
    closeSync(fd)
  }
  return 0
}
