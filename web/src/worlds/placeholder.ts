/**
 * "Placeholder" world: flat ground seen from just behind the walker, drawn on a 2D canvas with
 * a simple pinhole projection. Grid lines, trees, posts and 100 m signposts move past at the
 * walking speed. No network, no Google tiles: the default for development.
 *
 * Coordinates: x metres to the right, z metres ahead of the camera, camera EYE_M above ground.
 * Scenery is placed at fixed route positions (seeded by slot), so it is the same on every
 * visit to the same distance.
 */

import type { World } from './world'

const EYE_M = 1.7
const FAR_M = 160
const GRID_M = 2
const PATH_HALF_WIDTH_M = 1.1
const SLOT_M = 7 // one scenery slot per 7 m of route per side

interface Thing {
  kind: 'tree' | 'bush' | 'post'
  x: number
  z: number // route position, metres
  size: number
  label?: string
}

/** Deterministic pseudo-random [0, 1) from an integer seed. */
export function hash01(n: number): number {
  let t = (n * 0x9e3779b1) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function sceneryAt(slot: number, side: -1 | 1): Thing | null {
  const seed = slot * 2 + (side > 0 ? 1 : 0)
  const r = hash01(seed)
  if (r < 0.15) return null
  const kind = r < 0.7 ? 'tree' : r < 0.9 ? 'bush' : 'post'
  const offset = kind === 'post' ? 2.2 : 3 + hash01(seed + 7919) * 14
  return {
    kind,
    x: side * offset,
    z: slot * SLOT_M + hash01(seed + 104729) * (SLOT_M - 1),
    size: 0.7 + hash01(seed + 15485863) * 0.8,
  }
}

export class PlaceholderWorld implements World {
  readonly showsWalker = true
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private resize = new ResizeObserver(() => this.fit())
  private w = 0
  private h = 0

  init(container: HTMLElement): void {
    const canvas = document.createElement('canvas')
    canvas.className = 'world-canvas'
    container.append(canvas)
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.resize.observe(container)
    this.fit()
  }

  private fit(): void {
    const canvas = this.canvas
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const rect = canvas.getBoundingClientRect()
    this.w = rect.width
    this.h = rect.height
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  update(distanceM: number): void {
    const ctx = this.ctx
    if (!ctx || this.w === 0) return
    const { w, h } = this
    const horizon = h * 0.42
    const f = h * 0.95 // focal length in px
    const cx = w / 2
    const px = (x: number, z: number) => cx + (f * x) / z
    const py = (y: number, z: number) => horizon + (f * (EYE_M - y)) / z
    const fog = (z: number) => Math.min(1, Math.max(0, (z - 20) / (FAR_M - 20)))

    // Sky and distant hills (at infinity: they do not move on a straight path).
    const sky = ctx.createLinearGradient(0, 0, 0, horizon)
    sky.addColorStop(0, '#1d3557')
    sky.addColorStop(1, '#8fb3c9')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, horizon + 1)
    ctx.fillStyle = '#5d7f86'
    ctx.beginPath()
    ctx.moveTo(0, horizon)
    for (let i = 0; i <= 24; i++) {
      const x = (i / 24) * w
      const bump = Math.sin(i * 1.7) * 0.5 + Math.sin(i * 0.63 + 1) * 0.5
      ctx.lineTo(x, horizon - h * (0.03 + 0.025 * bump))
    }
    ctx.lineTo(w, horizon)
    ctx.fill()

    // Ground and path.
    const ground = ctx.createLinearGradient(0, horizon, 0, h)
    ground.addColorStop(0, '#6f8f5f')
    ground.addColorStop(1, '#2f5a2c')
    ctx.fillStyle = ground
    ctx.fillRect(0, horizon, w, h - horizon)
    const near = 0.6
    ctx.fillStyle = '#9a8a6a'
    ctx.beginPath()
    ctx.moveTo(px(-PATH_HALF_WIDTH_M, near), py(0, near))
    ctx.lineTo(px(-PATH_HALF_WIDTH_M, FAR_M), py(0, FAR_M))
    ctx.lineTo(px(PATH_HALF_WIDTH_M, FAR_M), py(0, FAR_M))
    ctx.lineTo(px(PATH_HALF_WIDTH_M, near), py(0, near))
    ctx.fill()

    // Cross grid lines every GRID_M, moving towards the camera.
    const shift = distanceM % GRID_M
    for (let z = GRID_M - shift; z < FAR_M; z += GRID_M) {
      if (z < near) continue
      const y = py(0, z)
      ctx.strokeStyle = `rgba(255,255,255,${0.16 * (1 - fog(z))})`
      ctx.lineWidth = Math.max(0.5, 2.2 / Math.sqrt(z))
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    // Lines along the route (they converge at the vanishing point, so they look still).
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1
    for (const x of [-12, -6, -3, -PATH_HALF_WIDTH_M, PATH_HALF_WIDTH_M, 3, 6, 12]) {
      ctx.beginPath()
      ctx.moveTo(px(x, near), py(0, near))
      ctx.lineTo(px(x, FAR_M), py(0, FAR_M))
      ctx.stroke()
    }

    // Scenery, far to near.
    const things: Thing[] = []
    const first = Math.floor(distanceM / SLOT_M) - 1
    const last = Math.floor((distanceM + FAR_M) / SLOT_M) + 1
    for (let slot = first; slot <= last; slot++) {
      for (const side of [-1, 1] as const) {
        const t = sceneryAt(slot, side)
        if (t) things.push(t)
      }
    }
    // 100 m signposts on the right.
    for (let m = Math.ceil(distanceM / 100) * 100; m < distanceM + FAR_M; m += 100) {
      if (m > 0) things.push({ kind: 'post', x: 1.8, z: m, size: 1, label: `${m} m` })
    }
    things
      .map((t) => ({ ...t, rel: t.z - distanceM }))
      .filter((t) => t.rel > 0.8 && t.rel < FAR_M)
      .sort((a, b) => b.rel - a.rel)
      .forEach((t) => this.drawThing(ctx, t, t.rel, px, py, fog(t.rel)))
  }

  private drawThing(
    ctx: CanvasRenderingContext2D,
    t: Thing,
    z: number,
    px: (x: number, z: number) => number,
    py: (y: number, z: number) => number,
    fog: number,
  ): void {
    const base = py(0, z)
    const x = px(t.x, z)
    const scale = py(0, z) - py(1, z) // pixels per metre at this depth
    ctx.globalAlpha = 1 - fog * 0.85
    if (t.kind === 'tree') {
      const trunkH = 1.2 * t.size
      const crownH = 4.2 * t.size
      ctx.fillStyle = '#5b4030'
      ctx.fillRect(x - 0.12 * scale, base - trunkH * scale, 0.24 * scale, trunkH * scale)
      ctx.fillStyle = '#23512c'
      ctx.beginPath()
      ctx.moveTo(x, base - (trunkH + crownH) * scale)
      ctx.lineTo(x - 1.3 * t.size * scale, base - trunkH * 0.8 * scale)
      ctx.lineTo(x + 1.3 * t.size * scale, base - trunkH * 0.8 * scale)
      ctx.fill()
    } else if (t.kind === 'bush') {
      ctx.fillStyle = '#3e6b34'
      ctx.beginPath()
      ctx.ellipse(x, base - 0.35 * t.size * scale, 0.8 * t.size * scale, 0.45 * t.size * scale, 0, 0, Math.PI * 2)
      ctx.fill()
    } else {
      const postH = 1.1
      ctx.fillStyle = '#d9d2c3'
      ctx.fillRect(x - 0.05 * scale, base - postH * scale, 0.1 * scale, postH * scale)
      if (t.label) {
        const label = t.label
        const fontPx = Math.max(6, 0.28 * scale)
        ctx.font = `600 ${fontPx}px system-ui, sans-serif`
        const tw = ctx.measureText(label).width
        ctx.fillStyle = '#f4efe3'
        ctx.fillRect(x - tw / 2 - fontPx * 0.4, base - (postH + 0.45) * scale, tw + fontPx * 0.8, 0.45 * scale)
        ctx.fillStyle = '#20262e'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, x, base - (postH + 0.225) * scale)
      }
    }
    ctx.globalAlpha = 1
  }

  dispose(): void {
    this.resize.disconnect()
    this.canvas?.remove()
    this.canvas = null
    this.ctx = null
  }
}

/** Nothing but the walker: for OBS over another scene (the page background is transparent). */
export class OverlayWorld implements World {
  readonly showsWalker = true
  init(): void {}
  update(): void {}
  dispose(): void {}
}
