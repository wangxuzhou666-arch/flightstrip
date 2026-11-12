// Which row of the memory ranking to handle first when memory is tight: the board marks it and the alert names it, by
// the same rule.
import type { Hog } from './types.ts'

/** The biggest task still running (it can be paused, nothing lost); failing that, the biggest app with no session
 *  inside that can be ended. The ranking comes sorted biggest first */
export function suggested(hogs: Hog[]): Hog | null {
  return hogs.find((hog) => hog.pausable && !hog.paused)
    ?? hogs.find((hog) => hog.kind === 'app' && hog.killable && hog.hostedSessions === 0)
    ?? null
}
