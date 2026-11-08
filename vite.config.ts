import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { config, DEV_CLIENT_PORT } from './server/config.ts'

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  // In development the frontend runs on DEV_CLIENT_PORT and its data is proxied to the local server; both listen on 127.0.0.1 only
  server: { host: config.host, port: DEV_CLIENT_PORT, strictPort: true, proxy: { '/api': `http://${config.host}:${config.port}` } },
})
