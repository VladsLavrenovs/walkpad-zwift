/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Bridge base URL, e.g. http://localhost:8000 */
  readonly VITE_BRIDGE_URL?: string
  /** "flat" (default, no Google requests) or "real" (Google Photorealistic 3D Tiles) */
  readonly VITE_WORLD_MODE?: 'flat' | 'real'
  /** Google Maps Platform key for 3D Tiles. Only used when VITE_WORLD_MODE=real. */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
