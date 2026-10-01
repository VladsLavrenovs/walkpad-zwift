/**
 * The open world's ground at metre scale, from a (saved) continent: the 20 m grid, smoothly
 * interpolated, plus fine detail, river channels carved into it, flat ground in towns, roads,
 * and the water over it. Pure functions of the continent (and its seed for the detail noise), so
 * terrain tiles, plants, buildings and the walker all agree, and neighbouring tiles share edges.
 */

import { fbm } from '../fantasy/gen'
import { type Continent, Water, biomeWeightsAt, cellAt, sample } from './continent'
import { RIVER_FLOW } from './continent/hydro'

const BUCKET_M = 64

/** Segments of polylines in a coarse grid, for "how far is the nearest road / river". */
export class SegmentIndex {
  private readonly buckets = new Map<number, number[]>()
  private readonly seg: Float64Array // x0, z0, x1, z1, halfWidth
  readonly count: number

  constructor(lines: { points: [number, number][]; halfWidth: (i: number) => number }[]) {
    const segs: number[] = []
    for (const line of lines) {
      for (let i = 0; i + 1 < line.points.length; i++) {
        const [x0, z0] = line.points[i]
        const [x1, z1] = line.points[i + 1]
        segs.push(x0, z0, x1, z1, line.halfWidth(i))
      }
    }
    this.seg = Float64Array.from(segs)
    this.count = segs.length / 5
    for (let k = 0; k < this.count; k++) {
      const o = k * 5
      const pad = this.seg[o + 4] + 8
      const bx0 = Math.floor((Math.min(this.seg[o], this.seg[o + 2]) - pad) / BUCKET_M)
      const bx1 = Math.floor((Math.max(this.seg[o], this.seg[o + 2]) + pad) / BUCKET_M)
      const bz0 = Math.floor((Math.min(this.seg[o + 1], this.seg[o + 3]) - pad) / BUCKET_M)
      const bz1 = Math.floor((Math.max(this.seg[o + 1], this.seg[o + 3]) + pad) / BUCKET_M)
      for (let bz = bz0; bz <= bz1; bz++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const key = bz * 4096 + bx
          const list = this.buckets.get(key)
          if (list) list.push(k)
          else this.buckets.set(key, [k])
        }
      }
    }
  }

  /** Distance from (x, z) to the nearest segment's edge (negative inside it), and the segment. */
  nearest(x: number, z: number): { edge: number; centre: number; halfWidth: number; seg: number } {
    const list = this.buckets.get(Math.floor(z / BUCKET_M) * 4096 + Math.floor(x / BUCKET_M))
    let best = { edge: Infinity, centre: Infinity, halfWidth: 0, seg: -1 }
    if (!list) return best
    for (const k of list) {
      const o = k * 5
      const ax = this.seg[o]
      const az = this.seg[o + 1]
      const dx = this.seg[o + 2] - ax
      const dz = this.seg[o + 3] - az
      const len2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2))
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t))
      const edge = d - this.seg[o + 4]
      if (edge < best.edge) best = { edge, centre: d, halfWidth: this.seg[o + 4], seg: k }
    }
    return best
  }

  /** Direction of segment `k` (radians, 0 = +z). */
  heading(k: number): number {
    const o = k * 5
    return Math.atan2(this.seg[o + 2] - this.seg[o], this.seg[o + 3] - this.seg[o + 1])
  }
}

export const ROAD_HALF_M = 1.7
const BANK_M = 5
const CARVE_M = 1.5

/** A town's flat ground: its centre, radius and ground height. */
export interface TownPad {
  x: number
  z: number
  radius: number
  height: number
}

export function riverHalfWidth(flow: number): number {
  return Math.min(9, 1.6 + Math.sqrt(flow / RIVER_FLOW) * 1.3)
}

export class Ground {
  readonly c: Continent
  readonly roads: SegmentIndex
  readonly rivers: SegmentIndex
  readonly towns: TownPad[]

