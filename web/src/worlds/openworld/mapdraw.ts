/**
 * Colours of the world map: terrain coloured by biome and height, hill-shaded, the sea by depth
 * with a light coastal band, lakes, and province borders. One pixel at a time from the continent
 * (rivers, roads and labels are drawn over it as vectors).
 */

import { type Continent, OW_BIOMES, type OwBiome, Water, biomeWeightsAt, cellAt, sample } from './continent'
import { nearestCapital } from './continent/places'

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
]

export const MAP_COLORS: Record<OwBiome, string> = {
  forest: '#3f6b36',
  ruins: '#6d8a6a',
  meadow: '#8fbc5c',
  fields: '#cdbb72',
  falls: '#8d877b',
}
const PALETTE = Object.fromEntries(OW_BIOMES.map((b) => [b, rgb(MAP_COLORS[b])])) as Record<OwBiome, [number, number, number]>
const SNOW = rgb('#f1f1ee')
const DEEP = rgb('#1c3d63')
const SHALLOW = rgb('#3f86b0')
const SURF = rgb('#8cc3d8')
const LAKE = rgb('#4a8fc0')
export const WATER_COLOR = '#4a8fc0'
const BORDER = rgb('#5a2d5c')
const FIELD_TINTS = [rgb('#d9c36d'), rgb('#b8b45f'), rgb('#9fae5a'), rgb('#c79a5f'), rgb('#d7c98a')]
// Light from the north-west, above.
const LIGHT = (() => {
  const v = [-0.6, 0.65, 0.45]
  const l = Math.hypot(v[0], v[1], v[2])
  return v.map((a) => a / l)
})()

function hash2(a: number, b: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** Write the colour of point (x, z) into `out` at `o`. `mpp`: metres per pixel (for shading). */
export function colorAt(c: Continent, x: number, z: number, mpp: number, out: Uint8ClampedArray, o: number): void {
  const W = c.n * c.cell
  if (x < 0 || z < 0 || x > W || z > W) {
    out.set([DEEP[0], DEEP[1], DEEP[2], 255], o)
    return
  }
  const cellIdx = cellAt(c, x, z)
  const h = sample(c, c.height, x, z)
  // Lake shores from the interpolated water level, not the cell grid (no staircase).
  let water: number = c.water[cellIdx]
  if (water === Water.Lake || nearLake(c, cellIdx)) {
    water = sample(c, c.surface, x, z) - h > 0.15 ? Water.Lake : water === Water.Lake ? Water.Land : water
  }
  let col: number[]
  if (water === Water.Sea || (h <= 0 && water !== Water.Lake)) {
    const depth = Math.min(1, Math.max(0, -h / 110))
    col = SHALLOW.map((s, k) => s + (DEEP[k] - s) * depth)
    if (h > -5) col = col.map((v, k) => v + (SURF[k] - v) * (1 - Math.max(0, -h) / 5) * 0.6)
  } else if (water === Water.Lake) {
    col = [...LAKE]
  } else {
    const w = biomeWeightsAt(c, x, z)
    col = [0, 0, 0]
    for (const b of OW_BIOMES) {
      let p = PALETTE[b]
      if (b === 'fields') p = FIELD_TINTS[hash2(Math.floor(x / 160 + 0.37 * Math.floor(z / 120)), Math.floor(z / 120)) % FIELD_TINTS.length]
      for (let k = 0; k < 3; k++) col[k] += p[k] * w[b]
    }
    // Rock above the tree line, snow on the peaks.
    const rock = Math.min(1, Math.max(0, (h - 330) / 120))
    col = col.map((v, k) => v + (PALETTE.falls[k] - v) * rock * 0.8)
    const snow = Math.min(1, Math.max(0, (h - 470) / 70))
    col = col.map((v, k) => v + (SNOW[k] - v) * snow)
    // A sandy rim along the coast.
    if (h < 3) col = col.map((v, k) => v + ([222, 205, 150][k] - v) * (1 - h / 3) * 0.6)
  }
  // Hill shading from the ground's slope (exaggerated so small maps read as relief).
  const d = Math.max(mpp, c.cell * 0.75)
  const dx = (sample(c, c.height, x + d, z) - sample(c, c.height, x - d, z)) / (2 * d)
  const dz = (sample(c, c.height, x, z + d) - sample(c, c.height, x, z - d)) / (2 * d)
  const k = 2.2
  const nx = -dx * k
  const nz = -dz * k
  const nl = Math.hypot(nx, 1, nz)
  // Map north (+z) is up on screen, so light from the north-west means -x, +z.
  const lit = (nx * LIGHT[0] + LIGHT[1] + nz * LIGHT[2]) / nl
  const shade = h > 0 || water === Water.Lake ? 0.62 + 0.55 * lit : 1
  col = col.map((v) => v * shade)
  // Province borders, at pixel precision: near a border of the grid, ask the province rule itself.
  if (h > 0 && nearBorder(c, cellIdx)) {
    const capitals = c.provinces.map((p) => ({ x: p.cx, z: p.cz }))
    const step = Math.max(mpp * 1.5, 3)
    const p = nearestCapital(c.seed, capitals, x, z)
    if (nearestCapital(c.seed, capitals, x + step, z) !== p || nearestCapital(c.seed, capitals, x, z + step) !== p) {
      col = col.map((v, k) => v * 0.25 + BORDER[k] * 0.75)
    }
  }
  out[o] = col[0]
  out[o + 1] = col[1]
  out[o + 2] = col[2]
  out[o + 3] = 255
}

function nearLake(c: Continent, cell: number): boolean {
  const n = c.n
  for (const d of [-1, 1, -n, n, -n - 1, -n + 1, n - 1, n + 1]) {
    const k = cell + d
    if (k >= 0 && k < n * n && c.water[k] === Water.Lake) return true
  }
  return false
}

function nearBorder(c: Continent, cell: number): boolean {
  const n = c.n
  const p = c.province[cell]
  for (const d of [-1, 1, -n, n, -n - 1, -n + 1, n - 1, n + 1]) {
    const k = cell + d
    if (k >= 0 && k < n * n && c.province[k] >= 0 && p >= 0 && c.province[k] !== p) return true
  }
  return false
}
