// Builds the server (server/index.ts and everything it imports) into dist/server.js, so the published package runs on
// plain Node with no tsx. Run after the client build: that one empties dist/.
// Chosen over tsc (emits one file per module and keeps the .ts import paths) and esbuild (one more dev dependency):
// Vite is already here for the client, and its SSR build bundles to a single ES module. The server imports only Node
// built-ins, so nothing is left external or needs to be installed next to it.
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'server.js' } },
  },
})
