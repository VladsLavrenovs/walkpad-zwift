/**
 * Procedural generation for the fantasy world, pure (no three.js), so it is deterministic and
 * testable: the same seed always gives the same trail, biomes, weather and props.
 *
 * Coordinates: metres on the ground plane, x to the right of the start, z forward at the start.
 * `s` is the distance along the trail.
 */

// --- seeded randomness --------------------------------------------------------------------------

/** 32-bit integer hash of any number of integers. */
export function hashInts(...values: number[]): number {
  let h = 0x811c9dc5
  for (const v of values) {
    h ^= v | 0
    h = Math.imul(h, 0x01000193)
    h ^= h >>> 15
    h = Math.imul(h, 0x2c1b3c6d)
    h ^= h >>> 12
  }
  return h >>> 0
}

/** Mulberry32: small, fast, good enough for scenery. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth 2D value noise in about [-1, 1], seeded. */
export function noise2(seed: number, x: number, z: number): number {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const fx = x - xi
  const fz = z - zi
  const corner = (dx: number, dz: number) => (hashInts(seed, xi + dx, zi + dz) / 4294967296) * 2 - 1
  const sx = fx * fx * (3 - 2 * fx)
  const sz = fz * fz * (3 - 2 * fz)
  const top = corner(0, 0) + (corner(1, 0) - corner(0, 0)) * sx
  const bottom = corner(0, 1) + (corner(1, 1) - corner(0, 1)) * sx
  return top + (bottom - top) * sz
}

/** Fractal noise: a few octaves of `noise2`, about [-1, 1]. */
export function fbm(seed: number, x: number, z: number, octaves = 3): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(seed + i * 1013, x * freq, z * freq)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

// --- the winding path ---------------------------------------------------------------------------

export interface Pose {
  x: number
  z: number
  /** Direction of travel, radians: 0 = +z, positive turns towards +x. */
  heading: number
}

const PATH_STEP_M = 1

/**
 * A gently winding path: the heading is a sum of slow seeded sine waves (at most ~35 degrees off
 * the main direction, so it never loops back), integrated in 1 m steps and cached.
 */
export class TrailPath {
  readonly seed: number
  private readonly waves: { amp: number; len: number; phase: number }[]
  private xs: number[] = [0]
  private zs: number[] = [0]

  constructor(seed: number) {
    this.seed = seed
    const r = rng(hashInts(seed, 1))
    this.waves = [
      { amp: 0.32, len: 420 + r() * 260, phase: r() * Math.PI * 2 },
      { amp: 0.18, len: 150 + r() * 90, phase: r() * Math.PI * 2 },
      { amp: 0.07, len: 55 + r() * 30, phase: r() * Math.PI * 2 },
    ]
  }

  headingAt(s: number): number {
    let h = 0
    for (const w of this.waves) h += w.amp * Math.sin((s / w.len) * Math.PI * 2 + w.phase)
    return h
  }

  private extendTo(s: number): void {
    const need = Math.ceil(Math.max(0, s) / PATH_STEP_M) + 1
    for (let i = this.xs.length; i <= need; i++) {
      const h = this.headingAt((i - 0.5) * PATH_STEP_M) // midpoint rule: smooth and accurate
      this.xs.push(this.xs[i - 1] + Math.sin(h) * PATH_STEP_M)
      this.zs.push(this.zs[i - 1] + Math.cos(h) * PATH_STEP_M)
    }
  }

  pose(s: number): Pose {
    if (s < 0) {
      // Before the start the path runs straight back (the camera sits behind position 0).
      const h = this.headingAt(0)
      return { x: Math.sin(h) * s, z: Math.cos(h) * s, heading: h }
    }
    this.extendTo(s + PATH_STEP_M)
    const i = Math.floor(s / PATH_STEP_M)
    const t = s / PATH_STEP_M - i
    return {
      x: this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t,
      z: this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t,
      heading: this.headingAt(s),
    }
  }

  /** A point `lateral` metres to the right of the path at `s`. */
  side(s: number, lateral: number): { x: number; z: number } {
    const p = this.pose(s)
    return { x: p.x + Math.cos(p.heading) * lateral, z: p.z - Math.sin(p.heading) * lateral }
  }
}

// --- biomes -------------------------------------------------------------------------------------

export { BIOMES, BIOME_NAMES, START_BIOMES, isStartBiome, randomSeed, randomStartBiome } from './biomes'
export type { Biome, StartBiome } from './biomes'
import { BIOMES, type Biome, type StartBiome } from './biomes'

type Natural = StartBiome

/** Which biome may follow which (so a village sits among fields, not in a gorge). */
const NEXT: Record<Natural, Natural[]> = {
  forest: ['ruins', 'falls', 'meadow', 'fields'],
  ruins: ['forest', 'falls', 'meadow'],
  meadow: ['fields', 'village', 'forest', 'falls'],
  fields: ['village', 'meadow', 'castle', 'forest'],
  village: ['fields', 'castle', 'meadow', 'forest'],
  castle: ['village', 'fields', 'forest'],
  falls: ['forest', 'meadow', 'ruins'],
}
/** Span length range per biome, metres. */
const SPAN_M: Record<Natural, [number, number]> = {
  forest: [1600, 3200],
  ruins: [1200, 2400],
  meadow: [1500, 3000],
  fields: [1500, 2800],
  village: [700, 1300],
  castle: [800, 1100],
  falls: [1400, 2600],
}

