import { describe, expect, it } from 'vitest'
import {
  BIOMES,
  BLEND_M,
  CLIFF_M,
  PATH_HALF_WIDTH_M,
  RIVER,
  START_BIOMES,
  TrailPath,
  biomePlan,
  biomeWeights,
  dominantBiome,
  fieldPatch,
  groundHeight,
  house,
  hourOfDay,
  nightness,
  noise2,
  rainAt,
  rng,
  scatter,
  structures,
  waterfalls,
} from './gen'

describe('seeded generation', () => {
  it('is deterministic per seed', () => {
    expect([rng(7)(), rng(7)()]).toEqual([rng(7)(), rng(7)()])
    expect(rng(7)()).not.toBe(rng(8)())
    expect(noise2(1, 3.3, 4.4)).toBe(noise2(1, 3.3, 4.4))
    for (let i = 0; i < 200; i++) {
      const v = noise2(5, i * 0.37, i * 0.11)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('the same trail looks the same every time', () => {
    const a = new TrailPath(42)
    const b = new TrailPath(42)
    expect(b.pose(2345.6)).toEqual(a.pose(2345.6))
    const plan = biomePlan(42, 20_000, 20_000)
    expect(scatter(42, 17, 680, 720, plan, 1)).toEqual(scatter(42, 17, 680, 720, plan, 1))
    expect(scatter(43, 17, 680, 720, biomePlan(43, 20_000, 20_000), 1)).not.toEqual(scatter(42, 17, 680, 720, plan, 1))
  })
})

describe('TrailPath', () => {
  const path = new TrailPath(1234)

  it('winds gently and never turns back', () => {
    let maxHeading = 0
    for (let s = 0; s < 20_000; s += 7) maxHeading = Math.max(maxHeading, Math.abs(path.headingAt(s)))
    expect(maxHeading).toBeLessThan(0.62) // under ~35 degrees off the main direction
    expect(path.pose(10_000).z).toBeGreaterThan(8_500) // keeps heading forward
  })

  it('is continuous: 1 m along the trail moves about 1 m', () => {
    for (let s = 0; s < 3000; s += 37.3) {
      const a = path.pose(s)
      const b = path.pose(s + 1)
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(1, 2)
      expect(Math.abs(b.heading - a.heading)).toBeLessThan(0.02)
    }
  })

  it('reaches far positions without errors', () => {
    const far = path.pose(45_000)
    expect(Number.isFinite(far.x) && Number.isFinite(far.z)).toBe(true)
  })
})

describe('biomes', () => {
  it('a trail ends in the neon city; other biomes do not repeat back to back', () => {
    const plan = biomePlan(9, 30_000, 30_000)
    expect(plan[0].biome).toBe('forest')
    expect(plan.at(-1)!.biome).toBe('city')
    expect(plan.at(-1)!.start).toBeCloseTo(30_000 - 4500, 0) // 15 % of 30 km
    for (let i = 1; i < plan.length - 1; i++) expect(plan[i].biome).not.toBe(plan[i - 1].biome)
    for (const sp of plan.slice(0, -1)) expect(sp.end - sp.start).toBeLessThanOrEqual(4500)
  })

  it('a short trail still gets the city at the end', () => {
    const plan = biomePlan(9, 2000, 2000)
    expect(plan.map((p) => p.biome)).toEqual(['forest', 'city'])
    expect(plan[1].start).toBe(500)
  })

  it('blends across borders with weights summing to 1', () => {
    const plan = biomePlan(3, 40_000, 40_000)
    const border = plan[0].end
    for (const s of [border - BLEND_M, border - 50, border, border + 50, border + BLEND_M]) {
      const w = biomeWeights(plan, s)
      expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    }
    expect(dominantBiome(biomeWeights(plan, border - BLEND_M))).toBe(plan[0].biome)
    expect(dominantBiome(biomeWeights(plan, border + BLEND_M))).toBe(plan[1].biome)
    const mid = biomeWeights(plan, border)
    expect(mid[plan[0].biome]).toBeCloseTo(0.5, 1)
  })

  it('free walking (no trail length) also visits the city now and then', () => {
    const plan = biomePlan(11, null, 400_000)
    expect(plan.some((p) => p.biome === 'city')).toBe(true)
    expect(plan.at(-1)!.end).toBeGreaterThan(0)
  })
})

describe('scatter', () => {
  const plan = biomePlan(5, 50_000, 50_000)

  it('keeps props off the path and follows the quality density', () => {
    const full = scatter(5, 3, 120, 160, plan, 1)
    const low = scatter(5, 3, 120, 160, plan, 0.38)
    expect(full.length).toBeGreaterThan(30)
    expect(low.length).toBeLessThan(full.length * 0.6)
    for (const p of full) expect(Math.abs(p.lateral)).toBeGreaterThan(2)
  })

  it('uses the props of the biome at that point', () => {
    const forest = scatter(5, 3, 120, 160, plan, 1)
    expect(forest.some((p) => p.kind === 'pine')).toBe(true)
    expect(forest.some((p) => p.kind === 'tower')).toBe(false)
    const cityStart = plan.at(-1)!.start
    const city = scatter(5, 999, cityStart + 1000, cityStart + 1040, plan, 1)
    expect(city.some((p) => p.kind === 'tower')).toBe(true)
    expect(city.some((p) => p.kind === 'pine')).toBe(false)
  })
})

describe('weather and time', () => {
  it('rain comes in zones and stays light', () => {
    const plan = biomePlan(21, 60_000, 60_000)
    let wet = 0
    for (let s = 0; s < 60_000; s += 100) {
      const r = rainAt(21, s, biomeWeights(plan, s))
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1.6)
      if (r > 0) wet++
    }
    expect(wet).toBeGreaterThan(30) // some rain
    expect(wet).toBeLessThan(450) // but mostly dry
  })

  it('day/night: the accelerated cycle and real time', () => {
    expect(hourOfDay('cycle', 0, 9)).toBe(9)
    expect(hourOfDay('cycle', 60_000, 9)).toBeCloseTo(10, 6) // 1 minute = 1 hour
    expect(hourOfDay('cycle', 15 * 60_000, 9)).toBeCloseTo(0, 6)
    const noonLocal = new Date(2026, 9, 1, 12, 30).getTime()
    expect(hourOfDay('real', noonLocal)).toBeCloseTo(12.5, 6)
    expect(nightness(12)).toBe(0)
    expect(nightness(0)).toBe(1)
    expect(nightness(6.5)).toBeGreaterThan(0)
    expect(nightness(6.5)).toBeLessThan(1)
  })
})

describe('around the start', () => {
  it('the path continues straight back before position 0, where the camera sits', () => {
    const path = new TrailPath(77)
    const start = path.pose(0)
    const behind = path.pose(-20)
    expect(Math.hypot(behind.x - start.x, behind.z - start.z)).toBeCloseTo(20, 6)
    expect(behind.heading).toBeCloseTo(start.heading, 9)
    expect(dominantBiome(biomeWeights(biomePlan(77, 5000, 5000), -50))).toBe('forest') // not the city
  })
})

describe('a varied world', () => {
  it('a long trail visits every biome, in sensible order', () => {
    const plan = biomePlan(4242, 60_000, 60_000)
    for (const b of BIOMES) expect(plan.some((p) => p.biome === b), b).toBe(true)
    for (let i = 1; i < plan.length - 1; i++) {
      // A castle town or a village never opens straight onto a gorge, and vice versa.
      const pair = [plan[i - 1].biome, plan[i].biome].sort().join('-')
      expect(['castle-falls', 'falls-village'], pair).not.toContain(pair)
    }
  })

  it('the waterfall valley has cliffs either side and a river bed below the water, the path stays flat', () => {
    const w = biomeWeights([{ biome: 'falls', start: 0, end: Number.POSITIVE_INFINITY }], 100)
    for (const x of [0, 100, 250]) {
      expect(groundHeight(7, x, 500, 0, w)).toBe(0)
      expect(groundHeight(7, x, 500, CLIFF_M + 20, w)).toBeGreaterThan(12)
      expect(groundHeight(7, x, 500, -(CLIFF_M + 20), w)).toBeGreaterThan(12)
      expect(groundHeight(7, x, 500, (RIVER.lat0 + RIVER.lat1) / 2, w)).toBeLessThan(RIVER.level)
    }
    const plan = biomePlan(4242, 60_000, 60_000)
    const falls = plan.find((p) => p.biome === 'falls')!
    const list = waterfalls(4242, plan, falls.start + 300, falls.start + 1300)
    expect(list.length).toBeGreaterThan(5)
    expect(waterfalls(4242, plan, 0, 900)).toEqual([]) // forest
  })

  it('farm fields are a patchwork, and crops grow only in their own field', () => {
    const patches = new Set<string>()
    for (let s = 0; s < 2000; s += 7) patches.add(String(fieldPatch(3, s, 30)))
    expect(patches.size).toBeGreaterThanOrEqual(4)
    expect(fieldPatch(3, 100, 1)).toBeNull() // the road
    const plan = [{ biome: 'fields' as const, start: 0, end: Number.POSITIVE_INFINITY }]
    for (const p of scatter(3, 5, 200, 240, plan, 1)) {
      if (p.kind === 'wheat') expect(fieldPatch(3, p.s, p.lateral)).toBe('wheat')
      if (p.kind === 'lavender') expect(fieldPatch(3, p.s, p.lateral)).toBe('lavender')
    }
  })
})

describe('buildings', () => {
  const plan = biomePlan(4242, 20_000, 20_000)
  const village = plan.find((p) => p.biome === 'village')!
  const castle = plan.find((p) => p.biome === 'castle')!

  it('are deterministic', () => {
    expect(structures(4242, plan, village.start, village.start + 400)).toEqual(structures(4242, plan, village.start, village.start + 400))
  })

  it('village houses line the road, off it, facing it', () => {
    const houses = structures(4242, plan, village.start + 200, village.end - 200).filter((s) => s.kind === 'house')
    expect(houses.length).toBeGreaterThan(20)
    for (const h of houses) {
      const f = h.foot!
      expect(f.lat0 > PATH_HALF_WIDTH_M || f.lat1 < -PATH_HALF_WIDTH_M).toBe(true)
      expect(h.yaw).toBeCloseTo((-Math.sign(h.lateral) * Math.PI) / 2, 9)
    }
  })

  it('a house has a door at the front, a roof, and no windows at the back', () => {
    const pieces = house(rng(5), { W: 6, D: 6, floors: 2, stone: 'ground' })
    expect(pieces.some((p) => p.model.includes('Door') && p.z === 3)).toBe(true)
    expect(pieces.some((p) => p.model === 'Roof_RoundTiles_6x6')).toBe(true)
    expect(pieces.filter((p) => p.z === -3 && p.model.includes('Window'))).toEqual([])
  })

  it('a castle town has a gate across the road and a walled castle beside it', () => {
    const parts = structures(4242, plan, castle.start, castle.end)
    expect(parts.some((s) => s.kind === 'gate' && s.lateral === 0)).toBe(true)
    expect(parts.some((s) => s.kind === 'keep')).toBe(true)
    expect(parts.filter((s) => s.kind === 'wall').length).toBeGreaterThan(60)
    expect(parts.filter((s) => s.kind === 'tower').length).toBeGreaterThanOrEqual(6)
  })

  it('props keep out of buildings', () => {
    const s0 = village.start + 400
    const avoid = structures(4242, plan, s0 - 70, s0 + 110).filter((s) => s.foot).map((s) => s.foot!)
    expect(avoid.length).toBeGreaterThan(5)
    for (const p of scatter(4242, 1, s0, s0 + 40, plan, 1, avoid)) {
      for (const f of avoid) expect(p.s >= f.s0 && p.s <= f.s1 && p.lateral >= f.lat0 && p.lateral <= f.lat1).toBe(false)
    }
  })
})

describe('starting somewhere else', () => {
  it('a trail can start in any biome but the city, and still ends in the city', () => {
    for (const start of START_BIOMES) {
      const plan = biomePlan(12, 10_000, 10_000, start)
      expect(plan[0].biome).toBe(start)
      expect(plan.at(-1)!.biome).toBe('city')
      expect(dominantBiome(biomeWeights(plan, 0))).toBe(start)
    }
    // The default stays the forest, so existing trails keep their scenery.
    expect(biomePlan(12, 10_000, 10_000)).toEqual(biomePlan(12, 10_000, 10_000, 'forest'))
  })

  it('a castle-town start puts the town gate a short walk ahead', () => {
    const plan = biomePlan(12, 10_000, 10_000, 'castle')
    const gate = structures(12, plan, 0, plan[0].end).find((s) => s.kind === 'gate' && s.lateral === 0)
    expect(gate!.s).toBeLessThan(300)
  })
})
