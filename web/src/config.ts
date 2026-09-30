/** Where the bridge lives and how this page runs. */

export interface AppConfig {
  /** Bridge HTTP base URL without trailing slash; '' = same origin. */
  bridgeUrl: string
  /** ?view=obs: no controls, transparent background (OBS browser source). */
  obs: boolean
  /** ?world=<id> preselects a world. */
  world: string | null
}

export function bridgeWsUrl(bridgeUrl: string, path: string, origin: string): string {
  const base = bridgeUrl || origin
  return base.replace(/^http/, 'ws').replace(/\/$/, '') + path
}

export function loadConfig(env: ImportMetaEnv, search: string): AppConfig {
  const params = new URLSearchParams(search)
  return {
    bridgeUrl: (env.VITE_BRIDGE_URL ?? '').replace(/\/$/, ''),
    obs: params.get('view') === 'obs',
    world: params.get('world'),
  }
}