export const BLEND_M = 250
const CITY_MIN_M = 1500

export interface BiomeSpan {
  biome: Biome
  start: number
  end: number
}

/**
 * The biome sequence along a trail: seeded spans that follow sensible neighbours (NEXT), never
 * the same twice in a row and preferring biomes not seen for a while, so a long trail visits
 * everything. It starts in `start` (the forest unless chosen). A trail with a length ends in the
 * neon city (its last 15 %, at least 1.5 km); without a length (free walking) the city turns up
 * now and then instead.
 */
export function biomePlan(seed: number, length: number | null, upTo: number, start: StartBiome = 'forest'): BiomeSpan[] {
  const r = rng(hashInts(seed, 2))
  const cityStart = length === null ? Number.POSITIVE_INFINITY : Math.max(0, length - Math.max(CITY_MIN_M, length * 0.15))
  const spans: BiomeSpan[] = []
  const lastSeen = new Map<Biome, number>()
  let s = 0
  let prev: Biome | null = null
  while (s < Math.min(upTo, cityStart)) {
    let biome: Biome
    if (spans.length === 0) biome = start
    else if (length === null && prev !== 'city' && r() < 0.08) biome = 'city'
    else {
      const options: Natural[] = NEXT[(prev === 'city' ? 'meadow' : prev) as Natural].filter((b) => b !== prev)
      const weights = options.map((b) => 1 + Math.min(6, spans.length - (lastSeen.get(b) ?? -6)))
      let pick = r() * weights.reduce((a, b) => a + b, 0)
      biome = options[options.length - 1]
      for (let i = 0; i < options.length; i++) {
        pick -= weights[i]
        if (pick < 0) {
          biome = options[i]
          break
        }
      }
    }
    const [lo, hi] = biome === 'city' ? [1500, 2500] : spans.length === 0 ? [900, 1700] : SPAN_M[biome as Natural]
    const len = lo + r() * (hi - lo)
    lastSeen.set(biome, spans.length)
    spans.push({ biome, start: s, end: Math.min(s + len, cityStart) })
    s += len
    prev = biome
  }
  if (Number.isFinite(cityStart)) spans.push({ biome: 'city', start: cityStart, end: Number.POSITIVE_INFINITY })
  return spans.filter((sp) => sp.end > sp.start)
}

export type Weights = Record<Biome, number>

function zeroWeights(): Weights {
  return { forest: 0, ruins: 0, meadow: 0, fields: 0, village: 0, castle: 0, falls: 0, city: 0 }
}

/** Biome weights at `s`: 1 for the current biome, blended over BLEND_M across a border. */
export function biomeWeights(plan: BiomeSpan[], s: number): Weights {
  s = Math.max(0, s) // before the start: the first biome
  const w = zeroWeights()
  const i = plan.findIndex((sp) => s >= sp.start && s < sp.end)
  const span = plan[i === -1 ? plan.length - 1 : i]
  const next = plan[i + 1]
  if (next && s > span.end - BLEND_M / 2 && i !== -1) {
    const t = Math.min(1, (s - (span.end - BLEND_M / 2)) / BLEND_M)
    w[span.biome] += 1 - smooth(t)
    w[next.biome] += smooth(t)
  } else if (i > 0 && s < span.start + BLEND_M / 2) {
    const prev = plan[i - 1]
    const t = Math.min(1, (s - (span.start - BLEND_M / 2)) / BLEND_M)
    w[prev.biome] += 1 - smooth(t)
    w[span.biome] += smooth(t)
  } else {
    w[span.biome] = 1
  }
  return w
}

export function dominantBiome(w: Weights): Biome {
  return BIOMES.reduce((best, b) => (w[b] > w[best] ? b : best))
}

export function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

// --- weather and time of day --------------------------------------------------------------------

const RAIN_ZONE_M = 1500

/** Light rain in some 1.5 km stretches (more in the ruins' mist), faded in and out. 0..1 */
export function rainAt(seed: number, s: number, w: Weights): number {
  const zone = Math.floor(s / RAIN_ZONE_M)
  const chance = 0.22 + 0.25 * w.ruins + 0.08 * w.falls - 0.12 * (w.meadow + w.fields + w.village)
  const r = rng(hashInts(seed, 3, zone))()
  if (r > chance) return 0
  const t = (s - zone * RAIN_ZONE_M) / RAIN_ZONE_M
  return Math.min(1, Math.sin(Math.PI * t) * 1.6) * (0.5 + r)
}

export const CYCLE_MINUTES = 24 // a full day passes in 24 real minutes (1 min = 1 h)

/** Hour of the day [0, 24): following real local time, or the accelerated cycle. */
export function hourOfDay(mode: 'cycle' | 'real', nowMs: number, cycleStartHour = 9): number {
  if (mode === 'real') {
    const d = new Date(nowMs)
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
  }
  const hours = (nowMs / 60_000) * (24 / CYCLE_MINUTES)
  return (((cycleStartHour + hours) % 24) + 24) % 24
}

/** Sun elevation in [-1, 1] (sine of the angle above the horizon): sunrise 6:00, noon 1. */
export function sunHeight(hour: number): number {
  return Math.sin(((hour - 6) / 24) * Math.PI * 2)
}

