// Numbers the server and the static demo build (client/src/staticDemo.ts) must agree on, so neither keeps its own copy.

/** The span the timeline on every strip covers */
export const WINDOW_MS = 3 * 60 * 60 * 1000

/** The token count the context meter treats as "full" until FLIGHTSTRIP_CONTEXT_LINE says otherwise */
export const DEFAULT_CONTEXT_LINE = 400_000
