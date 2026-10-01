/**
 * Climate and biomes. Moisture comes from how far a cell is from water (rivers and lakes count
 * more than the sea) plus noise and altitude; biomes come from smooth scores of height, slope,
 * moisture and the "lore" field (old elven lands), normalised to weights. Smooth inputs, smooth
 * scores: biome borders blend instead of stepping, and new biomes are new score functions.
 */

import { fbm } from '../../fantasy/gen'
import { OW_BIOMES, type OwBiome, Water } from './types'

const sig = (t: number) => 1 / (1 + Math.exp(-t))

export type OwWeights = Record<OwBiome, number>

/** Biome weights from the four inputs (all continuous), summing to 1. */
export function biomeWeightsFrom(height: number, slope: number, moisture: number, lore: number): OwWeights {
  // Wide sigmoids: borders blend over tens of metres of walking, like a real tree line.
  const high = sig((height - 230) / 70)
  const steep = sig((slope - 0.42) / 0.16)
  const falls = Math.max(high, steep * 0.9) + 0.02
  const lowland = 1 - sig((height - 150) / 45)
  const elven = sig((lore - 0.7) / 0.06)
  const forest = sig((moisture - 0.42) / 0.1) * (1 - high) * (1 - steep * 0.6) * 1.05
  const meadow = sig((moisture - 0.62) / 0.09) * (1 - sig((height - 70) / 28)) * (1 - steep) * 1.15
  const fields = lowland * (1 - sig((slope - 0.11) / 0.05)) * sig((0.6 - moisture) / 0.11) * 1.1
  const raw: OwWeights = { forest: forest * (1 - elven * 0.8), ruins: forest * elven * 1.6, meadow, fields, falls }
  let sum = 0
  for (const b of OW_BIOMES) {
    raw[b] = raw[b] ** 2 // a little sharper, still continuous
    sum += raw[b]
  }
  for (const b of OW_BIOMES) raw[b] /= sum
  return raw
}

/** Moisture of every cell: distance to water (breadth first), noise, altitude. */
export function buildMoisture(seed: number, water: Uint8Array, height: Float32Array, n: number): Float32Array {
  const dist = new Float32Array(n * n).fill(Infinity)
  const queue = new Int32Array(n * n)
  let head = 0
  let tail = 0
  for (let c = 0; c < n * n; c++) {
    if (water[c] === Water.River || water[c] === Water.Lake) {
      dist[c] = 0
      queue[tail++] = c
    } else if (water[c] === Water.Sea) {
      dist[c] = 14 // the sea moistens less than fresh water (salt, wind)
      queue[tail++] = c
    }
  }
  // Breadth first with 4 neighbours (the sea's head start is approximate, which is fine).
  while (head < tail) {
    const c = queue[head++]
    const i = c % n
    const j = (c - i) / n
    const d = dist[c] + 1
    if (i > 0 && dist[c - 1] > d) { dist[c - 1] = d; queue[tail++] = c - 1 }
    if (i < n - 1 && dist[c + 1] > d) { dist[c + 1] = d; queue[tail++] = c + 1 }
    if (j > 0 && dist[c - n] > d) { dist[c - n] = d; queue[tail++] = c - n }
    if (j < n - 1 && dist[c + n] > d) { dist[c + n] = d; queue[tail++] = c + n }
    if (tail >= queue.length) break
  }
  const m = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const near = Math.exp(-dist[c] / 22)
      const noise = fbm(seed + 21, (i / n) * 6.1 + 1.7, (j / n) * 6.1 - 3.9, 4) * 0.5 + 0.5
      const alt = Math.min(0.15, Math.max(0, height[c] / 2000))
      m[c] = Math.min(1, Math.max(0, near * 0.55 + noise * 0.5 + alt - 0.05))
    }
  }
  return m
}