/** 0 at full day, 1 at full night, smooth through dusk and dawn. */
export function nightness(hour: number): number {
  return 1 - smooth((sunHeight(hour) + 0.15) / 0.35)
}

// --- quality ------------------------------------------------------------------------------------

export type Quality = 'high' | 'medium' | 'low'

export interface QualityPreset {
  pixelRatio: number
  viewM: number // how far ahead terrain is generated
  density: number // prop density multiplier
  grassM: number // grass, crops and flowers are drawn this far
  buildM: number // buildings are drawn this far (beyond it the fog hides them anyway)
  shadows: boolean
  bloom: boolean
  rainDrops: number
  antialias: boolean
}

export const QUALITY: Record<Quality, QualityPreset> = {
  high: { pixelRatio: 2, viewM: 420, density: 1, grassM: 130, buildM: 270, shadows: true, bloom: true, rainDrops: 2400, antialias: true },
  medium: { pixelRatio: 1.25, viewM: 300, density: 0.6, grassM: 85, buildM: 200, shadows: true, bloom: false, rainDrops: 1400, antialias: true },
  low: { pixelRatio: 1, viewM: 200, density: 0.35, grassM: 50, buildM: 140, shadows: false, bloom: false, rainDrops: 600, antialias: false },
}

// --- terrain ------------------------------------------------------------------------------------

export const PATH_HALF_WIDTH_M = 1.6
export const TERRAIN_HALF_WIDTH_M = 200
/** The river in the waterfall valley, on the positive-lateral side of the path. */
export const RIVER = { lat0: 4.2, lat1: 16, level: -0.75 }
/** Cliffs in the waterfall valley start this far from the path. */
export const CLIFF_M = 17

/** Ground height at a point `lateral` metres off the path: flat on the path, rolling away from
 * it. Meadows have lake hollows; farms, villages and towns are gentle; the waterfall valley has
 * cliffs either side and a river bed on the right; the city is flat. */
export function groundHeight(seed: number, x: number, z: number, lateral: number, w: Weights): number {
  const a = Math.abs(lateral)
  const away = smooth((a - PATH_HALF_WIDTH_M - 1) / 14)
  const hills = fbm(seed, x / 70, z / 70, 3) * 7 + fbm(seed + 9, x / 18, z / 18, 2) * 1.2
  const relief = w.forest + w.ruins + w.meadow * 0.55 + w.fields * 0.3 + w.village * 0.18
    + w.castle * 0.22 + w.falls * 0.35 + w.city * 0.05
  let h = hills * relief * away
  if (w.falls > 0) {
    const top = 22 + 16 * fbm(seed + 21, x / 45, z / 45, 3)
    const cliff = smooth((a - CLIFF_M) / 7) * top + smooth((a - 30) / 40) * 10
    h += w.falls * cliff
    if (lateral > 0) {
      const bed = smooth((lateral - RIVER.lat0) / 1.6) * smooth((RIVER.lat1 - lateral) / 1.6)
      h += (Math.min(h, -1.7) - h) * bed * w.falls
    }
  }
  return h
}

export type FieldPatch = 'wheat' | 'green' | 'plough' | 'lavender' | 'pasture'
const PATCHES: FieldPatch[] = ['wheat', 'wheat', 'green', 'plough', 'lavender', 'pasture', 'wheat', 'pasture']
const FIELD_BANDS = [3.4, 24, 46, 75, 120, Number.POSITIVE_INFINITY]

/** The farm field at a point: a patchwork of 30-45 m long fields in bands away from the road. */
export function fieldPatch(seed: number, s: number, lateral: number): FieldPatch | null {
  const a = Math.abs(lateral)
  if (a < FIELD_BANDS[0]) return null
  const band = FIELD_BANDS.findIndex((edge) => a < edge) // 1..
  const len = 30 + (hashInts(seed, 30, band) % 16)
  const offset = hashInts(seed, 31, band, lateral > 0 ? 1 : 0) % len
  const cell = Math.floor((s + offset) / len)
  return PATCHES[hashInts(seed, 32, cell, band * (lateral > 0 ? 1 : -1)) % PATCHES.length]
}

// --- props --------------------------------------------------------------------------------------

export type PropKind =
  | 'pine' | 'oak' | 'birch' | 'deadtree' | 'rock' | 'bush' | 'mushroom' | 'fern'
  | 'pillar' | 'arch' | 'ruinwall' | 'ruinwindow' | 'ruindoor' | 'rubble' | 'crystal'
  | 'fence' | 'wagon' | 'crate' | 'barrel' | 'stall' | 'well' | 'haybale' | 'scarecrow'
  | 'grass' | 'flower' | 'reed' | 'wheat' | 'cabbage' | 'lavender'
  | 'tower' | 'neon' | 'lamp' | 'strip'

/** Low plants drawn only near the walker (QualityPreset.grassM). */
export const SMALL_PLANTS: PropKind[] = ['grass', 'flower', 'wheat', 'cabbage', 'lavender', 'fern', 'mushroom']

/** Props that turn to face the path (the rest turn freely). */
export const FACES_PATH: PropKind[] = ['ruinwall', 'ruinwindow', 'ruindoor', 'arch', 'neon', 'fence', 'wagon', 'stall']

export interface Placement {
  kind: PropKind
  s: number
  lateral: number
  scale: number
  rotation: number
  tint: number // 0..1, for colour variation
}

