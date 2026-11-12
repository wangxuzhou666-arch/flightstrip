import type { Lang } from '../../shared/i18n/index.ts'
import { shownTranslator } from './i18n.tsx'

// Write actions. The X-Flightstrip header is the marker the server accepts from the local page; other sites can't send a
// cross-origin request carrying it. X-Flightstrip-Token is the token the page got when the CLI opened it; other programs
// on this machine (another user, an app in a sandbox) can't get it
export type SessionAction = 'rename' | 'retire' | 'unretire' | 'group'
export type GroupOp = 'create' | 'rename' | 'delete' | 'move'

const TOKEN_KEY = 'flightstrip-write-token'

/** Pairing: the CLI opens the board with #t=<token>. Keep it, then take it out of the address bar (so it stays out of
 *  history and screenshots) */
export function adoptPairingToken(): void {
  const pairing = /^#t=([0-9a-f]{64})$/.exec(window.location.hash)
  if (pairing === null) return
  try {
    localStorage.setItem(TOKEN_KEY, pairing[1])
  } catch {
    // Storage unavailable (private browsing): the page still shows everything; writes explain how to pair
  }
  history.replaceState(null, '', window.location.pathname + window.location.search)
}

function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flightstrip': '1', 'X-Flightstrip-Token': token() },
    body: JSON.stringify(body),
  })
  const reply = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string }
  if (res.ok) return reply
  // The server words its own errors in the page's language; this fallback is for replies that are not its JSON (a proxy, a crash)
  throw new Error(reply.error ?? shownTranslator()('error.http', { status: res.status }))
}

// Every write below has a static-build branch (see globals.d.ts): there it goes to the in-browser board and no request is made.
// The /api paths sit only in the other branch, which is how the pages build ends up without any of them.

export async function postAction(sessionId: string, action: SessionAction, body: Record<string, unknown> = {}): Promise<void> {
  if (__STATIC_DEMO__) (await import('./staticDemo.ts')).applyAction(sessionId, action, body)
  else await post(`/api/sessions/${sessionId}/${action}`, body)
}

export async function postGroup(op: GroupOp, body: Record<string, unknown>): Promise<void> {
  if (__STATIC_DEMO__) (await import('./staticDemo.ts')).applyGroupOp(op, body)
  else await post(`/api/groups/${op}`, body)
}

/** Act on a row of the memory ranking: end, pause or resume. force only matters for end: the row would not exit on its own.
 *  name is the row's name as shown, so the server can tell when the row has turned into another program since */
export async function hogAction(key: string, name: string, action: 'end' | 'pause' | 'resume', force = false): Promise<void> {
  if (__STATIC_DEMO__) (await import('./staticDemo.ts')).applyHogAction(key, action)
  else await post(`/api/hogs/${action}`, { key, name, force })
}

/** Saves the language on the server; the next snapshot carries it back and the page switches then */
export async function postLang(lang: Lang): Promise<void> {
  if (__STATIC_DEMO__) (await import('./staticDemo.ts')).applyLang(lang)
  else await post('/api/settings', { lang })
}
