import { beforeAll, describe, expect, it } from 'vitest'
import { type Continent, OW_BIOMES, WORLD_M, Water, biomeWeightsAt, cellAt, generateContinent, sample } from './index'
import { RIVER_FLOW } from './hydro'

const SEEDS = [1, 2024]
const worlds = new Map<number, Continent>()
const timings = new Map<number, number>()

beforeAll(() => {
  for (const seed of SEEDS) {
    const t0 = performance.now()
    worlds.set(seed, generateContinent(seed))
    timings.set(seed, performance.now() - t0)
  }
}, 30_000)

const isLandCell = (w: number) => w === Water.Land || w === Water.River

describe.each(SEEDS)('continent of seed %i', (seed) => {
  const world = () => worlds.get(seed)!

  it('is the same world every time for the same seed, another one for another seed', () => {
    const again = generateContinent(seed)
    const c = world()
    expect(again.height).toEqual(c.height)
    expect(again.places).toEqual(c.places)
    expect(again.roads).toEqual(c.roads)
    const other = worlds.get(SEEDS.find((s) => s !== seed)!)!
    expect(other.height).not.toEqual(c.height)
  })

  it('generates within a few seconds (it runs in a Web Worker on the page)', () => {
    expect(timings.get(seed)!).toBeLessThan(6000)
  })

  it('is an island: open sea all along the map edge, a fair share of land', () => {
    const c = world()
    for (let k = 0; k < c.n; k++) {
      for (const cell of [k, (c.n - 1) * c.n + k, k * c.n, k * c.n + c.n - 1]) expect(c.water[cell]).toBe(Water.Sea)
    }
    expect(c.stats.land_pct).toBeGreaterThan(40)
    expect(c.stats.land_pct).toBeLessThan(55)
  })

  it('rivers run downhill, from a source to the sea, a lake or another river', () => {
    const c = world()
    expect(c.rivers.length).toBeGreaterThan(20)
    for (const r of c.rivers) {
      for (let k = 1; k < r.cells.length; k++) {
        // The water surface never rises along a river.
        expect(c.surface[r.cells[k]]).toBeLessThanOrEqual(c.surface[r.cells[k - 1]] + 1e-3)
      }
      const mouth = r.cells[r.cells.length - 1]
      expect([Water.Sea, Water.Lake, Water.River]).toContain(c.water[mouth])
      expect(c.flow[r.cells[0]]).toBeGreaterThanOrEqual(RIVER_FLOW)
    }
  })

  it('lakes are flat and sit in hollows', () => {
    const c = world()
    const levels = new Map<number, number>()
    for (let cell = 0; cell < c.n * c.n; cell++) {
      if (c.water[cell] !== Water.Lake) continue
      expect(c.surface[cell]).toBeGreaterThanOrEqual(c.height[cell])
      // Neighbouring lake cells share one level (one lake = one flat surface).
      for (const nb of [cell + 1, cell + c.n]) {
        if (nb < c.n * c.n && c.water[nb] === Water.Lake) expect(c.surface[nb]).toBe(c.surface[cell])
      }
      levels.set(c.surface[cell], 1)
    }
    expect(c.stats.lakes).toBeGreaterThan(3)
  })

  it('waterfalls are on rivers, where the ground drops (some straight into the sea off a cliff)', () => {
    const c = world()
    expect(c.waterfalls.length).toBeGreaterThan(3)
    const riverCells = new Set(c.rivers.flatMap((r) => r.cells))
    for (const f of c.waterfalls) {
      expect(f.drop).toBeGreaterThanOrEqual(6)
      const near = [-1, 0, 1].some((dj) => [-1, 0, 1].some((di) => riverCells.has(cellAt(c, f.x + di * c.cell, f.z + dj * c.cell))))
      expect(near, `waterfall at ${Math.round(f.x)},${Math.round(f.z)}`).toBe(true)
    }
  })

  it('every settlement is on land and off the water, and all towns and castles are linked by roads', () => {
    const c = world()
    const kinds = new Set(c.places.map((p) => p.kind))
    for (const k of ['city', 'village', 'castle', 'ruins']) expect(kinds.has(k as never), k).toBe(true)
    for (const p of c.places.filter((q) => q.kind !== 'waterfall')) {
      expect(c.water[cellAt(c, p.x, p.z)], p.name).toBe(Water.Land)
      expect(p.x > 0 && p.x < WORLD_M && p.z > 0 && p.z < WORLD_M).toBe(true)
    }
    // Every road endpoint is a place, and the road graph connects every city, village and castle.
    const towns = c.places.filter((p) => p.kind === 'city' || p.kind === 'village' || p.kind === 'castle').map((p) => p.id)
    const links = new Map(towns.map((t) => [t, new Set<string>()]))
    for (const r of c.roads) {
      links.get(r.from)!.add(r.to)
      links.get(r.to)!.add(r.from)
    }
    const reached = new Set([towns[0]])
    const queue = [towns[0]]
    while (queue.length) for (const next of links.get(queue.shift()!)!) if (!reached.has(next)) reached.add(next) && queue.push(next)
    expect(reached.size).toBe(towns.length)
    // Names are unique.
    expect(new Set(c.places.map((p) => p.name)).size).toBe(c.places.length)
  })

  it('provinces cover all the land, each named after its capital', () => {
    const c = world()
    for (let cell = 0; cell < c.n * c.n; cell++) {
      if (isLandCell(c.water[cell])) expect(c.province[cell]).toBeGreaterThanOrEqual(0)
      else expect(c.province[cell]).toBe(-1)
    }
    for (const p of c.provinces) {
      const capital = c.places.find((q) => q.id === p.capital)!
      expect(p.name).toContain(capital.name.replace(/^Castle /, ''))
    }
  })

  it('biomes blend smoothly: weights sum to 1 and change gradually metre by metre', () => {
    const c = world()
    const counts = Object.fromEntries(OW_BIOMES.map((b) => [b, 0]))
    for (let cell = 0; cell < c.n * c.n; cell++) if (c.biome[cell] !== 255) counts[OW_BIOMES[c.biome[cell]]]++
    for (const b of OW_BIOMES) expect(counts[b], b).toBeGreaterThan(0) // every biome exists
    // Walk straight lines across the whole map in 1 m steps, on land (biomes mean nothing at sea).
    const steps: number[] = []
    for (let line = 0; line < 12; line++) {
      const z = 1500 + line * 600
      let prev = biomeWeightsAt(c, 1000, z)
      for (let x = 1001; x <= 9000; x++) {
        const w = biomeWeightsAt(c, x, z)
        const onLand = sample(c, c.height, x, z) > 0.5
        let sum = 0
        let most = 0
        for (const b of OW_BIOMES) {
          sum += w[b]
          most = Math.max(most, Math.abs(w[b] - prev[b]))
        }
        expect(sum).toBeCloseTo(1, 6)
        if (onLand) steps.push(most)
        prev = w
      }
    }
    steps.sort((a, b) => a - b)
    // Borders take tens of metres to cross; only the odd steep mountain edge (rock taking over
    // a cliff) is quicker, and still no step at all.
    expect(steps[Math.floor(steps.length * 0.999)]).toBeLessThan(0.03)
    expect(steps[steps.length - 1]).toBeLessThan(0.12)
  })
})

describe('more seeds: the essentials hold for any world', () => {
  it.each([7, 42, 31337, 555])('seed %i: island, every town on the road network', (seed) => {
    const c = generateContinent(seed)
    for (let k = 0; k < c.n; k++) expect(c.water[k]).toBe(Water.Sea)
    const towns = c.places.filter((p) => p.kind === 'city' || p.kind === 'village' || p.kind === 'castle').map((p) => p.id)
    const links = new Map(towns.map((t) => [t, new Set<string>()]))
    for (const r of c.roads) {
      links.get(r.from)!.add(r.to)
      links.get(r.to)!.add(r.from)
    }
    const reached = new Set([towns[0]])
    const queue = [towns[0]]
    while (queue.length) for (const next of links.get(queue.shift()!)!) if (!reached.has(next)) reached.add(next) && queue.push(next)
    expect(reached.size).toBe(towns.length)
  })
})
