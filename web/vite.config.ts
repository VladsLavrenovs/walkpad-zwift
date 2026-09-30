/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'

// In dev, the bridge API and WebSocket are proxied through the Vite server, so the page is
// same-origin with them: no CORS, and belt control works (the bridge sees a local client).
// Target: BRIDGE_DEV_URL in web/.env (default http://localhost:8080, i.e. `serve --fake`).
const BRIDGE_PATHS = ['/status', '/sessions', '/stats', '/control', '/videos', '/live']

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.BRIDGE_DEV_URL || 'http://localhost:8080'
  return {
    server: {
      proxy: Object.fromEntries(
        BRIDGE_PATHS.map((path) => [path, { target, changeOrigin: true, ws: path === '/live' }]),
      ),
    },
    test: {
      environment: 'node',
    },
  }
})
