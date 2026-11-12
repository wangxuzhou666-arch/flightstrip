// Local dashboard server: listens on 127.0.0.1 only, pushes snapshots to the browser over SSE,
// and exposes a few write actions (retire, rename, groups, language, and pausing or ending a row of the memory ranking).
// Refreshes are driven by file changes (session state, background jobs, transcripts and usage push
// as soon as they hit disk); polling is only a fallback. Nothing is collected while no browser is connected,
// except the memory alert (alerts.ts).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ActionError } from '../shared/actionError.ts'
import { isLang } from '../shared/i18n/index.ts'
import type { AgentStrip } from '../shared/types.ts'
import { loadRetired, renameSession, retire, retiredSessions, unretire } from './actions.ts'
import { startBriefs } from './brief.ts'
import { startAlerts } from './alerts.ts'
import { collectSnapshot } from './collect.ts'
import { config, DEV_CLIENT_PORT } from './config.ts'
import { type HogAction, signalHog } from './hogs.ts'
import { assignGroup, createGroup, deleteGroup, loadGroups, moveGroup, renameGroup } from './groups.ts'
import { loadLang, saveLang, serverT } from './lang.ts'
import { startUsageRefresh, stopUsageRefresh } from './usageRefresh.ts'

// Fallback polling: the timeline must advance with the clock, and not every `claude agents` state change reaches disk
const FALLBACK_MS = 3000
// Minimum gap between two collections: while an agent works its transcript is written several times a second,
// and without throttling the collector would never stop
const MIN_GAP_MS = 300
const BODY_LIMIT = 4096
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'dist')
// Same ROOT whether this runs from source (server/index.ts) or from the build (dist/server.js): both sit one level below it
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const WATCHED = [...['sessions', 'jobs', 'projects'].map((dir) => join(config.claudeDir, dir)), config.stateDir]
// Against DNS rebinding: another site resolving its domain to 127.0.0.1 still can't read local session content
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${config.port}`, `localhost:${config.port}`, `127.0.0.1:${DEV_CLIENT_PORT}`, `localhost:${DEV_CLIENT_PORT}`,
])
// Extra guard for writes: only accept requests from the local page
// (Origin match + custom header, which other sites' forms and simple requests can't send)
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`))
const ACTION_ROUTE = /^\/api\/sessions\/([0-9a-f-]{36})\/(rename|retire|unretire|group)$/
const GROUP_ROUTE = /^\/api\/groups\/(create|rename|delete|move)$/
const HOG_ROUTE = /^\/api\/hogs\/(end|pause|resume)$/
const SETTINGS_ROUTE = '/api/settings'
// The write token. Host, Origin and X-Flightstrip can all be forged by any program on this machine: another user, or an
// app in a sandbox, could connect to 127.0.0.1 and end your processes. The token lives in a file only you can read
// (0600, <state dir>/write-token); the CLI opens the board with #t=<token>, the page keeps it and sends it with every write.
// Demo mode writes nothing and signals nothing, and saves no files, so it has no token
const TOKEN = config.demo ? null : loadToken()

const clients = new Set<ServerResponse>()
let latestPayload: string | null = null
let latestStrips = new Map<string, AgentStrip>()
let collecting = false
let rerunRequested = false
let lastCollectAt = 0
let pendingTimer: NodeJS.Timeout | null = null

async function refresh(): Promise<void> {
  if (clients.size === 0) {
    stopUsageRefresh()
    return
  }
  if (!config.demo) startUsageRefresh(config.stateDir, requestRefresh)
  if (collecting) {
    rerunRequested = true
    return
  }
  collecting = true
  lastCollectAt = Date.now()
  try {
    const collected = await collectSnapshot(retiredSessions())
    latestPayload = JSON.stringify(collected.snapshot)
    latestStrips = new Map(collected.allStrips.map((strip) => [strip.sessionId, strip]))
    await unretire(collected.revived)
    for (const client of clients) client.write(`data: ${latestPayload}\n\n`)
  } catch (err) {
    // Boundary of the long-running loop: a failed round is only logged; the next trigger collects as usual,
    // so the dashboard doesn't stop entirely
    console.error('[refresh]', err)
  } finally {
    collecting = false
  }
  if (rerunRequested) {
    rerunRequested = false
    requestRefresh()
  }
}

