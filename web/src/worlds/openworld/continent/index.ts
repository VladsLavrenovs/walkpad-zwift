/**
 * Generate a continent from a seed (see types.ts): terrain, water, climate and biomes, places,
 * provinces and roads. Deterministic and pure: the same seed gives the same world, in a Web
 * Worker on the page and in node for the tests.
 */

import { type OwWeights, biomeWeightsFrom, buildMoisture } from './climate'
import { buildHydrology } from './hydro'
import { buildProvinces, placePlaces } from './places'
import { buildRoads } from './roads'
import { blur, buildHeights, buildSlopes, loreAt } from './terrain'
import { type Continent, OW_BIOMES, WORLD_M, Water } from './types'

export * from './types'
export { biomeWeightsFrom, type OwWeights } from './climate'

export const GRID_N = 512

export function generateContinent(seed: number, n = GRID_N): Continent {
  const cell = WORLD_M / n
  const t: Record<string, number> = {}
  const step = <T>(name: string, fn: () => T): T => {
    const t0 = performance.now()
    const out = fn()
    t[`${name}_ms`] = Math.round(performance.now() - t0)
    return out
  }
  const { height, seaShift } = step('terrain', () => buildHeights(seed, n))
  const slope = blur(buildSlopes(height, n, cell), n)
  const hydro = step('water', () => buildHydrology(height, n, cell))
  const moisture = step('climate', () => buildMoisture(seed, hydro.water, height, n))
  const lore = new Float32Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) lore[j * n + i] = loreAt(seed, (i + 0.5) / n, (j + 0.5) / n)
  const biome = step('biomes', () => {
    const out = new Uint8Array(n * n).fill(255)
    for (let c = 0; c < n * n; c++) {
      if (hydro.water[c] !== Water.Land && hydro.water[c] !== Water.River) continue
      const w = biomeWeightsFrom(height[c], slope[c], moisture[c], lore[c])
      let best = 0
      for (let b = 1; b < OW_BIOMES.length; b++) if (w[OW_BIOMES[b]] > w[OW_BIOMES[best]]) best = b
      out[c] = best
    }
    return out
  })
  const { places, mainland } = step('places', () =>
    placePlaces({ seed, n, cell, height, slope, water: hydro.water, moisture, lore, waterfalls: hydro.waterfalls }))
  const { province, provinces } = step('provinces', () => buildProvinces(seed, n, cell, hydro.water, places))
  const roads = step('roads', () => buildRoads(n, cell, slope, hydro.water, mainland, places))
  let landCells = 0
  for (let c = 0; c < n * n; c++) if (hydro.water[c] !== Water.Sea) landCells++
  return {
    seed, n, cell, seaShift, height, slope, moisture, lore, biome, province, provinces, places, roads,
    surface: hydro.surface, water: hydro.water, flow: hydro.flow, down: hydro.down,
    rivers: hydro.rivers, waterfalls: hydro.waterfalls,
    stats: {
      ...t,
      land_pct: Math.round((100 * landCells) / (n * n)),
      rivers: hydro.rivers.length,
      lakes: countLakes(hydro.water, n),
      waterfalls: hydro.waterfalls.length,
      places: places.length,
      roads: roads.length,
    },
  }
}

function countLakes(water: Uint8Array, n: number): number {
  const seen = new Uint8Array(n * n)
  let count = 0
  for (let c = 0; c < n * n; c++) {
    if (seen[c] || water[c] !== Water.Lake) continue
    count++
    const stack = [c]
    seen[c] = 1
    while (stack.length) {
      const a = stack.pop()!
      const i = a % n
      for (const nb of [i > 0 ? a - 1 : -1, i < n - 1 ? a + 1 : -1, a - n, a + n]) {
        if (nb < 0 || nb >= n * n || seen[nb] || water[nb] !== Water.Lake) continue
        seen[nb] = 1
        stack.push(nb)
      }
    }
  }
  return count
}

/** Bilinear sample of a cell field at (x, z) metres. */
export function sample(c: Continent, field: Float32Array, x: number, z: number): number {
  const gx = Math.min(c.n - 1.001, Math.max(0, x / c.cell - 0.5))
  const gz = Math.min(c.n - 1.001, Math.max(0, z / c.cell - 0.5))
  const i = Math.floor(gx)
  const j = Math.floor(gz)
  const fx = gx - i
  const fz = gz - j
  const k = j * c.n + i
  const a = field[k] + (field[k + 1] - field[k]) * fx
  const b = field[k + c.n] + (field[k + c.n + 1] - field[k + c.n]) * fx
  return a + (b - a) * fz
}

/** Biome weights at any point (smooth: the inputs are interpolated, then classified). */
export function biomeWeightsAt(c: Continent, x: number, z: number): OwWeights {
  return biomeWeightsFrom(sample(c, c.height, x, z), sample(c, c.slope, x, z), sample(c, c.moisture, x, z), sample(c, c.lore, x, z))
}

/** The cell index at (x, z), clamped to the map. */
export function cellAt(c: Continent, x: number, z: number): number {
  const i = Math.min(c.n - 1, Math.max(0, Math.floor(x / c.cell)))
  const j = Math.min(c.n - 1, Math.max(0, Math.floor(z / c.cell)))
  return j * c.n + i
}
