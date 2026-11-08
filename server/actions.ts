// Write actions from the dashboard: retire, restore, rename.
// Retire = for a background session run `claude stop` (the conversation is kept) and collapse it on the board;
// an interactive session is only collapsed, its process is left alone.
// Rename = append a custom-title line to the transcript, in the same format /rename writes (verified by observation).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentStrip } from '../shared/types.ts'
import { config } from './config.ts'
import { isDemoSession, renameDemoSession, stopDemoSession } from './demo.ts'
import { serverT } from './lang.ts'
import { locateTranscript } from './transcript.ts'

const runFile = promisify(execFile)
const RETIRED_FILE = join(config.stateDir, 'retired.json')
const NAME_LIMIT = 80

/** A business error carrying an HTTP status code: the page shows its message as-is */
export class ActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// sessionId → time of retirement
const retired = new Map<string, number>()

export async function loadRetired(): Promise<void> {
  // Demo mode keeps its writes in memory: nothing is read from or written to the state dir
  if (config.demo || !existsSync(RETIRED_FILE)) return
  const parsed = JSON.parse(await readFile(RETIRED_FILE, 'utf8')) as Record<string, number>
  for (const [sessionId, at] of Object.entries(parsed)) retired.set(sessionId, at)
}

export function retiredSessions(): ReadonlyMap<string, number> {
  return retired
}

async function saveRetired(): Promise<void> {
  if (config.demo) return
  await mkdir(config.stateDir, { recursive: true })
  const temp = `${RETIRED_FILE}.tmp`
  await writeFile(temp, JSON.stringify(Object.fromEntries(retired)))
  await rename(temp, RETIRED_FILE)
}

export async function retire(strip: AgentStrip): Promise<void> {
  // Only live background sessions need a stop; finished or stopped ones are simply collapsed
  const alive = strip.stateKind === 'working' || strip.stateKind === 'needs'
  if (strip.kind === 'background' && alive) {
    if (!/^[0-9a-f]{8}$/.test(strip.shortId)) throw new ActionError(400, serverT('error.badBackgroundId', { id: strip.shortId }))
    if (config.demo) stopDemoSession(strip.sessionId, Date.now())
    else await runFile('claude', ['stop', strip.shortId], { timeout: 20_000 })
  }
  retired.set(strip.sessionId, Date.now())
  await saveRetired()
}

export async function unretire(sessionIds: string[]): Promise<void> {
  const removed = sessionIds.filter((id) => retired.delete(id))
  if (removed.length > 0) await saveRetired()
}

async function endsWithNewline(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) return true
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    await handle.close()
  }
}

export async function renameSession(sessionId: string, rawName: string): Promise<string> {
  const name = rawName.trim()
  if (name === '' || name.length > NAME_LIMIT || /[\r\n]/.test(name)) {
    throw new ActionError(400, serverT('error.sessionName', { max: NAME_LIMIT }))
  }
  if (config.demo) {
    if (!isDemoSession(sessionId)) throw new ActionError(404, serverT('error.transcriptNotFound'))
    renameDemoSession(sessionId, name)
    return name
  }
  const path = await locateTranscript(sessionId)
  if (path === null) throw new ActionError(404, serverT('error.transcriptNotFound'))
  // Claude Code writes whole lines; a file not ending in a newline means it is mid-write, and appending now would glue two lines together
  if (!(await endsWithNewline(path))) throw new ActionError(409, serverT('error.transcriptBusy'))
  await appendFile(path, `${JSON.stringify({ type: 'custom-title', customTitle: name, sessionId })}\n`)
  return name
}