type Table = [PropKind, number, [number, number]][] // kind, count per 100 m, lateral range

const PROPS: Record<Biome, Table> = {
  forest: [
    ['pine', 38, [5, 85]], ['pine', 26, [4.6, 22]], ['oak', 9, [6, 80]], ['birch', 6, [4, 60]], ['deadtree', 3, [4, 60]],
    ['rock', 12, [2.6, 60]], ['bush', 30, [2.4, 40]], ['mushroom', 18, [2.2, 12]], ['fern', 160, [2.2, 26]],
    ['grass', 260, [2.2, 18]],
  ],
  ruins: [
    ['pillar', 6, [3.2, 45]], ['arch', 0.6, [6, 30]], ['ruinwall', 2.5, [5, 50]], ['ruinwindow', 1.5, [5, 45]],
    ['ruindoor', 0.8, [5, 35]], ['rubble', 22, [2.4, 30]], ['crystal', 9, [2.6, 30]], ['fern', 40, [2.2, 20]],
    ['oak', 6, [8, 80]], ['birch', 4, [8, 60]], ['rock', 8, [2.6, 60]], ['grass', 500, [2.2, 30]], ['fern', 25, [2.4, 20]],
  ],
  meadow: [
    ['grass', 1500, [2.2, 24]], ['grass', 300, [24, 60]], ['flower', 220, [2.2, 34]], ['reed', 18, [10, 70]],
    ['oak', 4, [10, 85]], ['birch', 3, [10, 70]], ['rock', 4, [3, 60]], ['bush', 7, [3, 50]],
    ['wagon', 0.25, [5, 18]], ['crate', 1.2, [3, 18]],
  ],
  fields: [
    ['wheat', 2600, [3.4, 42]], ['cabbage', 700, [3.4, 42]], ['lavender', 900, [3.4, 42]],
    ['grass', 600, [2.2, 42]], ['flower', 80, [2.2, 6]], ['haybale', 12, [5, 70]], ['scarecrow', 0.8, [6, 30]],
    ['oak', 2.5, [6, 120]], ['bush', 3, [4, 60]], ['wagon', 0.3, [4, 14]], ['crate', 1, [3.5, 10]],
  ],
  village: [
    ['grass', 420, [3, 40]], ['flower', 120, [2.6, 14]], ['barrel', 9, [3.2, 6]], ['crate', 6, [3.2, 6]],
    ['stall', 1.6, [3.6, 4.4]], ['wagon', 0.6, [3.6, 5]], ['well', 0.3, [4, 5]],
    ['oak', 4, [16, 90]], ['birch', 2, [16, 60]], ['bush', 8, [3, 30]],
  ],
  castle: [
    ['grass', 500, [2.4, 40]], ['flower', 60, [2.4, 14]], ['barrel', 6, [3.2, 6]], ['crate', 4, [3.2, 6]],
    ['stall', 1, [3.6, 4.4]], ['oak', 3, [12, 90]], ['rock', 4, [6, 60]], ['bush', 6, [3, 30]],
  ],
  falls: [
    ['pine', 26, [5, 90]], ['birch', 6, [4, 50]], ['rock', 22, [2.6, 40]], ['bush', 10, [2.4, 40]],
    ['fern', 70, [2.2, 20]], ['grass', 600, [2.2, 22]], ['reed', 14, [3.6, 5]], ['flower', 30, [2.2, 14]],
  ],
  city: [
    ['tower', 14, [9, 85]], ['neon', 22, [6, 26]], ['lamp', 5, [2.4, 2.8]], ['strip', 30, [2.0, 2.1]],
  ],
}

const CROP: Partial<Record<PropKind, FieldPatch[]>> = {
  wheat: ['wheat'], cabbage: ['green'], lavender: ['lavender'], grass: ['pasture'], haybale: ['pasture', 'plough'],
}

/** A rectangle in trail coordinates that props keep out of (houses, castle walls). */
export interface Footprint {
  s0: number
  s1: number
  lat0: number
  lat1: number
}

function inside(f: Footprint, s: number, lateral: number): boolean {
  return s >= f.s0 && s <= f.s1 && lateral >= f.lat0 && lateral <= f.lat1
}

/**
 * Props for one stretch of trail [s0, s1): seeded by (seed, chunk), so a chunk always gets the
 * same props. Each biome's table is used at its weight, so borders mix gradually. Props keep out
 * of `avoid` (buildings), out of the river, and crops grow only in their kind of field.
 */
export function scatter(
  seed: number, chunk: number, s0: number, s1: number, plan: BiomeSpan[], density: number, avoid: Footprint[] = [],
): Placement[] {
  const r = rng(hashInts(seed, 4, chunk))
  const out: Placement[] = []
  const len = s1 - s0
  for (const biome of BIOMES) {
    for (const [kind, per100, [lo, hi]] of PROPS[biome]) {
      const expected = (per100 * len) / 100 * density
      const n = Math.floor(expected) + (r() < expected % 1 ? 1 : 0)
      for (let i = 0; i < n; i++) {
        const s = s0 + r() * len
        const side = r() < 0.5 ? -1 : 1
        const lateral = side * (lo + Math.pow(r(), 1.4) * (hi - lo))
        const scale = 0.7 + r() * 0.7
        const rotation = r() * Math.PI * 2
        const tint = r()
        const keep = r()
        // Only where this biome actually is (borders thin out gradually).
        const w = biomeWeights(plan, s)
        if (keep > w[biome]) continue
        if (biome === 'fields' && CROP[kind]) {
          const patch = fieldPatch(seed, s, lateral)
          if (patch === null ? kind !== 'grass' : !CROP[kind]!.includes(patch)) continue
        }
        if (w.falls > 0.3 && lateral > RIVER.lat0 - 0.6 && lateral < RIVER.lat1 + 0.6 && kind !== 'reed' && kind !== 'rock') continue
        if (avoid.some((f) => inside(f, s, lateral))) continue
        out.push({ kind, s, lateral, scale, rotation, tint })
      }
    }
  }
  return out
}