/** Coalesces bursts of triggers and keeps at least MIN_GAP_MS between two collections */
function requestRefresh(): void {
  if (pendingTimer !== null) return
  const wait = Math.max(0, lastCollectAt + MIN_GAP_MS - Date.now())
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    refresh().catch((err) => console.error('[refresh]', err))
  }, wait)
}

function startWatching(): void {
  // Demo mode reads no files, so there is nothing to watch (and no state dir to create): polling alone drives the clock
  if (!config.demo) watchFiles()
  setInterval(requestRefresh, FALLBACK_MS)
}

function watchFiles(): void {
  mkdirSync(config.stateDir, { recursive: true })
  for (const dir of WATCHED) {
    if (!existsSync(dir)) {
      console.warn(`[watch] ${dir} does not exist yet; relying on polling for it`)
      continue
    }
    // On macOS, recursive uses FSEvents, so it's cheap
    // A watcher error (the directory deleted) must not take the server down; polling still covers it
    watch(dir, { recursive: true }, (_event, file) => {
      if (file !== null && /tool-results|file-history|\.tmp$/.test(file)) return
      requestRefresh()
    }).on('error', (err) => console.warn(`[watch] ${dir} failed, relying on polling: ${err.message}`))
  }
}

function openStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  if (latestPayload !== null) res.write(`data: ${latestPayload}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
  requestRefresh()
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let text = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      // Once over the limit nothing more is kept, however much follows: a huge request must not fill memory
      if (tooLarge) return
      text += chunk
      if (text.length > BODY_LIMIT) {
        tooLarge = true
        text = ''
        reject(new ActionError(413, serverT('error.tooLarge')))
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      if (text === '') return resolveBody({})
      try {
        resolveBody(JSON.parse(text) as Record<string, unknown>)
      } catch {
        reject(new ActionError(400, serverT('error.notJson')))
      }
    })
    req.on('error', reject)
  })
}

function loadToken(): string {
  const file = join(config.stateDir, 'write-token')
  mkdirSync(config.stateDir, { recursive: true })
  try {
    const saved = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(saved)) return saved
  } catch {
    // First start: made below
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  // mode only applies to a new file: one left over (unreadable, or another program's) keeps its own permissions
  chmodSync(file, 0o600)
  return token
}

/** Writes are accepted only from the local page: POST + X-Flightstrip header + matching Origin */
function isTrustedWrite(req: IncomingMessage): boolean {
  return req.method === 'POST' && req.headers['x-flightstrip'] === '1' && ALLOWED_ORIGINS.has(req.headers.origin ?? '')
}

/** Carries the token the page got when it was opened by the CLI */
function hasToken(req: IncomingMessage): boolean {
  if (TOKEN === null) return true
  const sent = Buffer.from(String(req.headers['x-flightstrip-token'] ?? ''))
  const expected = Buffer.from(TOKEN)
  return sent.length === expected.length && timingSafeEqual(sent, expected)
}

async function runWrite(
  req: IncomingMessage, res: ServerResponse, label: string,
  perform: (body: Record<string, unknown>) => Promise<Record<string, unknown> | void>,
): Promise<void> {
  if (!isTrustedWrite(req)) {
    res.writeHead(403).end()
    return
  }
  if (!hasToken(req)) {
    sendJson(res, 401, { error: serverT('error.unpaired') })
    return
  }
  try {
    const reply = await perform(await readJsonBody(req))
    sendJson(res, 200, { ok: true, ...reply })
    requestRefresh()
  } catch (err) {
    // Request boundary: tell the page the failure reason as-is; the server keeps running
    const status = err instanceof ActionError ? err.status : 500
    if (status === 500) console.error(`[action] ${label}`, err)
    sendJson(res, status, { error: (err as Error).message.split('\n')[0] })
  }
}

async function sessionAction(sessionId: string, action: string, body: Record<string, unknown>): Promise<void> {
  if (action === 'unretire') return unretire([sessionId])
  const strip = latestStrips.get(sessionId)
  if (strip === undefined) throw new ActionError(404, serverT('error.sessionGone'))
  if (action === 'retire') return retire(strip)
  if (action === 'group') return assignGroup(sessionId, body.groupId ?? null)
  await renameSession(sessionId, String(body.name ?? ''))
}

async function groupAction(op: string, body: Record<string, unknown>): Promise<Record<string, unknown> | void> {
  if (op === 'create') {
    // "New group…" on a card sends its sessionId: move that session into the new group right away
    const sessionId = typeof body.sessionId === 'string' && latestStrips.has(body.sessionId) ? body.sessionId : null
    return { id: await createGroup(body.name, sessionId) }
  }
  if (op === 'rename') return renameGroup(body.id, body.name)
  if (op === 'delete') return deleteGroup(body.id)
  return moveGroup(body.id, body.before ?? null)
}

async function settingsAction(body: Record<string, unknown>): Promise<void> {
  if (!isLang(body.lang)) throw new ActionError(400, serverT('error.badLang'))
  await saveLang(body.lang)
  // A page that connects before the next collection finishes must not be handed a snapshot in the old language
  latestPayload = null
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
}

/** A missing file or a read error answers this one request only; it must not surface as a crash of the whole server */
function sendFile(res: ServerResponse, path: string): void {
  const stream = createReadStream(path)
  stream.once('open', () => {
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
    stream.pipe(res)
  })
  stream.once('error', (err: NodeJS.ErrnoException) => {
    if (!res.headersSent) res.writeHead(err.code === 'ENOENT' ? 404 : 500).end()
    else res.destroy()
  })
}

function isFile(path: string): boolean {
  // A build empties dist and writes it again: the file can vanish between the check and the read
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const target = normalize(join(DIST, pathname))
  if (!target.startsWith(DIST)) {
    res.writeHead(403).end()
  } else if (isFile(target)) {
    sendFile(res, target)
  } else if (isFile(join(DIST, 'index.html'))) {
    sendFile(res, join(DIST, 'index.html'))
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The web page is not built yet. Run npm run build, or use npm run dev while developing.')
  }
}

const server = createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    res.writeHead(403).end()
    return
  }
  const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const action = ACTION_ROUTE.exec(pathname)
  const groupOp = GROUP_ROUTE.exec(pathname)
  const hogOp = HOG_ROUTE.exec(pathname)
  if (action !== null) {
    void runWrite(req, res, `${action[2]} ${action[1]}`, (body) => sessionAction(action[1], action[2], body))
  } else if (groupOp !== null) {
    void runWrite(req, res, `group ${groupOp[1]}`, (body) => groupAction(groupOp[1], body))
  } else if (hogOp !== null) {
    void runWrite(req, res, `hog ${hogOp[1]}`, async (body) => ({ signalled: await signalHog(String(body.key ?? ''), typeof body.name === 'string' ? body.name : null, hogOp[1] as HogAction, body.force === true) }))
  } else if (pathname === SETTINGS_ROUTE) {
    void runWrite(req, res, 'settings', settingsAction)
  } else if (pathname === '/api/stream') {
    openStream(req, res)
  } else if (pathname === '/api/health') {
    // The CLI asks this before starting: "is the thing on this port a flightstrip?"
    sendJson(res, 200, { app: 'flightstrip', version: VERSION, demo: config.demo })
  } else {
    serveStatic(pathname, res)
  }
})

function listen(): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
}

await loadLang()
await loadRetired()
await loadGroups()
if (!config.demo) await startBriefs(requestRefresh)
try {
  await listen()
} catch (err) {
  // The CLI checks the port first, so this is the race (or a service started twice): say what to do instead of a stack trace
  const code = (err as NodeJS.ErrnoException).code
  console.error(code === 'EADDRINUSE'
    ? `Port ${config.port} is already in use. Stop whatever is using it, or pick another port, e.g. PORT=${config.port + 1}`
    : `Could not listen on ${config.host}:${config.port}: ${(err as Error).message}`)
  process.exit(1)
}
console.log(`flightstrip is running at http://${config.host}:${config.port}${config.demo ? ' (demo mode: fictional sessions, nothing is read or saved)' : ''}`)
startWatching()
startAlerts()
