import { describe, expect, it } from 'vitest'
import { GENERATOR_VERSION, biomeWeightsAt, generateContinent } from './index'
import { decodeSnapshot, encodeSnapshot } from './snapshot'

describe('saved world snapshots', () => {
  it('round-trip: the saved world is the generated one (heights to 10 cm), and compact', async () => {
    const c = generateContinent(7)
    const bytes = await encodeSnapshot(c, GENERATOR_VERSION)
    expect(bytes.length).toBeLessThan(4_000_000)
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]) // gzip, as the bridge expects
    const { continent: back, generatorVersion } = await decodeSnapshot(bytes)
    expect(generatorVersion).toBe(GENERATOR_VERSION)
    expect(back.seed).toBe(7)
    expect(back.water).toEqual(c.water)
    expect(back.biome).toEqual(c.biome)
    expect(back.province).toEqual(c.province)
    expect(back.places).toEqual(c.places)
    expect(back.provinces).toEqual(c.provinces)
    expect(back.roads.length).toBe(c.roads.length)
    expect(back.rivers.map((r) => r.cells)).toEqual(c.rivers.map((r) => r.cells))
    let worst = 0
    for (let i = 0; i < c.height.length; i++) worst = Math.max(worst, Math.abs(back.height[i] - c.height[i]))
    expect(worst).toBeLessThanOrEqual(0.05)
    // What the map and the 3D world read from it matches.
    for (const [x, z] of [[5000, 5000], [3200, 6100], [7400, 2900]]) {
      const a = biomeWeightsAt(c, x, z)
      const b = biomeWeightsAt(back, x, z)
      for (const k of Object.keys(a) as (keyof typeof a)[]) expect(b[k]).toBeCloseTo(a[k], 1)
    }
  }, 20_000) // generates a whole continent, then compresses it

  it('refuses something that is not a world snapshot', async () => {
    const junk = new Uint8Array(await new Response(
      new Blob([new TextEncoder().encode('hello world')]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer())
    await expect(decodeSnapshot(junk)).rejects.toThrow('not a WalkPad world snapshot')
  })
})