// --- buildings ----------------------------------------------------------------------------------

/** One kit (or procedural) model in a structure's frame: x right, y up, z forward. */
export interface Piece {
  model: string
  x: number
  y: number
  z: number
  ry: number
}

export type StructureKind = 'house' | 'tower' | 'wall' | 'gate' | 'keep' | 'windmill' | 'fence' | 'lantern' | 'ruin' | 'archway'

/**
 * A building placed in trail coordinates: its origin is `lateral` metres off the path at `s`, on
 * the ground there, turned `yaw` from the path direction (0: local +z along the path, local +x to
 * the right; -side*PI/2: local +z faces the path).
 */
export interface Structure {
  kind: StructureKind
  s: number
  lateral: number
  yaw: number
  pieces: Piece[]
  foot: Footprint | null
}

export const FLOOR_M = 3
const HOUSE_SLOT_M = 13
const MILL_SLOT_M = 170
const FENCE_M = 2.06
const LANTERN_M = 19

/** Faces the path from this side of it. */
function facing(side: number): number {
  return (-side * Math.PI) / 2
}

/** A point `dx` right and `dz` forward of (x, z) in a frame turned `ry`. */
function offset(x: number, z: number, ry: number, dx: number, dz: number): [number, number] {
  return [x + dx * Math.cos(ry) + dz * Math.sin(ry), z - dx * Math.sin(ry) + dz * Math.cos(ry)]
}

/** Walls of a W x D box: every 2 m module with its position, turn and whether it is the front. */
function modules(W: number, D: number): { x: number; z: number; ry: number; front: boolean; i: number }[] {
  const out: { x: number; z: number; ry: number; front: boolean; i: number }[] = []
  for (let i = 0; i < W / 2; i++) {
    out.push({ x: -W / 2 + 1 + 2 * i, z: D / 2, ry: 0, front: true, i })
    out.push({ x: W / 2 - 1 - 2 * i, z: -D / 2, ry: Math.PI, front: false, i })
  }
  for (let i = 0; i < D / 2; i++) {
    out.push({ x: W / 2, z: D / 2 - 1 - 2 * i, ry: Math.PI / 2, front: false, i })
    out.push({ x: -W / 2, z: -D / 2 + 1 + 2 * i, ry: -Math.PI / 2, front: false, i })
  }
  return out
}

export interface HouseStyle {
  W: 4 | 6
  D: 4 | 6 | 8
  floors: number
  stone: 'all' | 'ground' | 'none'
}

/** A half-timbered house from the kit's modular pieces, its door (front, +z) facing the road. */
export function house(r: () => number, style: HouseStyle): Piece[] {
  const { W, D, floors, stone } = style
  const out: Piece[] = []
  const add = (model: string, x: number, y: number, z: number, ry = 0) => out.push({ model, x, y, z, ry })
  add(`found_${W}x${D}`, 0, 0, 0)
  const doorAt = Math.floor(r() * (W / 2))
  for (let f = 0; f < floors; f++) {
    const y = f * FLOOR_M
    const family = stone === 'all' || (stone === 'ground' && f === 0) ? 'UnevenBrick' : 'Plaster'
    for (const m of modules(W, D)) {
      const door = f === 0 && m.front && m.i === doorAt
      // No windows at the back: it faces away from the road (and they cost triangles).
      const back = m.ry === Math.PI
      const window = !door && !back && r() < (m.front ? 0.75 : 0.45)
      let model = `Wall_${family}_Straight`
      if (door) model = `Wall_${family}_Door_Round`
      else if (window) model = `Wall_${family}_Window_Wide_Round`
      else if (family === 'Plaster' && r() < 0.55) model = 'Wall_Plaster_WoodGrid'
      add(model, m.x, y, m.z, m.ry)
      if (window) {
        add(r() < 0.6 ? 'Window_Wide_Round1' : 'Window_Wide_Round1#dark', m.x, y, m.z, m.ry)
        const shutters = r()
        if (shutters < 0.45) add('WindowShutters_Wide_Round_Open', m.x, y, m.z, m.ry)
        else if (shutters < 0.6) add('WindowShutters_Wide_Round_Closed', m.x, y, m.z, m.ry)
      }
      if (door) {
        const [dx, dz] = offset(m.x, m.z, m.ry, -0.53, 0)
        add('Door_1_Round', dx, y, dz, m.ry)
      }
      if (f > 0) add('Wall_BottomCover', m.x, y, m.z, m.ry)
    }
    const corner = family === 'UnevenBrick' ? 'corner_stone' : 'Corner_Exterior_Wood'
    for (const [cx, cz] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) add(corner, cx, y, cz)
  }
  const top = floors * FLOOR_M
  add(`Roof_RoundTiles_${W}x${D}`, 0, top, 0)
  add(`Roof_Front_Brick${W}`, 0, top, D / 2, 0)
  add(`Roof_Front_Brick${W}`, 0, top, -D / 2, Math.PI)
  if (r() < 0.8) {
    const side = r() < 0.5 ? -1 : 1
    add(r() < 0.5 ? 'Prop_Chimney' : 'Prop_Chimney2', side * (W === 4 ? 1 : 1.5), top + (W === 4 ? -0.4 : 0.1), (r() - 0.5) * (D - 2.5))
  }
  // Ivy hanging from the eaves of a side or the front.
  const vines = r() < 0.5 ? 1 + Math.floor(r() * 2) : 0
  const walls = modules(W, D)
  for (let v = 0; v < vines; v++) {
    const m = walls[Math.floor(r() * walls.length)]
    const [vx, vz] = offset(m.x, m.z, m.ry, (r() - 0.5) * 0.6, 0.12)
    add(r() < 0.5 ? 'Prop_Vine1' : 'Prop_Vine4', vx, top - 0.15, vz, m.ry)
  }
  return out
}

