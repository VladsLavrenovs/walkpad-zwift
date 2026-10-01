/**
 * Settlements and points of interest, placed where they make sense (each kind scores candidate
 * spots, best first, kept apart), and provinces around the cities and castles with organic
 * (domain-warped) borders.
 */

import { fbm, hashInts } from '../../fantasy/gen'
import { biomeWeightsFrom } from './climate'
import { Namer } from './names'
import { type Place, type PlaceKind, type Province, Water, type Waterfall } from './types'

export interface PlaceInput {
  seed: number
  n: number
  cell: number
  height: Float32Array
  slope: Float32Array
  water: Uint8Array
  moisture: Float32Array
  lore: Float32Array
  waterfalls: Waterfall[]
}

const STRIDE = 5

/** Cells of the largest connected landmass (rivers count as land: roads bridge them). */
export function mainland(water: Uint8Array, n: number): Uint8Array {
  const comp = new Int32Array(n * n).fill(-1)
  let best = -1
  let bestSize = 0
  let id = 0
  const queue = new Int32Array(n * n)
  for (let c = 0; c < n * n; c++) {
    if (comp[c] >= 0 || !isLand(water[c])) continue
    let head = 0
    let tail = 0
    queue[tail++] = c
    comp[c] = id
    while (head < tail) {
      const a = queue[head++]
      const i = a % n
      const j = (a - i) / n
      const nbs = [i > 0 ? a - 1 : -1, i < n - 1 ? a + 1 : -1, j > 0 ? a - n : -1, j < n - 1 ? a + n : -1]
      for (const nb of nbs) {
        if (nb < 0 || comp[nb] >= 0 || !isLand(water[nb])) continue
        comp[nb] = id
        queue[tail++] = nb
      }
    }
    if (tail > bestSize) {
      bestSize = tail
      best = id
    }
    id++
  }
  const out = new Uint8Array(n * n)
  for (let c = 0; c < n * n; c++) out[c] = comp[c] === best ? 1 : 0
  return out
}

export function isLand(w: number): boolean {
  return w === Water.Land || w === Water.River
}

/** Distance in cells to the nearest river or lake (breadth first). */
function freshWaterDistance(water: Uint8Array, n: number): Float32Array {
  const dist = new Float32Array(n * n).fill(Infinity)
  const queue = new Int32Array(n * n)
  let head = 0
  let tail = 0
  for (let c = 0; c < n * n; c++) {
    if (water[c] === Water.River || water[c] === Water.Lake) {
      dist[c] = 0
      queue[tail++] = c
    }
  }
  while (head < tail) {
    const c = queue[head++]
    const i = c % n
    const j = (c - i) / n
    const d = dist[c] + 1
    if (i > 0 && dist[c - 1] > d) { dist[c - 1] = d; queue[tail++] = c - 1 }
    if (i < n - 1 && dist[c + 1] > d) { dist[c + 1] = d; queue[tail++] = c + 1 }
    if (j > 0 && dist[c - n] > d) { dist[c - n] = d; queue[tail++] = c - n }
    if (j < n - 1 && dist[c + n] > d) { dist[c + n] = d; queue[tail++] = c + n }
  }
  return dist
}

interface Candidate {
  c: number
  x: number
  z: number
  score: number
}

function pickApart(cands: Candidate[], spacing: number, cap: number, others: Place[] = [], otherSpacing = 0): Candidate[] {
  cands.sort((a, b) => b.score - a.score)
  const out: Candidate[] = []
  for (const cand of cands) {
    if (out.length >= cap) break
    if (out.some((o) => Math.hypot(o.x - cand.x, o.z - cand.z) < spacing)) continue
    if (others.some((o) => Math.hypot(o.x - cand.x, o.z - cand.z) < otherSpacing)) continue
    out.push(cand)
  }
  return out
}

