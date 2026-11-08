import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Snapshot } from '../../shared/types.ts'

export type Connection = 'connecting' | 'live' | 'lost'

/** Which strip sits in which bay and group and in what order, and how the groups are arranged; the slide animation plays only when this changes */
function layoutSignature(snapshot: Snapshot): string {
  const strips = snapshot.strips.map((s) => `${s.sessionId}:${s.bay}:${s.groupId ?? ''}`).join('|')
  return `${snapshot.groups.map((g) => g.id).join(',')}@${snapshot.ungroupedAt}#${strips}`
}

function prefersMotion(): boolean {
  return 'startViewTransition' in document && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The local server: snapshots over SSE */
function watchServer(receive: (next: Snapshot) => void, setConnection: (connection: Connection) => void): () => void {
  const source = new EventSource('/api/stream')
  source.onopen = () => setConnection('live')
  // EventSource reconnects by itself after a drop; here we only tell you it dropped
  source.onerror = () => setConnection('lost')
  source.onmessage = (event: MessageEvent<string>) => receive(JSON.parse(event.data) as Snapshot)
  return () => source.close()
}

/** The static build: the board assembled in the browser, no connection to lose (see globals.d.ts) */
function watchStaticDemo(receive: (next: Snapshot) => void): () => void {
  let stop: (() => void) | null = null
  let cancelled = false
  void import('./staticDemo.ts').then(({ subscribe }) => {
    if (!cancelled) stop = subscribe(receive)
  })
  return () => {
    cancelled = true
    stop?.()
  }
}

export function useSnapshot(): { snapshot: Snapshot | null; connection: Connection } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    let lastSignature = ''
    const receive = (next: Snapshot) => {
      const signature = layoutSignature(next)
      const moved = lastSignature !== '' && signature !== lastSignature
      lastSignature = signature
      const apply = () => {
        setConnection('live')
        setSnapshot(next)
      }
      if (moved && prefersMotion()) {
        // When a strip changes bay, let the browser slide it from the old position to the new one
        document.startViewTransition(() => flushSync(apply))
      } else {
        apply()
      }
    }
    return __STATIC_DEMO__ ? watchStaticDemo(receive) : watchServer(receive, setConnection)
  }, [])

  return { snapshot, connection }
}
