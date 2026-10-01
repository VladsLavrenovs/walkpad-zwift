/**
 * Buildings of the open world, laid out from the continent's places (pure and deterministic):
 *
 * - villages and cities: half-timbered houses along the roads that leave them, facing the street
 *   (cities with a second row and taller houses), lanterns, a well and market stalls in the middle;
 * - castles: a walled compound (curtain walls with battlements, corner towers, a gate towards the
 *   nearest road, the keep and a big tower inside);
 * - elven ruins: a few broken houses in a clearing; windmills.
 *
 * Pieces come from the fantasy world's kit generators (house, tower, ruin); the same kit and
 * baking draw them. Footprints are rotated rectangles, for collision and to keep plants out.
 */

import { FLOOR_M, type Piece, type PropKind, hashInts, house, rng, ruin, tower } from '../fantasy/gen'
import type { Continent, Place } from './continent'
import type { Ground } from './ground'

/** A rotated rectangle: centre, half extents along its local x and z, and its turn. */
export interface Footprint {
  x: number
  z: number
  hx: number
  hz: number
  yaw: number
}

export interface Building {
  kind: 'house' | 'tower' | 'wall' | 'gate' | 'keep' | 'windmill' | 'ruin' | 'lantern'
  /** Anchor on the ground; local +z faces `yaw` (0 = north/+z, positive towards +x). */
  x: number
  z: number
  yaw: number
  pieces: Piece[]
  foot: Footprint | null
  place: string
}

export interface TownProp {
  kind: PropKind
  x: number
  z: number
  rotation: number
  tint: number
}

export interface Towns {
  buildings: Building[]
  props: TownProp[]
}

/** Point `right` metres to the side and `ahead` metres forward of (x, z) facing `yaw`. */
export function local(x: number, z: number, yaw: number, right: number, ahead: number): [number, number] {
  return [x + Math.cos(yaw) * right + Math.sin(yaw) * ahead, z - Math.sin(yaw) * right + Math.cos(yaw) * ahead]
}

export function insideFoot(f: Footprint, x: number, z: number, pad = 0): boolean {
  const dx = x - f.x
  const dz = z - f.z
  const lx = dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw)
  const lz = dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw)
  return Math.abs(lx) <= f.hx + pad && Math.abs(lz) <= f.hz + pad
}

/** Where along a polyline, `d` metres from its start: point and heading. */
function along(points: [number, number][], d: number): { x: number; z: number; h: number } | null {
  let left = d
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, z0] = points[i]
    const [x1, z1] = points[i + 1]
    const len = Math.hypot(x1 - x0, z1 - z0)
    if (left <= len) {
      const t = len ? left / len : 0
      return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, h: Math.atan2(x1 - x0, z1 - z0) }
    }
    left -= len
  }
  return null
}

const WALL_COLUMN: Piece[] = [
  { model: 'found_wall', x: 0, y: 0, z: 0, ry: 0 },
  { model: 'Wall_UnevenBrick_Straight', x: 0, y: 0, z: 0, ry: 0 },
  { model: 'Wall_UnevenBrick_Straight', x: 0, y: FLOOR_M, z: 0, ry: 0 },
  { model: 'wallcap', x: 0, y: 2 * FLOOR_M, z: 0, ry: 0 },
  { model: 'merlon', x: -0.5, y: 2 * FLOOR_M, z: 0, ry: 0 },
]

