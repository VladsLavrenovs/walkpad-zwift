/**
 * Water: lakes where the land holds water, rivers where enough rain has gathered, waterfalls
 * where a river drops steeply.
 *
 * - Priority flood (Barnes et al.) from the sea fills every depression to its spill level with a
 *   tiny gradient, so every land cell drains to the sea. Deep enough filled pits become lakes,
 *   flat at their spill level.
 * - Cells are flooded in order of their filled height, so draining to the lowest neighbour and
 *   accumulating rain in reverse flood order is a single pass.
 * - Rivers are cells whose rain-weighted upstream area passes RIVER_FLOW, traced from each
 *   source to the sea, a lake, or the river they join.
 */

import { MinHeap } from './heap'
import { chaikin } from './smooth'
import { type River, Water, type Waterfall } from './types'

const EPS = 0.002 // metres of drop added per cell while filling: drains without visible slopes
const LAKE_DEPTH = 1 // a cell is part of a basin when filled this deep
const LAKE_MIN_DEEPEST = 8 // ...and the basin becomes a lake when its deepest point is this deep
const LAKE_MIN_CELLS = 40
const MAX_LAKES = 18
export const RIVER_FLOW = 700
const FALL_DROP = 6 // metres over one cell
const FALL_SPACING_M = 220

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const

export interface Hydrology {
  surface: Float32Array
  water: Uint8Array
  flow: Float32Array
  down: Int32Array
  rivers: River[]
  waterfalls: Waterfall[]
}

export function buildHydrology(height: Float32Array, n: number, cell: number): Hydrology {
  const size = n * n
  const filled = new Float32Array(height)
  const closed = new Uint8Array(size)
  const order = new Int32Array(size)
  const parent = new Int32Array(size).fill(-1)
  const water = new Uint8Array(size)
  let k = 0
  const heap = new MinHeap(n * 8)
  // Seeds: the sea and the map border.
  for (let c = 0; c < size; c++) {
    const i = c % n
    const j = (c - i) / n
    if (height[c] <= 0 || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
      closed[c] = 1
      if (height[c] <= 0) water[c] = Water.Sea
      heap.push(filled[c], c)
    }
  }
  while (heap.size > 0) {
    const c = heap.pop()
    order[k++] = c
    const i = c % n
    const j = (c - i) / n
    for (const [di, dj] of N8) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const nb = nj * n + ni
      if (closed[nb]) continue
      closed[nb] = 1
      filled[nb] = Math.max(height[nb], filled[c] + EPS)
      parent[nb] = c
      heap.push(filled[nb], nb)
    }
  }

  // Lakes: connected filled pits deep enough, flat at their highest filled level.
  const surface = new Float32Array(height)
  const seen = new Uint8Array(size)
  const basins: number[][] = []
  for (let c = 0; c < size; c++) {
    if (seen[c] || water[c] !== Water.Land || filled[c] - height[c] < LAKE_DEPTH) continue
    const comp: number[] = [c]
    seen[c] = 1
    for (let q = 0; q < comp.length; q++) {
      const a = comp[q]
      const i = a % n
      const j = (a - i) / n
      for (const [di, dj] of N8) {
        const ni = i + di
        const nj = j + dj
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nb = nj * n + ni
        if (seen[nb] || water[nb] !== Water.Land || filled[nb] - height[nb] < 0.05) continue
        seen[nb] = 1
        comp.push(nb)
      }
    }
    if (comp.length < LAKE_MIN_CELLS) continue
    let deepest = 0
    for (const a of comp) deepest = Math.max(deepest, filled[a] - height[a])
    if (deepest >= LAKE_MIN_DEEPEST) basins.push(comp)
  }
  // The biggest basins become lakes, flat at their spill level; the rest just drain through.
  basins.sort((a, b) => b.length - a.length)
  for (const comp of basins.slice(0, MAX_LAKES)) {
    // The spill level: the lowest filled height (the filling added a tiny slope towards the
    // inside). Rim cells above it stay dry land.
    let level = Infinity
    for (const a of comp) level = Math.min(level, filled[a])
    for (const a of comp) {
      if (height[a] >= level) continue
      water[a] = Water.Lake
      surface[a] = level
      filled[a] = level
    }
  }

  // Drain to the lowest lower neighbour (steepest descent on the filled surface).
  const down = new Int32Array(size).fill(-1)
  for (let c = 0; c < size; c++) {
    if (water[c] === Water.Sea) continue
    const i = c % n
    const j = (c - i) / n
    let best = parent[c]
    let bestH = best >= 0 ? filled[best] : Infinity
    for (const [di, dj] of N8) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const nb = nj * n + ni
      if (filled[nb] < bestH && filled[nb] < filled[c]) {
        best = nb
        bestH = filled[nb]
      }
    }
    down[c] = best
  }

  // Rain-weighted upstream area (mountains catch more rain), highest cells first.
  const flow = new Float32Array(size)
  for (let c = 0; c < size; c++) flow[c] = water[c] === Water.Sea ? 0 : 1 + Math.min(1.5, Math.max(0, height[c] / 300))
  for (let q = size - 1; q >= 0; q--) {
    const c = order[q]
    const d = down[c]
    if (d >= 0 && water[c] !== Water.Sea) flow[d] += flow[c]
  }

  // Rivers: trace from each source down to the sea, a lake or a river already traced.
  const isRiver = (c: number) => water[c] === Water.Land && flow[c] >= RIVER_FLOW
  const hasRiverAbove = new Uint8Array(size)
  for (let c = 0; c < size; c++) if (isRiver(c) && down[c] >= 0) hasRiverAbove[down[c]] = 1
  const traced = new Uint8Array(size)
  const rivers: River[] = []
  const xy = (c: number): [number, number] => [((c % n) + 0.5) * cell, (Math.floor(c / n) + 0.5) * cell]
  // Longest rivers first, so tributaries end where they join.
  const sources: number[] = []
  for (let c = 0; c < size; c++) if (isRiver(c) && !hasRiverAbove[c]) sources.push(c)
  sources.sort((a, b) => filled[b] - filled[a])
  for (const src of sources) {
    const cells: number[] = []
    let c = src
    for (;;) {
      cells.push(c)
      if (traced[c] || water[c] !== Water.Land) break // joined a river, or reached a lake / the sea
      traced[c] = 1
      water[c] = Water.River
      const d = down[c]
      if (d < 0) break
      c = d
    }
    if (cells.length >= 3) {
      // A smooth curve through the cell centres; flow follows the nearest cell.
      const points = chaikin(cells.map(xy), 2)
      const flows = points.map((_, k) => flow[cells[Math.min(cells.length - 1, Math.round((k / (points.length - 1)) * (cells.length - 1)))]])
      rivers.push({ cells, points, flow: flows })
    }
  }
  // Rivers of the surface are the filled surface along them (monotonic, so they run downhill).
  for (let c = 0; c < size; c++) if (water[c] === Water.River) surface[c] = filled[c]

  // Waterfalls: a steep drop along a river, spaced apart.
  const waterfalls: Waterfall[] = []
  for (const r of rivers) {
    for (let p = 0; p + 1 < r.cells.length; p++) {
      const a = r.cells[p]
      const b = r.cells[p + 1]
      const [x0, z0] = xy(a)
      const [x1, z1] = xy(b)
      const drop = height[a] - height[b]
      if (drop < FALL_DROP) continue
      if (waterfalls.some((w) => Math.hypot(w.x - x0, w.z - z0) < FALL_SPACING_M)) continue
      waterfalls.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, drop })
    }
  }
  return { surface, water, flow, down, rivers, waterfalls }
}
