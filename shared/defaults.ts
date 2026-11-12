// Numbers the server and the static demo build (client/src/staticDemo.ts) must agree on, so neither keeps its own copy.

/** The span the timeline on every strip covers */
export const WINDOW_MS = 3 * 60 * 60 * 1000

/** The token count the context meter treats as "full" until FLIGHTSTRIP_CONTEXT_LINE says otherwise */
export const DEFAULT_CONTEXT_LINE = 400_000

/** How often the dashboard has Claude Code pull usage (`claude -p /usage`). Measured 2026-11-11: the current /usage also
 *  scans every local transcript, 10 s of CPU and a 420 MB peak, and under memory pressure it runs past 60 s and is
 *  killed. Every 2 minutes was too costly */
export const USAGE_REFRESH_MS = 10 * 60_000

/** No new usage for this long and the band shows when the figure is from: two refreshes missed, plus time for one run */
export const USAGE_STALE_MS = USAGE_REFRESH_MS * 2 + 5 * 60_000
