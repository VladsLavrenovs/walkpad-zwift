/** Where the bridge lives and how this page runs. */

export interface AppConfig {
  /** Bridge HTTP base URL without trailing slash; '' = same origin. */
  bridgeUrl: string
  /** ?view=obs: no controls, transparent background (OBS browser source). */
  obs: boolean
  /**
   * The page is not served by the bridge (VITE_BRIDGE_URL set: the Cloudflare deploy): live data
   * and stats only. Belt control is only ever offered by the page the bridge serves on the LAN.
   */
  viewOnly: boolean
  /** ?world=<id> preselects a world. */
  world: string | null
}

export function bridgeWsUrl(bridgeUrl: string, path: string, origin: string): string {
  const base = bridgeUrl || origin
  return base.replace(/^http/, 'ws').replace(/\/$/, '') + path
}

export function loadConfig(env: ImportMetaEnv, search: string): AppConfig {
  const params = new URLSearchParams(search)
  const bridgeUrl = (env.VITE_BRIDGE_URL ?? '').replace(/\/$/, '')
  return {
    bridgeUrl,
    obs: params.get('view') === 'obs',
    viewOnly: bridgeUrl !== '',
    world: params.get('world'),
  }
}
