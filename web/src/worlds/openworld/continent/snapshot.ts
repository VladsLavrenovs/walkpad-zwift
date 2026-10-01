/**
 * A saved world: the generated continent frozen as it was, so later generator changes never
 * reshape a world someone walks in. Compact (about 1-2 MB gzip):
 *
 *   "WPW1" | u32 header length | header JSON | arrays, each 4-byte aligned   (all gzip'd)
 *
 * Heights are kept to 10 cm (Int16 decimetres), moisture and lore as bytes; the slope is
 * recomputed on load. Flow and drainage are not kept (rivers carry their own flow).
 * Typed arrays are little-endian (every platform this runs on).
 */

import { blur, buildSlopes } from './terrain'
import type { Continent } from './types'

const MAGIC = 'WPW1'
export const SNAPSHOT_VERSION = 1

type Kind = 'i16dm' | 'u8' | 'u8unit' | 'i16'

interface ArrayInfo {
  name: string
  kind: Kind
  offset: number
  length: number
}

type Header = Omit<Continent, 'height' | 'surface' | 'water' | 'flow' | 'down' | 'moisture' | 'slope' | 'lore' | 'biome' | 'province'> & {
  v: number
  gen: number
  arrays: ArrayInfo[]
}

const FIELDS: [keyof Continent, Kind][] = [
  ['height', 'i16dm'],
  ['surface', 'i16dm'],
  ['water', 'u8'],
  ['moisture', 'u8unit'],
  ['lore', 'u8unit'],
  ['biome', 'u8'],
  ['province', 'i16'],
]

function pack(values: ArrayLike<number>, kind: Kind): ArrayBufferView {
  const n = values.length
  if (kind === 'i16dm') {
    const out = new Int16Array(n)
    for (let i = 0; i < n; i++) out[i] = Math.max(-32767, Math.min(32767, Math.round(values[i] * 10)))
    return out
  }
  if (kind === 'u8unit') {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = Math.round(Math.max(0, Math.min(1, values[i])) * 255)
    return out
  }
  return kind === 'i16' ? Int16Array.from(values) : Uint8Array.from(values)
}

function round1(p: [number, number]): [number, number] {
  return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]
}

async function gzip(data: Uint8Array, mode: 'gzip' | 'gunzip'): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    mode === 'gzip' ? new CompressionStream('gzip') : new DecompressionStream('gzip'),
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The continent as snapshot bytes (gzip), and the generator version that made it. */
export async function encodeSnapshot(c: Continent, generatorVersion: number): Promise<Uint8Array> {
  const parts = FIELDS.map(([name, kind]) => ({ name, kind, data: pack(c[name] as ArrayLike<number>, kind) }))
  const arrays: ArrayInfo[] = []
  let offset = 0
  for (const p of parts) {
    arrays.push({ name: p.name, kind: p.kind, offset, length: (p.data as Int16Array).length })
    offset += Math.ceil(p.data.byteLength / 4) * 4
  }
  const header: Header = {
    v: SNAPSHOT_VERSION,
    gen: generatorVersion,
    seed: c.seed,
    n: c.n,
    cell: c.cell,
    seaShift: c.seaShift,
    rivers: c.rivers.map((r) => ({ cells: r.cells, points: r.points.map(round1), flow: r.flow.map(Math.round) })),
    waterfalls: c.waterfalls,
    places: c.places,
    provinces: c.provinces,
    roads: c.roads.map((r) => ({ ...r, points: r.points.map(round1), bridges: r.bridges.map(round1) })),
    stats: c.stats,
    arrays,
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const start = Math.ceil((8 + json.length) / 4) * 4
  const out = new Uint8Array(start + offset)
  out.set(new TextEncoder().encode(MAGIC), 0)
  new DataView(out.buffer).setUint32(4, json.length, true)
  out.set(json, 8)
  for (const [k, p] of parts.entries()) out.set(new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength), start + arrays[k].offset)
  return gzip(out, 'gzip')
}

/** A continent back from snapshot bytes, and which generator made it. */
export async function decodeSnapshot(bytes: Uint8Array): Promise<{ continent: Continent; generatorVersion: number }> {
  const raw = await gzip(bytes, 'gunzip')
  if (new TextDecoder().decode(raw.subarray(0, 4)) !== MAGIC) throw new Error('not a WalkPad world snapshot')
  const length = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + length))) as Header
  if (header.v !== SNAPSHOT_VERSION) throw new Error(`world snapshot version ${header.v} is not supported`)
  const start = Math.ceil((8 + length) / 4) * 4
  const fields: Record<string, ArrayLike<number>> = {}
  for (const a of header.arrays) {
    const at = raw.byteOffset + start + a.offset
    const buf = raw.buffer.slice(at, at + a.length * (a.kind === 'i16dm' || a.kind === 'i16' ? 2 : 1))
    fields[a.name] = a.kind === 'i16dm' || a.kind === 'i16' ? new Int16Array(buf) : new Uint8Array(buf)
  }
  const size = header.n * header.n
  const unpack = (name: string, kind: Kind): Float32Array => {
    const src = fields[name]
    const out = new Float32Array(size)
    for (let i = 0; i < size; i++) out[i] = kind === 'i16dm' ? src[i] / 10 : src[i] / 255
    return out
  }
  const height = unpack('height', 'i16dm')
  const { arrays: _arrays, v: _v, gen, ...rest } = header
  const continent: Continent = {
    ...rest,
    height,
    surface: unpack('surface', 'i16dm'),
    water: fields.water as Uint8Array,
    moisture: unpack('moisture', 'u8unit'),
    lore: unpack('lore', 'u8unit'),
    biome: fields.biome as Uint8Array,
    province: fields.province as Int16Array,
    slope: blur(buildSlopes(height, header.n, header.cell), header.n),
    flow: new Float32Array(size),
    down: new Int32Array(size).fill(-1),
  }
  return { continent, generatorVersion: gen }
}