export function layoutTowns(c: Continent, ground: Ground): Towns {
  const buildings: Building[] = []
  const props: TownProp[] = []
  const feet: Footprint[] = []
  const free = (f: Footprint, pad = 1.2) => !feet.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < Math.hypot(o.hx, o.hz) + Math.hypot(f.hx, f.hz) + pad)
  const dryAndFlat = (x: number, z: number) => {
    const h = ground.height(x, z)
    return h > 0.4 && ground.water(x, z, h) === null && Math.abs(ground.height(x + 3, z) - h) < 1.6 && Math.abs(ground.height(x, z + 3) - h) < 1.6
  }
  const offRoad = (f: Footprint) => {
    for (const [dx, dz] of [[0, 0], [f.hx, f.hz], [-f.hx, f.hz], [f.hx, -f.hz], [-f.hx, -f.hz]]) {
      const [x, z] = local(f.x, f.z, f.yaw, dx, dz)
      if (ground.roads.nearest(x, z).edge < 1) return false
    }
    return true
  }
  const add = (b: Building) => {
    buildings.push(b)
    if (b.foot) feet.push(b.foot)
  }

  for (const p of c.places) {
    const r = rng(hashInts(c.seed, 700, ...p.id.split('').map((ch) => ch.charCodeAt(0))))
    if (p.kind === 'village' || p.kind === 'city') townAt(p, r)
    else if (p.kind === 'castle') castleAt(p, r)
    else if (p.kind === 'ruins') ruinsAt(p, r)
    else if (p.kind === 'windmill') {
      add({ kind: 'windmill', x: p.x, z: p.z, yaw: r() * Math.PI * 2, pieces: [{ model: 'mill', x: 0, y: 0, z: 0, ry: 0 }], foot: { x: p.x, z: p.z, hx: 4, hz: 4, yaw: 0 }, place: p.id })
    }
  }
  return { buildings, props }

  function roadsFrom(p: Place): [number, number][][] {
    return c.roads
      .filter((road) => road.from === p.id || road.to === p.id)
      .map((road) => (road.from === p.id ? road.points : [...road.points].reverse()))
  }

  function townAt(p: Place, r: () => number): void {
    const city = p.kind === 'city'
    const reach = city ? 150 : 95
    const before = buildings.length
    let lantern = 0
    for (const pts of roadsFrom(p)) {
      for (let d = 12; d < reach; d += 13) {
        const at = along(pts, d)
        if (!at) break
        const fade = d / reach
        for (const side of [-1, 1]) {
          for (const row of city ? [0, 1] : [0]) {
            if (r() > (row ? 0.6 : 0.9) - fade * 0.5) continue
            const sizes: [4 | 6, 4 | 6 | 8][] = row ? [[4, 6], [6, 6], [6, 8]] : [[4, 4], [4, 6], [6, 6]]
            const [W, D] = sizes[Math.floor(r() * sizes.length)]
            const lateral = (row ? 21 : 5.6) + D / 2 + r() * 1.5
            const [x, z] = local(at.x, at.z, at.h, side * lateral, 0)
            const yaw = at.h - (side * Math.PI) / 2 // the door faces the street
            const foot = { x, z, hx: W / 2 + 0.6, hz: D / 2 + 0.6, yaw }
            if (!free(foot) || !offRoad(foot) || !dryAndFlat(x, z)) continue
            const floors = city ? (r() < 0.5 ? 3 : 2) : r() < 0.65 ? 2 : 1
            const stone = r() < 0.6 ? 'ground' : r() < 0.4 ? 'all' : 'none'
            add({ kind: 'house', x, z, yaw, pieces: house(r, { W, D, floors, stone }), foot, place: p.id })
          }
        }
        if (d < reach - 15 && lantern++ % 2 === 0) {
          const side = lantern % 4 < 2 ? 1 : -1
          const [x, z] = local(at.x, at.z, at.h, side * 2.8, 0)
          add({ kind: 'lantern', x, z, yaw: at.h - (side * Math.PI) / 2, pieces: [{ model: 'lantern', x: 0, y: 0, z: 0, ry: 0 }], foot: null, place: p.id })
        }
        // Barrels, crates and stalls along the street, between the houses and the road.
        if (r() < 0.5) {
          const side = r() < 0.5 ? -1 : 1
          const [x, z] = local(at.x, at.z, at.h, side * (3.4 + r() * 1.2), (r() - 0.5) * 8)
          const kind: PropKind = city && r() < 0.35 ? 'stall' : r() < 0.6 ? 'barrel' : 'crate'
          if (ground.roads.nearest(x, z).edge > 0.6 && feet.every((f) => !insideFoot(f, x, z, 0.5))) {
            props.push({ kind, x, z, rotation: at.h + (kind === 'stall' ? Math.PI / 2 * side : r() * 6), tint: r() })
          }
        }
      }
    }
    // A little town without many roads still gets a few houses around its square.
    const want = city ? 14 : 6
    for (let k = 0; buildings.length - before < want && k < 40; k++) {
      const a = r() * Math.PI * 2
      const dist = 16 + r() * (city ? 50 : 30)
      const x = p.x + Math.sin(a) * dist
      const z = p.z + Math.cos(a) * dist
      const yaw = Math.atan2(p.x - x, p.z - z) // facing the square
      const W = r() < 0.5 ? 4 : 6
      const D = r() < 0.5 ? 4 : 6
      const foot = { x, z, hx: W / 2 + 0.6, hz: D / 2 + 0.6, yaw }
      if (!free(foot) || !offRoad(foot) || !dryAndFlat(x, z)) continue
      add({ kind: 'house', x, z, yaw, pieces: house(r, { W: W as 4 | 6, D: D as 4 | 6, floors: city ? 2 : 1 + Math.floor(r() * 2), stone: 'ground' }), foot, place: p.id })
    }
    // The square: a well, and stalls in a city.
    if (ground.roads.nearest(p.x + 4, p.z + 4).edge > 1) props.push({ kind: 'well', x: p.x + 4, z: p.z + 4, rotation: r() * 6, tint: r() })
    if (city) {
      for (let k = 0; k < 5; k++) {
        const [x, z] = local(p.x, p.z, k * 1.25, 9, 3)
        if (ground.roads.nearest(x, z).edge > 0.6) props.push({ kind: 'stall', x, z, rotation: k * 1.25 + Math.PI, tint: r() })
      }
    }
  }

  function castleAt(p: Place, r: () => number): void {
    // The gate faces the first road out (or north).
    const out = roadsFrom(p)[0]
    const toward = out ? along(out, 30) : null
    const yaw = toward ? Math.atan2(toward.x - p.x, toward.z - p.z) : 0
    const hw = 26 // half width (local x)
    const hd = 18 // half depth (local z); the gate is in the front wall (+z)
    const put = (kind: Building['kind'], lx: number, lz: number, turn: number, pieces: Piece[], foot: Footprint | null) => {
      const [x, z] = local(p.x, p.z, yaw, lx, lz)
      add({ kind, x, z, yaw: yaw + turn, pieces, foot: foot && { ...foot, x, z, yaw: yaw + turn }, place: p.id })
    }
    const wall = (lx: number, lz: number, turn: number) => put('wall', lx, lz, turn, WALL_COLUMN, { x: 0, z: 0, hx: 1.1, hz: 0.6, yaw: 0 })
    for (let lx = -hw + 1; lx < hw; lx += 2) {
      if (Math.abs(lx) > 3) wall(lx, hd, 0) // front, with the gate gap
      wall(lx, -hd, Math.PI)
    }
    for (let lz = -hd + 1; lz < hd; lz += 2) {
      wall(hw, lz, Math.PI / 2)
      wall(-hw, lz, -Math.PI / 2)
    }
    const towerFoot = { x: 0, z: 0, hx: 2.3, hz: 2.3, yaw: 0 }
    for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) put('tower', lx, lz, 0, tower(r, 4 + Math.floor(r() * 2)), towerFoot)
    for (const lx of [-4.5, 4.5]) put('tower', lx, hd, 0, tower(r, 3), towerFoot)
    put('gate', 0, hd, 0, [
      { model: 'gatebeam_small', x: 0, y: 4.4, z: 0, ry: 0 },
      ...[-1.5, 0, 1.5].flatMap((x) => [
        { model: 'Wall_UnevenBrick_Straight', x, y: 4.6, z: 0, ry: 0 },
        { model: 'merlon', x: x - 0.5, y: 7.6, z: 0, ry: 0 },
      ]),
    ], null)
    put('keep', 6, -7, 0, house(r, { W: 6, D: 8, floors: 3, stone: 'all' }), { x: 0, z: 0, hx: 3.6, hz: 4.6, yaw: 0 })
    put('tower', -12, -8, 0, tower(r, 6), towerFoot)
  }

  function ruinsAt(p: Place, r: () => number): void {
    const n = 3 + Math.floor(r() * 3)
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2
      const dist = k === 0 ? 0 : 10 + r() * 22
      const x = p.x + Math.sin(a) * dist
      const z = p.z + Math.cos(a) * dist
      const W = r() < 0.5 ? 4 : 6
      const D = r() < 0.5 ? 4 : 6
      const yaw = r() * Math.PI * 2
      const foot = { x, z, hx: W / 2 + 0.5, hz: D / 2 + 0.5, yaw }
      if (!free(foot) || !dryAndFlat(x, z)) continue
      add({ kind: 'ruin', x, z, yaw, pieces: ruin(r, W, D), foot, place: p.id })
    }
    for (let k = 0; k < 7; k++) {
      const a = r() * Math.PI * 2
      const dist = 6 + r() * 30
      const kind: PropKind = k < 3 ? 'pillar' : k < 5 ? 'crystal' : 'arch'
      props.push({ kind, x: p.x + Math.sin(a) * dist, z: p.z + Math.cos(a) * dist, rotation: r() * 6, tint: r() })
    }
  }
}
