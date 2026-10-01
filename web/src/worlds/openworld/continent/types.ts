/**
 * The open world's continent: one seeded, finite map (WORLD_M square), computed once on a grid
 * of n x n cells. Coordinates are metres: x to the east, z to the north, both in [0, WORLD_M].
 * Cell (i, j) has index j * n + i and its centre at ((i + 0.5) * cell, (j + 0.5) * cell).
 */

export const WORLD_M = 10_000
export const SEA_LEVEL = 0

/** The biomes of the open world (ids match the fantasy world's, so its props and colours fit). */
export const OW_BIOMES = ['forest', 'ruins', 'meadow', 'fields', 'falls'] as const
export type OwBiome = (typeof OW_BIOMES)[number]
export const OW_BIOME_NAMES: Record<OwBiome, string> = {
  forest: 'Dark forest',
  ruins: 'Elven ruins',
  meadow: 'Lakeside meadows',
  fields: 'Farmlands',
  falls: 'Highlands',
}

/** What covers a cell. */
export const Water = { Land: 0, Sea: 1, Lake: 2, River: 3 } as const

export type PlaceKind = 'city' | 'village' | 'castle' | 'ruins' | 'windmill' | 'waterfall'

export interface Place {
  id: string
  kind: PlaceKind
  name: string
  x: number
  z: number
  /** Province index, or -1. */
  province: number
}

export interface River {
  /** Grid cells from the source down to the mouth (sea, lake, or a bigger river). */
  cells: number[]
  /** A smooth curve through them (metres), for drawing. */
  points: [number, number][]
  /** Upstream area along `points`, in cells (width grows with it). */
  flow: number[]
}

export interface Waterfall {
  x: number
  z: number
  /** Height of the drop, metres. */
  drop: number
}

export interface Road {
  from: string
  to: string
  points: [number, number][]
  /** Where the road crosses a river. */
  bridges: [number, number][]
}

export interface Province {
  id: number
  name: string
  capital: string
  /** The capital's position: provinces are the land nearest to it (warped). */
  cx: number
  cz: number
  /** Where its label goes (the middle of its land). */
  x: number
  z: number
}

export interface Continent {
  seed: number
  n: number
  /** Metres per cell. */
  cell: number
  /** Continentalness above this is land (elevationAt needs it to sample between cells). */
  seaShift: number
  /** Ground height, metres (negative under the sea). */
  height: Float32Array
  /** Water surface where there is water (lakes are flat), else the ground. */
  surface: Float32Array
  water: Uint8Array
  /** Upstream area in cells (rain-weighted). */
  flow: Float32Array
  /** Index of the cell each cell drains into, or -1 (sea). */
  down: Int32Array
  moisture: Float32Array
  /** Slope (rise over run) of the ground. */
  slope: Float32Array
  /** A slow noise field in [0, 1] that marks old elven lands. */
  lore: Float32Array
  /** Index into OW_BIOMES of the strongest biome (land), 255 for water. */
  biome: Uint8Array
  /** Province of each land cell, -1 for water. */
  province: Int16Array
  rivers: River[]
  waterfalls: Waterfall[]
  places: Place[]
  provinces: Province[]
  roads: Road[]
  /** Milliseconds per step, and a few counts, for the map page. */
  stats: Record<string, number>
}