  constructor(c: Continent) {
    this.c = c
    this.roads = new SegmentIndex(c.roads.map((r) => ({ points: r.points, halfWidth: () => ROAD_HALF_M })))
    this.rivers = new SegmentIndex(c.rivers.map((r) => ({ points: r.points, halfWidth: (i) => riverHalfWidth(r.flow[i]) })))
    this.towns = c.places
      .filter((p) => p.kind === 'city' || p.kind === 'village' || p.kind === 'castle')
      .map((p) => ({ x: p.x, z: p.z, radius: p.kind === 'city' ? 150 : p.kind === 'castle' ? 70 : 95, height: Math.max(0.6, sample(c, c.height, p.x, p.z)) }))
  }

  /** The grid's ground, smooth, without detail. */
  base(x: number, z: number): number {
    return sample(this.c, this.c.height, x, z)
  }

  /** How much of a town is here (1 in the middle, 0 outside). */
  town(x: number, z: number): { weight: number; pad: TownPad | null } {
    let best = 0
    let pad: TownPad | null = null
    for (const t of this.towns) {
      const d = Math.hypot(x - t.x, z - t.z)
      if (d > t.radius + 40) continue
      const w = 1 - smooth((d - t.radius) / 40)
      if (w > best) {
        best = w
        pad = t
      }
    }
    return { weight: best, pad }
  }

  /** Ground height at any point (metres). */
  height(x: number, z: number): number {
    let h = this.base(x, z)
    if (h <= -2) return h
    const road = this.roads.nearest(x, z)
    const river = this.rivers.nearest(x, z)
    const { weight: townW, pad } = this.town(x, z)
    // Fine detail, calmed on roads, by water and in towns.
    const calm = Math.max(1 - smooth(road.edge / 6), townW, 1 - smooth((river.edge + 2) / 8))
    const detail = fbm(this.c.seed + 201, x / 23, z / 23, 3) * 1.4 + fbm(this.c.seed + 202, x / 6.5, z / 6.5, 2) * 0.3
    h += detail * (1 - calm) * smooth(h / 2)
    // Towns sit on level ground.
    if (pad) h += (pad.height - h) * townW
    // River channels: banks sloping down to the bed.
    if (river.edge < BANK_M) h -= CARVE_M * (1 - smooth(river.edge / BANK_M))
    return h
  }

  /** Water surface over (x, z), or null for dry land. Sea at 0, lakes flat, rivers shallow. */
  water(x: number, z: number, ground = this.height(x, z)): { kind: 'sea' | 'lake' | 'river'; level: number } | null {
    const cell = cellAt(this.c, x, z)
    const w = this.c.water[cell]
    if (ground < 0 && (w === Water.Sea || this.base(x, z) < 0)) return { kind: 'sea', level: 0 }
    if (w === Water.Lake || nearCell(this.c, cell, Water.Lake)) {
      const level = lakeLevel(this.c, cell)
      if (level !== null && ground < level) return { kind: 'lake', level }
    }
    const river = this.rivers.nearest(x, z)
    if (river.edge < 0) {
      const level = this.base(x, z) - CARVE_M + 0.55
      if (ground < level) return { kind: 'river', level }
    }
    return null
  }

  /** Cobbles (1) in towns, dirt elsewhere, 0 off the road; with a soft edge. */
  road(x: number, z: number): { onRoad: number; cobble: number } {
    const r = this.roads.nearest(x, z)
    const onRoad = 1 - smooth((r.edge + 0.4) / 1.2)
    return { onRoad, cobble: onRoad * this.town(x, z).weight }
  }

  biomes(x: number, z: number) {
    return biomeWeightsAt(this.c, x, z)
  }
}

function nearCell(c: Continent, cell: number, kind: number): boolean {
  const n = c.n
  for (const d of [-1, 1, -n, n, -n - 1, -n + 1, n - 1, n + 1]) {
    const k = cell + d
    if (k >= 0 && k < n * n && c.water[k] === kind) return true
  }
  return false
}

/** The level of the lake at or next to `cell` (lakes are flat). */
export function lakeLevel(c: Continent, cell: number): number | null {
  if (c.water[cell] === Water.Lake) return c.surface[cell]
  const n = c.n
  for (const d of [-1, 1, -n, n, -n - 1, -n + 1, n - 1, n + 1]) {
    const k = cell + d
    if (k >= 0 && k < n * n && c.water[k] === Water.Lake) return c.surface[k]
  }
  return null
}

export function smooth(t: number): number {
  const v = t < 0 ? 0 : t > 1 ? 1 : t
  return v * v * (3 - 2 * v)
}
