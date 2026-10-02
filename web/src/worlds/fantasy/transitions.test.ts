/**
 * Walking from one biome into the next must look gradual: nothing the world draws may jump
 * from one metre to the next. Checks every border of a few long trails, metre by metre.
 */
import { describe, expect, it } from 'vitest'
import { BIOMES, BLEND_M, TrailPath, biomePlan, biomeWeights, groundHeight, scatter, structures } from './gen'

const SEEDS = [4242, 7, 99]
const LENGTH = 20_000

describe('biome transitions while walking', () => {
  for (const seed of SEEDS) {
    const plan = biomePlan(seed, LENGTH, LENGTH)
    const path = new TrailPath(seed)
    const borders = plan.slice(1).map((sp) => sp.start)

    it(`seed ${seed}: biome weights change smoothly, never more than a smoothstep allows per metre`, () => {
      const maxStep = (1.5 / BLEND_M) * 1.01 // the steepest part of a smoothstep over BLEND_M
      let prev = biomeWeights(plan, 0)
      for (let s = 1; s <= LENGTH; s++) {
        const w = biomeWeights(plan, s)
        expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
        for (const b of BIOMES) expect(Math.abs(w[b] - prev[b]), `${b} at ${s} m`).toBeLessThanOrEqual(maxStep)
        prev = w
      }
    })

    it(`seed ${seed}: the ground never jumps (path, near, far, cliff tops)`, () => {
      for (const lateral of [0, 8, 14, 22, 30, 60, -22, -60]) {
        for (let s = 0; s < LENGTH; s += 1) {
          const p = path.side(s, lateral)
          const here = groundHeight(seed, p.x, p.z, lateral, biomeWeights(plan, s))
          if (lateral === 0) expect(Math.abs(here)).toBeLessThan(1e-9) // the path itself is always flat
          // The change the biome blend alone makes in one metre (same spot, next metre's mix):
          // cliffs, hollows and flattening for towns rise or sink gradually, never step.
          const blended = groundHeight(seed, p.x, p.z, lateral, biomeWeights(plan, s + 1))
          expect(Math.abs(blended - here), `lateral ${lateral} at ${s} m`).toBeLessThan(0.35)
        }
      }
    })

    it(`seed ${seed}: buildings appear and disappear gradually across borders`, () => {
      for (const border of borders) {
        if (border > LENGTH - 400) continue
        const built = (a: number) => structures(seed, plan, a, a + 40).filter((st) => st.kind === 'house').length
        let last = built(border - 200)
        for (let s = border - 160; s < border + 200; s += 40) {
          const now = built(s)
          expect(Math.abs(now - last), `houses near ${Math.round(border)}`).toBeLessThanOrEqual(6)
          last = now
        }
      }
    })
  }

  it('props of the old biome thin out in step with its weight (averaged over many chunks)', { timeout: 30_000 }, () => {
    const plan = [
      { biome: 'forest' as const, start: 0, end: 1000 },
      { biome: 'meadow' as const, start: 1000, end: Number.POSITIVE_INFINITY },
    ]
    const pinesPer25m = (s: number) => {
      let n = 0
      for (let chunk = 0; chunk < 400; chunk++) n += scatter(11, chunk, s, s + 25, plan, 1).filter((p) => p.kind === 'pine').length
      return n / 400
    }
    const full = pinesPer25m(600)
    expect(full).toBeGreaterThan(10)
    for (let s = 800; s <= 1200; s += 25) {
      const w = biomeWeights(plan, s + 12.5).forest
      expect(pinesPer25m(s) / full, `pines at ${s} m (forest weight ${w.toFixed(2)})`).toBeCloseTo(w, 1)
    }
    expect(pinesPer25m(1300)).toBe(0)
  })
})
