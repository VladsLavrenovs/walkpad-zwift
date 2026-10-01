/// <reference types="vitest/config" />
import { cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Plugin, defineConfig, loadEnv } from 'vite'

// In dev, the bridge API and WebSocket are proxied through the Vite server, so the page is
// same-origin with them: no CORS, and belt control works (the bridge sees a local client).
// Target: BRIDGE_DEV_URL in web/.env (default http://localhost:8080, i.e. `serve --fake`).
const BRIDGE_PATHS = ['/status', '/sessions', '/stats', '/control', '/videos', '/routes', '/tiles3d', '/live']

// CesiumJS needs its static assets (web workers, images, widget CSS) at CESIUM_BASE_URL.
// Dev: served straight from node_modules. Build: copied to dist/cesium (about 8 MB).
const CESIUM_SRC = resolve(__dirname, 'node_modules/cesium/Build/Cesium')
const CESIUM_DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets']

function cesiumAssets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'walkpad-cesium-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    writeBundle() {
      if (!existsSync(CESIUM_SRC)) throw new Error('cesium is not installed: run npm ci')
      for (const dir of CESIUM_DIRS) cpSync(resolve(CESIUM_SRC, dir), resolve(outDir, 'cesium', dir), { recursive: true })
    },
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.BRIDGE_DEV_URL || 'http://localhost:8080'
  return {
    plugins: [cesiumAssets()],
    define: {
      __CESIUM_BASE_URL__: JSON.stringify(command === 'serve' ? '/node_modules/cesium/Build/Cesium/' : '/cesium/'),
    },
    build: {
      // Cesium is loaded lazily as its own (large) chunk, only when the 3D world is opened.
      chunkSizeWarningLimit: 6000,
    },
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
