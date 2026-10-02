/** Talks to the WalkPad bridge: the /live WebSocket (auto-reconnecting) and the HTTP API. */

import { bridgeWsUrl } from './config'

export type Belt = 'stopped' | 'running' | 'stopping'

export interface SampleMsg {
  type: 'sample'
  t: number
  speed_kmh: number
  distance_m: number
  steps: number | null
  elapsed_s: number
  belt: Belt
  session_id: number | null
  /** Distance along the active route (persists across sessions), or null. */
  route_id: number | null
  route_progress_m: number | null
}

export interface RouteSummary {
  id: number
  name: string
  source?: 'gpx' | 'ors' | 'trail'
  /** Trails: the fantasy world's seed. */
  seed?: number | null
  /** Trails: the biome the fantasy world starts in (null: the forest). */
  start_biome?: string | null
  distance_m: number
  progress_m: number
  completed_at: number | null
}

/** An open-world saved world (the snapshot itself is fetched separately). */
export interface SavedWorld {
  id: number
  name: string
  seed: number
  gen_version: number
  /** Snapshot size in bytes. */
  size: number
  active: boolean
  created_at: number
  /** Where the player is (null: not started there yet). */
  x: number | null
  z: number | null
  heading: number | null
  walked_m: number
  played_at: number | null
}

/** One achievement and how far along it is. */
export interface Achievement {
  id: string
  title: string
  description: string
  xp: number
  metric: string
  target: number
  progress: number
  unlocked_at: number | null
}

/** The walker (one character across all worlds). */
export interface GameProfile {
  xp: number
  level: number
  level_start_xp: number
  next_level_xp: number
  breakdown: { walking: number; discoveries: number; achievements: number }
  metrics: Record<string, number>
  achievements: Achievement[]
}

export type DiscoveryKind = 'place' | 'province' | 'biome'

export interface Discovery {
  world_id: number
  kind: DiscoveryKind
  key: string
  xp: number
  found_at: number
}

export interface Route extends RouteSummary {
  source: 'gpx' | 'ors' | 'trail'
  active: boolean
  created_at: number
  last_walked_at: number | null
  /** Only from GET /routes/{id}: [[lat, lon], ...] */
  points?: [number, number][]
}

export interface StatusMsg {
  type: 'status'
  connected: boolean
  protocol: string | null
  belt: Belt | null
  speed_kmh: number | null
  cap_kmh: number
  target_kmh: number | null
  controlling_client: string | null
  session_id: number | null
  route: RouteSummary | null
  error: string | null
  /** Only on GET /status: whether this page may control the belt. */
  control_allowed?: boolean
  /** Only on control responses: the target after the cap. */
  applied_target_kmh?: number
}

export interface SafetyMsg {
  type: 'safety'
  kind: 'belt_above_cap' | 'belt_within_cap' | 'failsafe_stop'
  message: string
  speed_kmh: number
  cap_kmh: number
}

export type BridgeMsg = SampleMsg | StatusMsg | SafetyMsg

/** 'connecting' until the socket opens; 'offline' while retrying. */
export type LinkState = 'connecting' | 'live' | 'offline'

export interface Session {
  id: number
  started_at: number
  ended_at: number | null
  duration_s: number
  distance_m: number
  steps: number | null
  max_speed_kmh: number
  avg_speed_kmh: number
  protocol: string | null
}

export interface PeriodTotals {
  sessions: number
  distance_m: number
  duration_s: number
  steps: number
}

export interface Best {
  session_id?: number
  value: number
  date: string
}

export interface Stats {
  today: string
  daily: (PeriodTotals & { date: string })[]
  weekly: (PeriodTotals & { week_start: string })[]
  monthly: (PeriodTotals & { month: string })[]
  streaks: { current_days: number; longest_days: number; walked_today: boolean; active_day_min_s: number }
  personal_bests: {
    longest_distance_m: Best | null
    longest_duration_s: Best | null
    most_steps: Best | null
    fastest_avg_speed_kmh: Best | null
    best_day_distance_m: Best | null
  }
  all_time: PeriodTotals
}

export interface Video {
  id: number
  video_id: string
  url: string
  title: string
  pace_kmh: number
  position_s: number
  created_at: number
  last_played_at: number | null
}

export interface Tiles3dUsage {
  day: string
  month: string
  today: number
  this_month: number
  per_day: number
  per_month: number
}

export class ControlError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const CLIENT_ID_KEY = 'walkpad.clientId'

/** One id per browser, kept across reloads: a page refresh is "the same client coming back"
 * within the bridge's grace period, so the belt keeps running. */
