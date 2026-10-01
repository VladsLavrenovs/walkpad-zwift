/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Bridge base URL, e.g. https://walkpad-bridge.connectedovals.com. Empty = same origin. */
  readonly VITE_BRIDGE_URL?: string
  /** "flat" (default, no Google requests) or "real" (Google Photorealistic 3D Tiles) */
  readonly VITE_WORLD_MODE?: 'flat' | 'real'
  /** Google Maps Platform key (Map Tiles API) for Photorealistic 3D Tiles. Only used when
   * VITE_WORLD_MODE=real. Visible in the bundle: restrict it by HTTP referrer and to the Map
   * Tiles API in Google Cloud. */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
}

/** Where CesiumJS finds its workers and assets (set in vite.config.ts). */
declare const __CESIUM_BASE_URL__: string

interface ImportMeta {
  readonly env: ImportMetaEnv
}
