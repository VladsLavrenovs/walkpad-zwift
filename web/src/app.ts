/**
 * The walking view: world (pluggable) + walker + HUD + controls, driven by the bridge's live
 * WebSocket, rendered every animation frame. The stats page lives at #/stats.
 */

import {
  BridgeClient,
  type BridgeMsg,
  clientId,
  type LinkState,
  type SafetyMsg,
  type StatusMsg,
} from './bridge'
import type { AppConfig } from './config'
import { Controls } from './controls'
import { fmtDistance, fmtDuration, fmtSpeed } from './format'
import { Motion } from './motion'
import { StatsPage } from './stats'
import { Walker } from './walker'
import { WORLDS, findWorld } from './worlds'
import type { World } from './worlds/world'

const WORLD_KEY = 'walkpad.world'

export class App {
  private readonly root: HTMLElement
  private readonly worldEl: HTMLDivElement
  private readonly motion = new Motion()
  private readonly bridge: BridgeClient
  private readonly walker: Walker
  private readonly controls: Controls | null
  private readonly stats: StatsPage | null
  private world: World | null = null
  private worldId = ''
  private status: StatusMsg | null = null
  private link: LinkState = 'connecting'
  private controlAllowed = false
  private aboveCap: SafetyMsg | null = null
  private last = performance.now()
  private readonly hud: Record<'speed' | 'target' | 'distance' | 'time' | 'steps', HTMLElement>
  private readonly pill: HTMLElement
  private readonly banner: HTMLElement
  private readonly badge: HTMLElement
  private readonly toastEl: HTMLElement
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private readonly config: AppConfig

  constructor(root: HTMLElement, config: AppConfig) {
    this.config = config
    this.root = root
    root.classList.toggle('obs', config.obs)
    document.documentElement.classList.toggle('obs', config.obs)
    root.innerHTML = `
      <div class="world"></div>
      <div class="hud" aria-live="off">
        <div class="metric speed"><span class="value">0.0</span><span class="unit">km/h</span>
          <span class="target"></span></div>
        <div class="metric"><span class="value distance">0 m</span><span class="unit">distance</span></div>
        <div class="metric"><span class="value time">0:00</span><span class="unit">time</span></div>
        <div class="metric"><span class="value steps">—</span><span class="unit">steps</span></div>
      </div>
      <div class="topbar">
        <span class="pill" role="status"></span>
        <span class="badge" hidden>view only</span>
        <span class="spacer"></span>
        <label class="world-menu">World <select></select></label>
        <a class="link" href="#/stats">Stats</a>
      </div>
      <div class="banner" role="alert" hidden></div>
      <div class="toast" role="status" hidden></div>`
    const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
    this.worldEl = q('.world')
    this.hud = {
      speed: q('.speed .value'),
      target: q('.speed .target'),
      distance: q('.distance'),
      time: q('.time'),
      steps: q('.steps'),
    }
    this.pill = q('.pill')
    this.badge = q('.badge')
    this.banner = q('.banner')
    this.toastEl = q('.toast')

    // OBS pages never control the belt, so they connect without a client id.
    this.bridge = new BridgeClient(config.bridgeUrl, config.obs ? null : clientId(safeStorage()), {
      onMessage: (m) => this.onMessage(m),
      onLink: (s) => this.onLink(s),
    })
    this.walker = new Walker(root)
    this.controls = config.obs ? null : new Controls(root, this.bridge, (m) => this.toast(m))
    this.stats = config.obs ? null : new StatsPage(root, this.bridge)
    if (this.controls) this.controls.visible = false

    const select = q<HTMLSelectElement>('.world-menu select')
    select.replaceChildren(...WORLDS.map((w) => new Option(w.name, w.id)))
    const saved = config.obs ? null : safeStorage()?.getItem(WORLD_KEY)
    const initial =
      findWorld(config.world) ?? findWorld(saved ?? null) ?? (config.obs ? findWorld('overlay') : WORLDS[0])
    select.value = initial!.id
    select.onchange = () => void this.setWorld(select.value)
    void this.setWorld(initial!.id)

    window.addEventListener('hashchange', () => this.route())
    this.route()
    this.renderStatus()
    this.bridge.connect()
    requestAnimationFrame(this.frame)
  }

