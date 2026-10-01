/**
 * Plants and rocks of one terrain tile: the fantasy world's prop tables (counts along a path)
 * turned into densities per square metre, each biome's share decided by the biome weights at the
 * spot. Crops grow in field patches, nothing grows on roads, in water or in buildings, and towns
 * have fewer wild trees. Seeded per tile: the same tile always grows the same.
 */

import { PROPS, type PropKind, SMALL_PLANTS, hashInts, rng } from '../fantasy/gen'
import { OW_BIOMES } from './continent'
import type { Ground } from './ground'

export interface Plant {
  kind: PropKind
  x: number
  z: number
  scale: number
  rotation: number
  tint: number
}

/** Kinds that only make sense in towns or on a road side (placed by towns.ts instead). */
const TOWN_ONLY = new Set<PropKind>(['fence', 'wagon', 'crate', 'barrel', 'stall', 'well', 'lamp', 'strip', 'tower', 'neon', 'arch', 'pillar'])
const TREES = new Set<PropKind>(['pine', 'oak', 'birch', 'deadtree'])
const PATCHES = ['wheat', 'wheat', 'green', 'plough', 'lavender', 'pasture', 'wheat', 'pasture'] as const
const CROP: Partial<Record<PropKind, string[]>> = {
  wheat: ['wheat'], cabbage: ['green'], lavender: ['lavender'], haybale: ['pasture', 'plough'],
}

/** Farm field at a point: a patchwork of ~40 x 30 m fields, a little skewed. */
export function fieldAt(seed: number, x: number, z: number): (typeof PATCHES)[number] {
  const i = Math.floor(x / 42 + z / 210)
  const j = Math.floor(z / 31 - x / 260)
  return PATCHES[hashInts(seed, 33, i, j) % PATCHES.length]
}

/** Per biome: [kind, plants per m2] from the trail tables (count per 100 m over both sides). */
const DENSITY = Object.fromEntries(OW_BIOMES.map((b) => [b, PROPS[b]
  .filter(([kind]) => !TOWN_ONLY.has(kind))
  .map(([kind, per100, [lo, hi]]) => [kind, per100 / (100 * 2 * (hi - lo))] as const)]))

export function plantTile(
  ground: Ground, seed: number, x0: number, z0: number, size: number, density: number, smallDensity: number,
  blocked: (x: number, z: number) => boolean,
): Plant[] {
  const r = rng(hashInts(seed, 501, Math.floor(x0), Math.floor(z0)))
  const out: Plant[] = []
  const area = size * size
  for (const biome of OW_BIOMES) {
    for (const [kind, perM2] of DENSITY[biome]) {
      const small = SMALL_PLANTS.includes(kind)
      const expected = perM2 * area * (small ? smallDensity : density)
      const n = Math.floor(expected) + (r() < expected % 1 ? 1 : 0)
      for (let i = 0; i < n; i++) {
        const x = x0 + r() * size
        const z = z0 + r() * size
        const scale = 0.7 + r() * 0.7
        const rotation = r() * Math.PI * 2
        const tint = r()
        const keep = r()
        const w = ground.biomes(x, z)
        if (keep > w[biome]) continue
        if (biome === 'fields' && CROP[kind] && !CROP[kind]!.includes(fieldAt(seed, x, z))) continue
        const town = ground.town(x, z).weight
        if (TREES.has(kind) && keep > 1 - town * 0.9) continue
        const h = ground.height(x, z)
        if (h < 0.3 || ground.water(x, z, h)) continue
        if (ground.roads.nearest(x, z).edge < (TREES.has(kind) ? 2.5 : 0.8)) continue
        if (TREES.has(kind) && Math.abs(ground.height(x + 2, z) - h) > 1.6) continue // not on cliffs
        if (blocked(x, z)) continue
        out.push({ kind, x, z, scale, rotation, tint })
      }
    }
  }
  return out
}
