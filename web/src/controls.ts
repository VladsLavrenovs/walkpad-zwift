/**
 * Belt controls: start, a big always-visible STOP, -/+ 0.5 km/h, preset speeds.
 * Keyboard: Space or Esc = stop, arrow up/right = +0.5, arrow down/left = -0.5.
 * Shown only when the bridge says this page may control the belt; the bridge enforces the
 * cap and ramp either way, and answers with the target it actually applied.
 */

import type { BridgeClient, StatusMsg } from './bridge'
import { fmtSpeed } from './format'

export const STEP_KMH = 0.5
export const MIN_KMH = 0.5
const PRESETS_KMH = [1, 2, 3, 4, 5, 6]
const START_KEY = 'walkpad.startKmh'

/** Next target after a -/+ press: from the current target, in 0.5 steps, within [min, cap]. */
export function stepTarget(from: number, delta: number, cap: number): number {
  const next = Math.round((from + delta) / STEP_KMH) * STEP_KMH
  return Math.min(cap, Math.max(MIN_KMH, next))
}

export function presetsFor(cap: number): number[] {
  return PRESETS_KMH.filter((p) => p <= cap + 1e-9)
}

/** The belt is still getting to the target (show both numbers). */
export function isRamping(target: number | null, actual: number): boolean {
  return target !== null && Math.abs(target - actual) > 0.15
}

export type KeyAction = 'stop' | 'up' | 'down' | null

export function keyAction(e: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey'>): KeyAction {
  if (e.altKey || e.ctrlKey || e.metaKey) return null
  if (e.code === 'Space' || e.key === ' ' || e.key === 'Escape') return 'stop'
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') return 'up'
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') return 'down'
  return null
}

export class Controls {
  readonly el: HTMLDivElement
  private readonly stopBtn: HTMLButtonElement
  private readonly startBtn: HTMLButtonElement
  private readonly targetEl: HTMLDivElement
  private readonly presetsEl: HTMLDivElement
  private status: StatusMsg | null = null
  private actualKmh = 0
  private running = false
  private startKmh: number
  private busy = false
  private readonly bridge: BridgeClient
  private readonly toast: (msg: string) => void

  constructor(parent: HTMLElement, bridge: BridgeClient, toast: (msg: string) => void) {
    this.bridge = bridge
    this.toast = toast
    this.startKmh = Number(safeGet(START_KEY)) || 2
    this.el = document.createElement('div')
    this.el.className = 'controls'
    this.el.innerHTML = `
      <button class="stop" type="button" title="Stop (Space or Esc)">STOP</button>
      <div class="panel">
        <div class="target" aria-live="polite"></div>
        <div class="row">
          <button class="minus" type="button" title="-0.5 km/h (arrow down)">−</button>
          <button class="start" type="button"></button>
          <button class="plus" type="button" title="+0.5 km/h (arrow up)">+</button>
        </div>
        <div class="presets"></div>
      </div>`
    this.stopBtn = this.el.querySelector('.stop')!
    this.startBtn = this.el.querySelector('.start')!
    this.targetEl = this.el.querySelector('.target')!
    this.presetsEl = this.el.querySelector('.presets')!
    this.stopBtn.onclick = () => void this.stop()
    this.startBtn.onclick = () => void this.startOrApply(this.startKmh)
    this.el.querySelector<HTMLButtonElement>('.minus')!.onclick = () => void this.nudge(-STEP_KMH)
    this.el.querySelector<HTMLButtonElement>('.plus')!.onclick = () => void this.nudge(STEP_KMH)
    window.addEventListener('keydown', this.onKey)
    parent.append(this.el)
    this.render()
  }

  set visible(on: boolean) {
    this.el.hidden = !on
  }

  onStatus(status: StatusMsg): void {
    this.status = status
    this.render()
  }

  onSample(speedKmh: number, running: boolean): void {
    this.actualKmh = speedKmh
    this.running = running
    this.render()
  }

  private get cap(): number {
    return this.status?.cap_kmh ?? 6
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.el.hidden) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    const action = keyAction(e)
    if (!action) return
    e.preventDefault()
    if (action === 'stop') void this.stop()
    else void this.nudge(action === 'up' ? STEP_KMH : -STEP_KMH)
  }

  private async run(what: () => Promise<StatusMsg>): Promise<void> {
    try {
      const status = await what()
      this.status = { ...(this.status ?? status), ...status }
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err))
    } finally {
      this.render()
    }
  }

  async stop(): Promise<void> {
    // Never blocked by `busy`: stop always goes out.
    await this.run(() => this.bridge.stop())
  }

  private async startOrApply(kmh: number): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      if (this.running) await this.run(() => this.bridge.setSpeed(kmh))
      else await this.run(() => this.bridge.start(kmh))
    } finally {
      this.busy = false
    }
  }

  private async nudge(delta: number): Promise<void> {
    if (!this.running) {
      this.startKmh = stepTarget(this.startKmh, delta, this.cap)
      safeSet(START_KEY, String(this.startKmh))
      this.render()
      return
    }
    const from = this.status?.target_kmh ?? this.actualKmh
    await this.startOrApply(stepTarget(from, delta, this.cap))
  }

  private render(): void {
    const s = this.status
    const padOk = s?.connected ?? false
    const target = s?.target_kmh ?? null
    const starting = this.running && this.actualKmh === 0
    this.startBtn.disabled = !padOk || this.running
    this.startBtn.textContent = `Start ${fmtSpeed(this.startKmh)}`
    this.stopBtn.disabled = !padOk
    if (!padOk) this.targetEl.textContent = 'Pad not connected'
    else if (starting) this.targetEl.textContent = 'Starting…'
    else if (this.running && isRamping(target, this.actualKmh))
      this.targetEl.innerHTML = `target <b>${fmtSpeed(target!)}</b> · belt ${fmtSpeed(this.actualKmh)}`
    else if (this.running) this.targetEl.textContent = `at ${fmtSpeed(target ?? this.actualKmh)} km/h`
    else this.targetEl.textContent = `cap ${fmtSpeed(this.cap)} km/h`
    const presets = presetsFor(this.cap)
    if (this.presetsEl.childElementCount !== presets.length) {
      this.presetsEl.replaceChildren(
        ...presets.map((p) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = fmtSpeed(p)
          b.onclick = () => void this.startOrApply(p)
          return b
        }),
      )
    }
    this.presetsEl.querySelectorAll('button').forEach((b) => (b.disabled = !padOk))
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey)
    this.el.remove()
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}