/** A square stone tower (2x2 modules), `floors` high, with the kit's tower roof. */
export function tower(r: () => number, floors: number): Piece[] {
  const out: Piece[] = [{ model: 'found_4x4', x: 0, y: 0, z: 0, ry: 0 }]
  for (let f = 0; f < floors; f++) {
    for (const m of modules(4, 4)) {
      const model = f > 0 && r() < 0.35 ? 'Wall_UnevenBrick_Window_Thin_Round' : f === 0 && m.front && m.i === 0 && r() < 0.5
        ? 'Wall_UnevenBrick_Door_Round' : 'Wall_UnevenBrick_Straight'
      out.push({ model, x: m.x, y: f * FLOOR_M, z: m.z, ry: m.ry })
      if (model.includes('Window')) out.push({ model: r() < 0.5 ? 'Window_Thin_Round1' : 'Window_Thin_Round1#dark', x: m.x, y: f * FLOOR_M, z: m.z, ry: m.ry })
    }
    for (const [cx, cz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) out.push({ model: 'corner_stone', x: cx, y: f * FLOOR_M, z: cz, ry: 0 })
  }
  out.push({ model: 'Roof_Tower_RoundTiles', x: 0, y: floors * FLOOR_M, z: 0, ry: 0 })
  return out
}

/** A 2 m stretch of curtain wall (two storeys of stone with battlements). */
function wallColumn(): Piece[] {
  return [
    { model: 'found_wall', x: 0, y: 0, z: 0, ry: 0 },
    { model: 'Wall_UnevenBrick_Straight', x: 0, y: 0, z: 0, ry: 0 },
    { model: 'Wall_UnevenBrick_Straight', x: 0, y: FLOOR_M, z: 0, ry: 0 },
    { model: 'wallcap', x: 0, y: 2 * FLOOR_M, z: 0, ry: 0 },
    { model: 'merlon', x: -0.5, y: 2 * FLOOR_M, z: 0, ry: 0 },
  ]
}

/** A ruined stone building: broken walls (some missing, some a storey higher), no roof, ivy. */
export function ruin(r: () => number, W: number, D: number): Piece[] {
  const out: Piece[] = []
  for (const m of modules(W, D)) {
    if (r() < 0.3) {
      if (r() < 0.5) out.push({ model: 'Prop_Brick2', x: m.x, y: 0.1, z: m.z, ry: r() * 6 })
      continue
    }
    const pick = r()
    const model = pick < 0.3 ? 'Wall_UnevenBrick_Window_Wide_Round' : pick < 0.45 ? 'Wall_UnevenBrick_Door_Round' : 'Wall_UnevenBrick_Straight'
    out.push({ model, x: m.x, y: 0, z: m.z, ry: m.ry })
    const high = r() < 0.35
    if (high) out.push({ model: r() < 0.5 ? 'Wall_UnevenBrick_Window_Thin_Round' : 'Wall_UnevenBrick_Straight', x: m.x, y: FLOOR_M, z: m.z, ry: m.ry })
    if (r() < 0.55) {
      const [vx, vz] = offset(m.x, m.z, m.ry, (r() - 0.5) * 0.6, 0.12)
      out.push({ model: r() < 0.6 ? 'Prop_Vine1' : 'Prop_Vine4', x: vx, y: (high ? 2 : 1) * FLOOR_M - 0.1, z: vz, ry: m.ry })
    }
  }
  return out
}

function castleOf(seed: number, span: BiomeSpan): Structure[] {
  const r = rng(hashInts(seed, 40, Math.floor(span.start)))
  const out: Structure[] = []
  const at = (kind: StructureKind, s: number, lateral: number, yaw: number, pieces: Piece[], foot: Footprint | null = null) =>
    out.push({ kind, s, lateral, yaw, pieces, foot })

  // The town gate across the road, with walls running off to both sides.
  const g = span.start + BLEND_M / 2 + 60
  for (const side of [-1, 1]) at('tower', g, side * 4.6, 0, tower(r, 3))
  const gate: Piece[] = [{ model: 'gatebeam', x: 0, y: 4.4, z: 0, ry: 0 }]
  for (const x of [-2, 0, 2]) {
    gate.push({ model: 'Wall_UnevenBrick_Straight', x, y: 4.6, z: 1.7, ry: 0 })
    gate.push({ model: 'Wall_UnevenBrick_Straight', x, y: 4.6, z: -1.7, ry: Math.PI })
    gate.push({ model: 'merlon', x: x - 0.5, y: 7.6, z: 1.7, ry: 0 })
    gate.push({ model: 'merlon', x: x - 0.5, y: 7.6, z: -1.7, ry: Math.PI })
  }
  at('gate', g, 0, 0, gate)
  for (const side of [-1, 1]) {
    for (let lat = 7.6; lat < 46; lat += 2) at('wall', g, side * lat, Math.PI, wallColumn(), { s0: g - 3, s1: g + 3, lat0: side > 0 ? 2.5 : -47, lat1: side > 0 ? 47 : -2.5 })
  }

  // The castle on one side: curtain walls, corner towers, a gate facing the road, the keep.
  const side = r() < 0.5 ? -1 : 1
  const c = Math.max(g + 120, (span.start + span.end) / 2)
  const near = 20
  const far = 50
  const half = 28
  const foot: Footprint = side > 0
    ? { s0: c - half - 3, s1: c + half + 3, lat0: near - 3, lat1: far + 3 }
    : { s0: c - half - 3, s1: c + half + 3, lat0: -far - 3, lat1: -near + 3 }
  for (let s = c - half + 1; s < c + half; s += 2) {
    if (Math.abs(s - c) > 3) at('wall', s, side * near, facing(side), wallColumn(), foot)
    at('wall', s, side * far, -facing(side), wallColumn(), foot)
  }
  for (let lat = near + 1; lat < far; lat += 2) {
    at('wall', c - half, side * lat, Math.PI, wallColumn(), foot)
    at('wall', c + half, side * lat, 0, wallColumn(), foot)
  }
  for (const [s, lat] of [[c - half, near], [c + half, near], [c - half, far], [c + half, far]]) {
    at('tower', s, side * lat, facing(side), tower(r, 4 + Math.floor(r() * 2)), foot)
  }
  for (const s of [c - 4.5, c + 4.5]) at('tower', s, side * near, facing(side), tower(r, 3), foot)
  at('gate', c, side * near, facing(side), [
    { model: 'gatebeam_small', x: 0, y: 4.4, z: 0, ry: 0 },
    ...[-1.5, 0, 1.5].flatMap((x) => [
      { model: 'Wall_UnevenBrick_Straight', x, y: 4.6, z: 0, ry: 0 },
      { model: 'merlon', x: x - 0.5, y: 7.6, z: 0, ry: 0 },
    ]),
  ], foot)
  at('keep', c + 7, side * 37, facing(side), house(r, { W: 6, D: 8, floors: 3, stone: 'all' }), foot)
  at('tower', c - 11, side * 39, facing(side), tower(r, 6), foot)
  at('house', c - 15, side * 28, facing(side), house(r, { W: 4, D: 4, floors: 2, stone: 'ground' }), foot)
  return out
}

function houseAt(r: () => number, s: number, side: number, lateral0: number, big: boolean): Structure {
  const sizes: [4 | 6, 4 | 6 | 8][] = big ? [[4, 6], [6, 6], [6, 8], [4, 4]] : [[4, 4], [4, 6], [6, 6]]
  const [W, D] = sizes[Math.floor(r() * sizes.length)]
  const floors = r() < 0.65 ? 2 : r() < 0.6 ? 1 : 3
  const stone = r() < 0.6 ? 'ground' : r() < 0.4 ? 'all' : 'none'
  const lateral = side * (lateral0 + D / 2 + r() * 1.5)
  const pieces = house(r, { W, D, floors, stone })
  return {
    kind: 'house', s, lateral, yaw: facing(side), pieces,
    foot: { s0: s - W / 2 - 1.2, s1: s + W / 2 + 1.2, lat0: lateral - D / 2 - 1.2, lat1: lateral + D / 2 + 1.2 },
  }
}

/**
 * Buildings whose origin lies in [a, b): village houses along the road (a second row behind),
 * farmhouses, windmills and fences in the farmlands, lanterns in towns, and in each castle-town
 * span a town gate across the road and a walled castle. Deterministic per seed, like everything.
 */
export function structures(seed: number, plan: BiomeSpan[], a: number, b: number): Structure[] {
  const out: Structure[] = []
  // Castles: whole castle per span, keep the parts in range.
  const castles: Structure[] = []
  for (const span of plan) {
    if (span.biome !== 'castle' || span.end < a - 400 || span.start > b + 400) continue
    castles.push(...castleOf(seed, span))
  }
  const castleFeet = castles.filter((c) => c.foot).map((c) => c.foot!)
  // The castle's side of the road stays open so the castle can be seen from the road.
  const keep = castles.find((c) => c.kind === 'keep')
  if (keep) {
    const side = Math.sign(keep.lateral)
    castleFeet.push({ s0: keep.s - 7 - 60, s1: keep.s - 7 + 55, lat0: side > 0 ? 2 : -60, lat1: side > 0 ? 60 : -2 })
  }
  out.push(...castles.filter((c) => c.s >= a && c.s < b))
  const blocked = (s: number, lateral: number, pad: number) =>
    castleFeet.some((f) => s >= f.s0 - pad && s <= f.s1 + pad && lateral >= f.lat0 - pad && lateral <= f.lat1 + pad)

  // Houses: a slot every 13 m on each side.
  for (let k = Math.floor(a / HOUSE_SLOT_M); k * HOUSE_SLOT_M < b; k++) {
    const s = k * HOUSE_SLOT_M + HOUSE_SLOT_M / 2
    if (s < a || s >= b || s < 20) continue
    const w = biomeWeights(plan, s)
    for (const side of [-1, 1]) {
      const r = rng(hashInts(seed, 41, k, side))
      const front = 0.88 * w.village + 0.55 * w.castle
      const back = 0.6 * w.village + 0.3 * w.castle
      if (r() < front && !blocked(s, side * 9, 6)) out.push(houseAt(r, s, side, 5.4, false))
      if (r() < back && !blocked(s, side * 26, 8)) out.push(houseAt(r, s, side, 21, true))
      if (r() < 0.06 * w.fields) out.push(houseAt(r, s, side, 26 + r() * 30, true))
    }
  }
  // Elven ruins: broken buildings off the path, and old archways across it.
  for (let k = Math.floor(a / 37); k * 37 < b; k++) {
    const r = rng(hashInts(seed, 44, k))
    const s = k * 37 + r() * 30
    if (s < a || s >= b) continue
    const w = biomeWeights(plan, s).ruins
    if (r() < 0.8 * w) {
      const side = r() < 0.5 ? -1 : 1
      const W = r() < 0.5 ? 4 : 6
      const D = r() < 0.5 ? 4 : 6
      const lateral = side * (5 + D / 2 + r() * 14)
      out.push({
        kind: 'ruin', s, lateral, yaw: facing(side) + (r() - 0.5) * 0.5, pieces: ruin(r, W, D),
        foot: { s0: s - W / 2 - 1.5, s1: s + W / 2 + 1.5, lat0: lateral - D / 2 - 1.5, lat1: lateral + D / 2 + 1.5 },
      })
    }
    if (r() < 0.22 * w) {
      out.push({ kind: 'archway', s: s + 15, lateral: 0, yaw: 0, pieces: [{ model: 'stone_arch', x: 0, y: 0, z: 0, ry: 0 }], foot: { s0: s + 13, s1: s + 17, lat0: -4, lat1: 4 } })
    }
  }
  // Windmills in the farmlands.
  for (let k = Math.floor(a / MILL_SLOT_M); k * MILL_SLOT_M < b; k++) {
    const r = rng(hashInts(seed, 42, k))
    const s = k * MILL_SLOT_M + r() * (MILL_SLOT_M - 20)
    if (s < a || s >= b) continue
    if (r() < 0.55 * biomeWeights(plan, s).fields) {
      const side = r() < 0.5 ? -1 : 1
      const lateral = side * (24 + r() * 30)
      out.push({
        kind: 'windmill', s, lateral, yaw: facing(side), pieces: [{ model: 'mill', x: 0, y: 0, z: 0, ry: 0 }],
        foot: { s0: s - 5, s1: s + 5, lat0: lateral - 5, lat1: lateral + 5 },
      })
    }
  }
  // Fences along farm roads, in runs with gaps.
  for (let k = Math.floor(a / FENCE_M); k * FENCE_M < b; k++) {
    const s = k * FENCE_M + FENCE_M / 2
    if (s < a || s >= b) continue
    const w = biomeWeights(plan, s)
    if (w.fields < 0.5) continue
    for (const side of [-1, 1]) {
      const run = hashInts(seed, 43, Math.floor(k / 14), side)
      if (run % 100 < 30) continue
      out.push({ kind: 'fence', s, lateral: side * 3.1, yaw: facing(side), pieces: [{ model: k % 3 === 0 ? 'Prop_WoodenFence_Single' : 'Prop_WoodenFence_Extension1', x: 0, y: 0, z: 0, ry: 0 }], foot: null })
    }
  }
  // Lanterns along town streets, alternating sides.
  for (let k = Math.floor(a / LANTERN_M); k * LANTERN_M < b; k++) {
    const s = k * LANTERN_M + 3
    if (s < a || s >= b) continue
    const w = biomeWeights(plan, s)
    if (w.village + w.castle < 0.5) continue
    const side = k % 2 === 0 ? -1 : 1
    if (blocked(s, side * 2.6, 1)) continue
    out.push({ kind: 'lantern', s, lateral: side * 2.6, yaw: facing(side), pieces: [{ model: 'lantern', x: 0, y: 0, z: 0, ry: 0 }], foot: null })
  }
  return out
}

/** Waterfalls down the valley cliffs: one in some 60 m slots, either side. */
export interface Waterfall {
  s: number
  side: number
  width: number
}

export function waterfalls(seed: number, plan: BiomeSpan[], a: number, b: number): Waterfall[] {
  const out: Waterfall[] = []
  for (let k = Math.floor(a / 60); k * 60 < b; k++) {
    const r = rng(hashInts(seed, 50, k))
    const s = k * 60 + 10 + r() * 40
    if (s < a || s >= b) continue
    if (r() < 0.8 * biomeWeights(plan, s).falls) out.push({ s, side: r() < 0.6 ? 1 : -1, width: 9 + r() * 14 })
  }
  return out
}
