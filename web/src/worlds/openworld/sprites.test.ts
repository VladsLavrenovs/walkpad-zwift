import { beforeAll, describe, expect, it } from 'vitest'
import { type Continent, Water, cellAt, generateContinent } from './continent'
import { Ground } from './ground'
import { FAR_BLOCK, SPRITE_TREES, farBlockTrees } from './sprites'

let c: Continent
let g: Ground

beforeAll(() => {
  c = generateContinent(2024)
  g = new Ground(c)
}, 30_000)

describe('the far sprite forest', () => {
  it('is the same every time, on dry land, off roads and out of towns', () => {
    const n = WORLD_BLOCKS()
    let total = 0
    for (let bz = 0; bz < n; bz += 3) {
      for (let bx = 0; bx < n; bx += 3) {
        const trees = farBlockTrees(c, g, bx, bz)
        total += trees.length
        for (const t of trees) {
          expect(SPRITE_TREES).toContain(t.kind)
          expect(c.water[cellAt(c, t.x, t.z)]).toBe(Water.Land)
          expect(g.roads.nearest(t.x, t.z).edge).toBeGreaterThanOrEqual(3)
          expect(g.town(t.x, t.z).weight).toBeLessThanOrEqual(0.3)
          expect(t.x).toBeGreaterThanOrEqual(bx * FAR_BLOCK)
          expect(t.x).toBeLessThan((bx + 1) * FAR_BLOCK)
        }
      }
    }
    expect(total).toBeGreaterThan(1000)
    expect(farBlockTrees(c, g, 9, 9)).toEqual(farBlockTrees(c, g, 9, 9))
  })

  it('forests are dense, farmland sparse', () => {
    let forest = 0
    let fields = 0
    for (let bz = 0; bz < WORLD_BLOCKS(); bz++) {
      for (let bx = 0; bx < WORLD_BLOCKS(); bx++) {
        for (const t of farBlockTrees(c, g, bx, bz)) {
          const b = c.biome[cellAt(c, t.x, t.z)]
          if (b === 0) forest++
          if (b === 3) fields++
        }
      }
    }
    expect(forest).toBeGreaterThan(fields * 5)
  }, 30_000)
})

function WORLD_BLOCKS(): number {
  return Math.ceil(10_000 / FAR_BLOCK)
}
