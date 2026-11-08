import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { config, DEV_CLIENT_PORT } from './server/config.ts'

// `vite build --mode pages` is the static demo for GitHub Pages (client/src/globals.d.ts): served under /flightstrip/,
// built to dist-pages/, which is not in the npm package (package.json "files" lists dist/ only)
export default defineConfig(({ mode }) => {
  const pages = mode === 'pages'
  return {
    root: 'client',
    base: pages ? '/flightstrip/' : '/',
    define: { __STATIC_DEMO__: JSON.stringify(pages) },
    plugins: [react()],
    build: { outDir: pages ? '../dist-pages' : '../dist', emptyOutDir: true },
    // In development the frontend runs on DEV_CLIENT_PORT and its data is proxied to the local server; both listen on 127.0.0.1 only
    server: { host: config.host, port: DEV_CLIENT_PORT, strictPort: true, proxy: { '/api': `http://${config.host}:${config.port}` } },
  }
})
