import { beforeAll, describe, expect, it } from 'vitest'
import { keyAction } from '../../controls'
import { type Continent, Water, cellAt, generateContinent } from './continent'
import { fieldAt, plantTile } from './flora'
import { Ground } from './ground'
import { STEER_KEYS, step } from './movement'
import { type Towns, insideFoot, layoutTowns } from './towns'
import { spawn } from './world'

let c: Continent
let g: Ground
let towns: Towns

beforeAll(() => {
  c = generateContinent(2024)
  g = new Ground(c)
  towns = layoutTowns(c, g)
}, 30_000) // a whole continent and its towns

describe('open world ground', () => {
  it('is the same everywhere it is asked (tiles share their edges), and continuous', () => {
    for (const [x, z] of [[1234.5, 4321], [5000, 5000], [7777, 2222]]) expect(g.height(x, z)).toBe(g.height(x, z))
    // No steps along a long walk: 1 m apart, the ground never jumps more than a cliff allows.
    let worst = 0
    let prev = g.height(2000, 5000)
    for (let x = 2001; x < 8000; x++) {
      const h = g.height(x, 5000)
      worst = Math.max(worst, Math.abs(h - prev))
      prev = h
    }
    expect(worst).toBeLessThan(4)
  })

  it('towns are flat, rivers run in a channel, the sea and lakes are water', () => {
    const city = c.places.find((p) => p.kind === 'city')!
    const around = [0, 1, 2, 3].map((k) => g.height(city.x + Math.cos(k) * 30, city.z + Math.sin(k) * 30))
    expect(Math.max(...around) - Math.min(...around)).toBeLessThan(0.5)
    const r = c.rivers[0]
    const [x, z] = r.points[Math.floor(r.points.length / 2)]
    expect(g.height(x, z)).toBeLessThan(g.base(x, z) - 1)
    const sea = (() => {
      for (let i = 0; i < c.n; i++) if (c.water[i * c.n + 5] === Water.Sea) return [(5 + 0.5) * c.cell, (i + 0.5) * c.cell]
      return [50, 50]
    })()
    expect(g.water(sea[0], sea[1])?.kind).toBe('sea')
  })
})

describe('towns', () => {
  it('every city, village and castle gets buildings; houses are dry, off the roads, not overlapping', () => {
    for (const p of c.places.filter((q) => q.kind === 'city' || q.kind === 'village' || q.kind === 'castle')) {
      expect(towns.buildings.some((b) => b.place === p.id), p.name).toBe(true)
    }
    const houses = towns.buildings.filter((b) => b.kind === 'house')
    expect(houses.length).toBeGreaterThan(100)
    for (const h of houses) {
      expect(g.water(h.x, h.z)).toBeNull()
      expect(g.roads.nearest(h.x, h.z).edge).toBeGreaterThan(1)
    }
    for (let i = 0; i < houses.length; i++) {
      for (let j = i + 1; j < houses.length; j++) {
        if (Math.hypot(houses[i].x - houses[j].x, houses[i].z - houses[j].z) > 20) continue
        expect(insideFoot(houses[i].foot!, houses[j].x, houses[j].z)).toBe(false)
      }
    }
  })

  it('is the same town every time', () => {
    expect(layoutTowns(c, g).buildings.map((b) => [b.x, b.z, b.pieces.length])).toEqual(towns.buildings.map((b) => [b.x, b.z, b.pieces.length]))
  })
})

describe('plants', () => {
  it('grow by biome, off roads and out of water and buildings; crops in their fields', () => {
    const city = c.places.find((p) => p.kind === 'city')!
    const x0 = Math.floor(city.x / 64) * 64
    const z0 = Math.floor(city.z / 64) * 64
    const feet = towns.buildings.filter((b) => b.foot).map((b) => b.foot!)
    const plants = plantTile(g, c.seed, x0, z0, 64, 1, 1, (x, z) => feet.some((f) => insideFoot(f, x, z, 1)))
    for (const p of plants) {
      expect(g.water(p.x, p.z)).toBeNull()
      expect(feet.some((f) => insideFoot(f, p.x, p.z, 0.5))).toBe(false)
      if (p.kind === 'wheat') expect(fieldAt(c.seed, p.x, p.z)).toBe('wheat')
    }
    expect(plantTile(g, c.seed, x0, z0, 64, 1, 1, () => false)).toEqual(plantTile(g, c.seed, x0, z0, 64, 1, 1, () => false))
  })
})

describe('walking', () => {
  it('steering keys never overlap the belt keys', () => {
    for (const code of Object.keys(STEER_KEYS)) {
      const key = code.replace('Key', '').toLowerCase()
      expect(keyAction({ key, code, target: null, altKey: false, ctrlKey: false, metaKey: false } as never)).toBeNull()
    }
  })

  it('walks forward the metres walked, slides along a wall, stops when boxed in', () => {
    const free = step({ x: 0, z: 0, heading: 0 }, 2, () => false)
    expect(free).toEqual({ x: 0, z: 2, held: false })
    // A wall at a slant across the way: slide along it.
    const wall = (x: number, z: number) => z > 1 + x * 1.5
    const slid = step({ x: 0, z: 0, heading: 0 }, 3, wall)
    expect(slid.held).toBe(true)
    expect(Math.hypot(slid.x, slid.z)).toBeGreaterThan(1.5)
    expect(wall(slid.x, slid.z)).toBe(false)
    expect(step({ x: 0, z: 0, heading: 0 }, 3, () => true)).toEqual({ x: 0, z: 0, held: true })
    // Nearly head-on: no sideways escape, the walker stops (and the HUD says to turn).
    const headOn = step({ x: 0, z: 0, heading: 0 }, 3, (x, z) => z > 1 + x * 0.05)
    expect(headOn.held).toBe(true)
    expect(headOn.z).toBeLessThanOrEqual(1.05)
    expect(step({ x: 5, z: 5, heading: 1 }, 0, () => true)).toEqual({ x: 5, z: 5, held: false })
  })

  it('a new world starts in a city, on land', () => {
    const s = spawn(c)
    expect(c.places.some((p) => p.kind === 'city' && p.x === s.x && p.z === s.z)).toBe(true)
    expect(c.water[cellAt(c, s.x, s.z)]).toBe(Water.Land)
  })
})

describe('safety', () => {
  // Vite's own file import: the open world's source, as text.
  const sources = import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

  it('no open-world module can touch the belt', () => {
    const files = Object.entries(sources).filter(([name]) => !name.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(5)
    for (const [name, text] of files) {
      for (const call of ['bridge.start(', 'bridge.stop(', 'bridge.setSpeed(', '/control/']) expect(text.includes(call), `${name}: ${call}`).toBe(false)
    }
  })
})