export function placePlaces(input: PlaceInput): { places: Place[]; mainland: Uint8Array } {
  const { seed, n, cell, height, slope, water, moisture, lore } = input
  const land = mainland(water, n)
  const fresh = freshWaterDistance(water, n)
  const meanSlope = (c: number, r: number) => {
    const i0 = c % n
    const j0 = (c - i0) / n
    let sum = 0
    let count = 0
    for (let j = Math.max(0, j0 - r); j <= Math.min(n - 1, j0 + r); j++) {
      for (let i = Math.max(0, i0 - r); i <= Math.min(n - 1, i0 + r); i++) {
        sum += slope[j * n + i]
        count++
      }
    }
    return sum / count
  }
  const ringMean = (c: number, r: number) => {
    const i0 = c % n
    const j0 = (c - i0) / n
    let sum = 0
    let count = 0
    for (let a = 0; a < 16; a++) {
      const i = Math.round(i0 + Math.cos((a / 16) * Math.PI * 2) * r)
      const j = Math.round(j0 + Math.sin((a / 16) * Math.PI * 2) * r)
      if (i < 0 || j < 0 || i >= n || j >= n) continue
      sum += height[j * n + i]
      count++
    }
    return count ? sum / count : height[c]
  }
  const jitter = (c: number, k: number) => (hashInts(seed, 600 + k, c) % 1000) / 1000

  const villages: Candidate[] = []
  const castles: Candidate[] = []
  const ruins: Candidate[] = []
  const mills: Candidate[] = []
  for (let j = STRIDE; j < n - STRIDE; j += STRIDE) {
    for (let i = STRIDE; i < n - STRIDE; i += STRIDE) {
      const c = j * n + i
      if (!land[c] || water[c] !== Water.Land) continue
      const x = (i + 0.5) * cell
      const z = (j + 0.5) * cell
      const h = height[c]
      const w = biomeWeightsFrom(h, slope[c], moisture[c], lore[c])
      const flat = meanSlope(c, 2)
      if (h > 2 && h < 170 && flat < 0.1 && fresh[c] >= 2 && fresh[c] < 22) {
        const near = 1 - Math.min(1, Math.abs(fresh[c] - 5) / 17)
        const score = (w.fields + w.meadow + 0.35 * w.forest) * (1 - flat / 0.1) * (0.4 + near) * (0.8 + 0.4 * jitter(c, 1))
        villages.push({ c, x, z, score })
      }
      const prominence = h - ringMean(c, 12)
      if (h > 40 && prominence > 20 && meanSlope(c, 1) < 0.32) {
        castles.push({ c, x, z, score: prominence * (1 + w.falls * 0.3) * (0.85 + 0.3 * jitter(c, 2)) })
      }
      if (w.ruins > 0.3) ruins.push({ c, x, z, score: w.ruins * (0.7 + 0.6 * jitter(c, 3)) })
      if (w.fields > 0.55 && flat < 0.08) mills.push({ c, x, z, score: w.fields * (0.6 + 0.8 * jitter(c, 4)) })
    }
  }

  const namer = new Namer(seed)
  const places: Place[] = []
  const add = (kind: PlaceKind, cand: { x: number; z: number }, index: number, near?: string) => {
    const name = namer.name(kind, index, near)
    places.push({ id: `${kind}-${index}`, kind, name, x: cand.x, z: cand.z, province: -1 })
  }

  const towns = pickApart(villages, 750, 28)
  // Cities: the best-placed towns, far apart.
  const cityIdx = new Set<number>()
  const cities: Candidate[] = []
  for (const [k, t] of towns.entries()) {
    if (cities.length >= 3) break
    if (cities.every((o) => Math.hypot(o.x - t.x, o.z - t.z) >= 2500)) {
      cities.push(t)
      cityIdx.add(k)
    }
  }
  towns.forEach((t, k) => add(cityIdx.has(k) ? 'city' : 'village', t, k))
  const settled = [...places]
  pickApart(castles, 1600, 7, settled, 450).forEach((c, k) => add('castle', c, k))
  pickApart(ruins, 550, 16, places, 400).forEach((c, k) => add('ruins', c, k))
  const nearestTown = (x: number, z: number) => {
    let best: Place | null = null
    for (const p of settled) if (!best || Math.hypot(p.x - x, p.z - z) < Math.hypot(best.x - x, best.z - z)) best = p
    return best
  }
  const millCands = mills.filter((m) => {
    const t = nearestTown(m.x, m.z)
    return t !== null && Math.hypot(t.x - m.x, t.z - m.z) < 1500
  })
  pickApart(millCands, 450, 14, settled, 250).forEach((c, k) => add('windmill', c, k, nearestTown(c.x, c.z)?.name))
  ;[...input.waterfalls].sort((a, b) => b.drop - a.drop).slice(0, 20).forEach((f, k) => add('waterfall', f, k))
  return { places, mainland: land }
}

/** Provinces around the cities and castles (warped nearest-capital regions over the land). */
export function buildProvinces(
  seed: number, n: number, cell: number, water: Uint8Array, places: Place[],
): { province: Int16Array; provinces: Province[] } {
  // Capitals: the cities and the castles farthest from them (about six provinces).
  const cities = places.filter((p) => p.kind === 'city')
  const castles = places.filter((p) => p.kind === 'castle')
    .map((p) => ({ p, d: Math.min(...cities.map((c) => Math.hypot(c.x - p.x, c.z - p.z)), Infinity) }))
    .sort((a, b) => b.d - a.d)
  let capitals = [...cities, ...castles.slice(0, Math.max(0, 6 - cities.length)).map((e) => e.p)]
  if (capitals.length < 3) capitals = [...capitals, ...places.filter((p) => p.kind === 'village').slice(0, 3 - capitals.length)]
  const namer = new Namer(seed + 1)
  const province = new Int16Array(n * n).fill(-1)
  const sums = capitals.map(() => ({ x: 0, z: 0, count: 0 }))
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      if (!isLand(water[c])) continue
      const x = (i + 0.5) * cell
      const z = (j + 0.5) * cell
      const best = nearestCapital(seed, capitals, x, z)
      province[c] = best
      sums[best].x += x
      sums[best].z += z
      sums[best].count++
    }
  }
  const provinces: Province[] = capitals.map((cap, k) => ({
    id: k,
    name: namer.province(cap.name, k),
    capital: cap.id,
    cx: cap.x,
    cz: cap.z,
    x: sums[k].count ? sums[k].x / sums[k].count : cap.x,
    z: sums[k].count ? sums[k].z / sums[k].count : cap.z,
  }))
  for (const p of places) {
    const c = Math.min(n - 1, Math.floor(p.z / cell)) * n + Math.min(n - 1, Math.floor(p.x / cell))
    p.province = province[c]
  }
  return { province, provinces }
}

/** Which capital's province (x, z) belongs to: the nearest, measured from a warped position so
 * borders wander like real ones instead of running straight. Same rule for the grid and the map. */
export function nearestCapital(seed: number, capitals: { x: number; z: number }[], x: number, z: number): number {
  const wx = x + fbm(seed + 31, x / 1400, z / 1400, 3) * 700
  const wz = z + fbm(seed + 32, x / 1400 + 7.7, z / 1400 - 3.3, 3) * 700
  let best = 0
  let bestD = Infinity
  for (let k = 0; k < capitals.length; k++) {
    const d = (capitals[k].x - wx) ** 2 + (capitals[k].z - wz) ** 2
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}
