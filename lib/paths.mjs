// Paths the CLI shares. The state dir and Claude dir defaults repeat server/config.ts because the CLI runs without the
// server bundle (test/paths.test.mjs checks the copies agree).
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

/** FLIGHTSTRIP_STATE_DIR, or ~/.flightstrip; empty counts as unset */
export function stateDir(env = process.env) {
  return resolve(env.FLIGHTSTRIP_STATE_DIR || join(homedir(), '.flightstrip'))
}

/** CLAUDE_CONFIG_DIR (Claude Code's own variable), or ~/.claude; empty counts as unset */
export function claudeDir(env = process.env) {
  return resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
}

/** /Users/me/x -> ~/x, so paths read short in messages; paths outside HOME stay absolute. HOME behind a symlink matches by its real path too */
export function tildify(path, home = homedir()) {
  const prefix = [home, realpathSync(home)].find((dir) => path === dir || path.startsWith(`${dir}/`))
  return prefix === undefined ? path : `~${path.slice(prefix.length)}`
}

/** The first executable file called `name` on PATH, or null (what `which` does) */
export function findOnPath(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    // Missing, not executable, or a directory: not a match, keep looking on the next PATH entry
    return false
  }
}
