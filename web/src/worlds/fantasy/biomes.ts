/**
 * The fantasy world's biome names, on their own so the routes page can offer them without
 * loading the generator (gen.ts lives in the lazily loaded world chunk).
 */

export type Biome = 'forest' | 'ruins' | 'meadow' | 'fields' | 'village' | 'castle' | 'falls' | 'city'
export const BIOMES: Biome[] = ['forest', 'ruins', 'meadow', 'fields', 'village', 'castle', 'falls', 'city']
export const BIOME_NAMES: Record<Biome, string> = {
  forest: 'Dark forest',
  ruins: 'Misty elven ruins',
  meadow: 'Lakeside meadows',
  fields: 'Farmlands',
  village: 'Village',
  castle: 'Castle town',
  falls: 'Waterfall valley',
  city: 'Neon night city',
}

export type StartBiome = Exclude<Biome, 'city'>
/** The biomes a trail can start in (any but the city). */
export const START_BIOMES: StartBiome[] = ['forest', 'ruins', 'meadow', 'fields', 'village', 'castle', 'falls']

export function isStartBiome(value: unknown): value is StartBiome {
  return START_BIOMES.includes(value as StartBiome)
}

export function randomStartBiome(random = Math.random): StartBiome {
  return START_BIOMES[Math.floor(random() * START_BIOMES.length)]
}

/** A fresh seed for a new look. */
export function randomSeed(random = Math.random): number {
  return 1 + Math.floor(random() * (2 ** 31 - 2))
}