  private async setWorld(id: string): Promise<void> {
    const info = findWorld(id) ?? WORLDS[0]
    if (info.id === this.worldId) return
    this.world?.dispose()
    this.worldId = info.id
    const world = info.create()
    this.world = world
    await world.init(this.worldEl)
    this.walker.visible = world.showsWalker
    if (!this.config.obs) {
      try {
        safeStorage()?.setItem(WORLD_KEY, info.id)
      } catch {
        /* ignore */
      }
    }
  }

  private route(): void {
    const onStats = location.hash === '#/stats' && this.stats !== null
    this.root.classList.toggle('on-stats', onStats)
    if (onStats) void this.stats!.show()
    else this.stats?.hide()
  }

  private readonly frame = (now: number): void => {
    const dt = (now - this.last) / 1000
    this.last = now
    const m = this.motion
    m.frame(dt)
    this.world?.update(m.odometerM, m.speedKmh, dt)
    this.walker.update(m.cadence(), m.speedKmh, dt)
    this.hud.speed.textContent = fmtSpeed(m.speedKmh)
    this.hud.distance.textContent = fmtDistance(m.distanceM)
    this.hud.time.textContent = fmtDuration(m.elapsedS)
    this.hud.steps.textContent = m.steps === null ? '—' : m.steps.toLocaleString()
    requestAnimationFrame(this.frame)
  }

  private onMessage(msg: BridgeMsg): void {
    if (msg.type === 'sample') {
      this.motion.onSample(msg)
      this.controls?.onSample(msg.speed_kmh, msg.belt === 'running')
      this.renderTarget(msg.speed_kmh)
    } else if (msg.type === 'status') {
      this.status = { ...msg, control_allowed: this.status?.control_allowed }
      this.motion.setProtocol(msg.protocol)
      if (!msg.connected) this.motion.onDisconnect()
      this.controls?.onStatus(this.status)
      this.renderStatus()
    } else if (msg.type === 'safety') {
      this.onSafety(msg)
    }
  }

  private onLink(state: LinkState): void {
    this.link = state
    if (state !== 'live') this.motion.onDisconnect()
    if (state === 'live' && !this.config.obs) {
      // control_allowed depends on who is asking, so it comes from GET /status.
      this.bridge
        .status()
        .then((s) => {
          this.controlAllowed = s.control_allowed === true
          this.status = { ...(this.status ?? s), control_allowed: this.controlAllowed }
          this.renderStatus()
        })
        .catch(() => {
          this.controlAllowed = false
          this.renderStatus()
        })
    }
    this.renderStatus()
  }

  private onSafety(msg: SafetyMsg): void {
    if (msg.kind === 'belt_above_cap') this.aboveCap = msg
    else if (msg.kind === 'belt_within_cap') this.aboveCap = null
    else {
      this.aboveCap = null
      this.toast(`Safety stop: ${msg.message}`, 10000)
    }
    this.renderBanner()
  }

  private renderTarget(actual: number): void {
    const target = this.status?.target_kmh ?? null
    const show = target !== null && Math.abs(target - actual) > 0.15
    this.hud.target.textContent = show ? `→ ${fmtSpeed(target)}` : ''
  }

  private renderStatus(): void {
    const s = this.status
    let text: string
    let kind: string
    if (this.link === 'connecting') [text, kind] = ['Connecting to bridge…', 'wait']
    else if (this.link === 'offline') [text, kind] = ['Bridge offline — retrying', 'bad']
    else if (!s?.connected) [text, kind] = ['Pad not connected', 'warn']
    else [text, kind] = [`Live · ${s.protocol ?? 'pad'}`, 'good']
    this.pill.textContent = text
    this.pill.dataset.kind = kind
    this.pill.title = s?.error ?? ''
    const live = this.link === 'live'
    this.badge.hidden = this.config.obs || !live || this.controlAllowed
    if (this.controls) this.controls.visible = live && this.controlAllowed
    this.renderBanner()
  }

  private renderBanner(): void {
    const msg = this.aboveCap
    this.banner.hidden = msg === null
    if (msg)
      this.banner.textContent = `⚠ Belt at ${fmtSpeed(msg.speed_kmh)} km/h is above the ${fmtSpeed(msg.cap_kmh)} km/h cap`
  }

  private toast(message: string, ms = 4000): void {
    this.toastEl.textContent = message
    this.toastEl.hidden = false
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), ms)
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
