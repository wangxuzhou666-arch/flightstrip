// Set by vite.config.ts: true only in the static build for GitHub Pages (`vite build --mode pages`), where the board is
// assembled in the browser (staticDemo.ts) instead of coming from the local server. Vite substitutes the literal in every
// file, so a normal build drops the branches guarded by it (and with them the demo fixtures), and the pages build drops
// every line that would talk to /api.
declare const __STATIC_DEMO__: boolean