export function clientId(storage: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  let id = null
  try {
    id = storage?.getItem(CLIENT_ID_KEY) ?? null
  } catch {
    /* storage blocked: a fresh id per load still works, just without refresh grace */
  }
  if (!id || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
    id = `web-${Math.random().toString(36).slice(2, 12)}`
    try {
      storage?.setItem(CLIENT_ID_KEY, id)
    } catch {
      /* ignore */
    }
  }
  return id
}

export interface BridgeHandlers {
  onMessage(msg: BridgeMsg): void
  onLink(state: LinkState): void
}

export class BridgeClient {
  private ws: WebSocket | null = null
  private retryMs = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  readonly baseUrl: string
  /** null: connect anonymously (view-only pages such as OBS). */
  readonly client: string | null
  private readonly handlers: BridgeHandlers
  private readonly origin: string

  constructor(baseUrl: string, client: string | null, handlers: BridgeHandlers, origin = window.location.origin) {
    this.baseUrl = baseUrl
    this.client = client
    this.handlers = handlers
    this.origin = origin
  }

  connect(): void {
    this.closed = false
    this.handlers.onLink('connecting')
    const query = this.client ? `?client=${encodeURIComponent(this.client)}` : ''
    const ws = new WebSocket(bridgeWsUrl(this.baseUrl, `/live${query}`, this.origin))
    this.ws = ws
    ws.onopen = () => {
      this.retryMs = 1000
      this.handlers.onLink('live')
    }
    ws.onmessage = (event) => {
      try {
        this.handlers.onMessage(JSON.parse(event.data as string) as BridgeMsg)
      } catch (err) {
        console.warn('bad message from bridge', err)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.closed) return
      this.handlers.onLink('offline')
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 5000)
    }
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
  }

  // --- HTTP ------------------------------------------------------------------------------

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  async get<T>(path: string): Promise<T> {
    // A plain GET (no custom headers: no CORS preflight, which Cloudflare Access would refuse),
    // with cookies: the Access cookie when the bridge is on another hostname.
    const res = await fetch(this.url(path), { credentials: 'include' })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return (await res.json()) as T
  }

  status(): Promise<StatusMsg> {
    return this.get<StatusMsg>('/status')
  }

  sessions(limit = 50): Promise<{ total: number; sessions: Session[] }> {
    return this.get(`/sessions?limit=${limit}`)
  }

  stats(): Promise<Stats> {
    return this.get<Stats>('/stats')
  }

  private async control(path: string, body?: { kmh: number }): Promise<StatusMsg> {
    if (!this.client) throw new ControlError('view only', 403)
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': this.client },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = (await res.json().catch(() => ({}))) as StatusMsg & { detail?: unknown }
    if (!res.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`
      throw new ControlError(detail, res.status)
    }
    return data
  }

  // --- video library (writes are local-only on the bridge, like control) -------------------

  async videos(): Promise<Video[]> {
    return (await this.get<{ videos: Video[] }>('/videos')).videos
  }

  private async write<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
    if (!this.client) throw new ControlError('view only', 403)
    const res = await fetch(this.url(path), {
      method,
      keepalive, // lets a last position update finish while the page unloads
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': this.client },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 405 || (res.status === 404 && method === 'POST')) {
      // The endpoint does not exist: this page is newer than the running bridge.
      throw new ControlError('The bridge is older than this page. Restart it: ./scripts/update.sh --restart', res.status)
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: unknown }
      const detail = typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? 'invalid input' : `HTTP ${res.status}`
      throw new ControlError(detail, res.status)
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  addVideo(url: string, paceKmh?: number): Promise<Video> {
    return this.write('POST', '/videos', paceKmh === undefined ? { url } : { url, pace_kmh: paceKmh })
  }

  updateVideo(id: number, fields: Partial<Pick<Video, 'title' | 'pace_kmh' | 'position_s'>>, keepalive = false): Promise<Video> {
    return this.write('PATCH', `/videos/${id}`, fields, keepalive)
  }

  deleteVideo(id: number): Promise<void> {
    return this.write('DELETE', `/videos/${id}`)
  }

  // --- Google 3D tiles cost guard -----------------------------------------------------------

  /** Ask the bridge before creating a Google 3D tiles session (each one costs money). */
  async request3dSession(): Promise<{ granted: boolean; message: string; usage: Tiles3dUsage | null }> {
    const res = await fetch(this.url('/tiles3d/session'), {
      method: 'POST',
      headers: this.client ? { 'X-Client-Id': this.client } : {},
    })
    const data = (await res.json().catch(() => ({}))) as { granted?: boolean; detail?: string; usage?: Tiles3dUsage }
    if (res.ok && data.granted) return { granted: true, message: 'granted', usage: data.usage ?? null }
    return { granted: false, message: data.detail ?? `3D world unavailable (HTTP ${res.status})`, usage: data.usage ?? null }
  }

  tiles3dUsage(): Promise<Tiles3dUsage> {
    return this.get<Tiles3dUsage>('/tiles3d/usage')
  }

  // --- routes -------------------------------------------------------------------------------

  async routes(): Promise<Route[]> {
    return (await this.get<{ routes: Route[] }>('/routes')).routes
  }

  route(id: number): Promise<Route> {
    return this.get<Route>(`/routes/${id}`)
  }

  async importGpx(file: File, name = ''): Promise<Route> {
    if (!this.client) throw new ControlError('view only', 403)
    const res = await fetch(this.url(`/routes/gpx?name=${encodeURIComponent(name)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/gpx+xml', 'X-Client-Id': this.client },
      body: file,
    })
    const data = (await res.json().catch(() => ({}))) as Route & { detail?: unknown }
    if (!res.ok) throw new ControlError(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`, res.status)
    return data
  }

  // --- open world: saved worlds (reading is open; changes are local-only) ------------------

  async worlds(): Promise<SavedWorld[]> {
    return (await this.get<{ worlds: SavedWorld[] }>('/worlds')).worlds
  }

  /** A saved world's snapshot (gzip bytes, see openworld/continent/snapshot.ts). */
  async worldSnapshot(id: number): Promise<Uint8Array> {
    const res = await fetch(this.url(`/worlds/${id}/snapshot`), { credentials: 'include' })
    if (!res.ok) throw new Error(`world ${id}: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async saveWorld(name: string, seed: number, genVersion: number, snapshot: Uint8Array): Promise<SavedWorld> {
    if (!this.client) throw new ControlError('view only', 403)
    const query = `name=${encodeURIComponent(name)}&seed=${seed}&gen_version=${genVersion}`
    const res = await fetch(this.url(`/worlds?${query}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Client-Id': this.client },
      body: snapshot as BodyInit,
    })
    if (res.status === 405 || res.status === 404) {
      throw new ControlError('The bridge is older than this page. Restart it: ./scripts/update.sh --restart', res.status)
    }
    const data = (await res.json().catch(() => ({}))) as SavedWorld & { detail?: unknown }
    if (!res.ok) throw new ControlError(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`, res.status)
    return data
  }

  renameWorld(id: number, name: string): Promise<SavedWorld> {
    return this.write('PATCH', `/worlds/${id}`, { name })
  }

  async setActiveWorld(id: number | null): Promise<SavedWorld[]> {
    return (await this.write<{ worlds: SavedWorld[] }>('PUT', '/worlds/active', { id })).worlds
  }

  deleteWorld(id: number): Promise<void> {
    return this.write('DELETE', `/worlds/${id}`)
  }

  gameProfile(): Promise<GameProfile> {
    return this.get('/game/profile')
  }

  async discoveries(worldId: number): Promise<Discovery[]> {
    return (await this.get<{ discoveries: Discovery[] }>(`/worlds/${worldId}/discoveries`)).discoveries
  }

  /** First visits in a world; the bridge gives XP for the new ones. */
  addDiscoveries(worldId: number, items: { kind: DiscoveryKind; key: string }[]): Promise<{ new: Discovery[]; profile: GameProfile }> {
    return this.write('POST', `/worlds/${worldId}/discoveries`, { items })
  }

  setWorldState(id: number, state: { x: number; z: number; heading: number; walked_m: number }, keepalive = false): Promise<SavedWorld> {
    return this.write('PUT', `/worlds/${id}/state`, state, keepalive)
  }

  planRoute(waypoints: [number, number][]): Promise<{ points: [number, number][]; distance_m: number }> {
    return this.write('POST', '/routes/plan', { waypoints })
  }

  createTrail(name: string, lengthM: number, seed?: number, startBiome?: string): Promise<Route> {
    return this.write('POST', '/routes/trail', {
      name, length_m: lengthM, ...(seed === undefined ? {} : { seed }), ...(startBiome ? { start_biome: startBiome } : {}),
    })
  }

  saveRoute(name: string, points: [number, number][]): Promise<Route> {
    return this.write('POST', '/routes', { name, points, source: 'ors' })
  }

  /** Rename, set progress, or give a trail a new look (seed, starting biome). */
  updateRoute(id: number, fields: { name?: string; progress_m?: number; seed?: number; start_biome?: string }): Promise<Route> {
    return this.write('PATCH', `/routes/${id}`, fields)
  }

  setActiveRoute(id: number | null): Promise<{ route: RouteSummary | null }> {
    return this.write('PUT', '/routes/active', { id })
  }

  deleteRoute(id: number): Promise<void> {
    return this.write('DELETE', `/routes/${id}`)
  }

  start(kmh: number): Promise<StatusMsg> {
    return this.control('/control/start', { kmh })
  }

  setSpeed(kmh: number): Promise<StatusMsg> {
    return this.control('/control/speed', { kmh })
  }

  stop(): Promise<StatusMsg> {
    return this.control('/control/stop')
  }
}
