/**
 * People of the open world, deterministic from the continent: in every village, city and castle a
 * quest giver standing near the middle, and townsfolk walking up and down the streets. A walker's
 * position is a pure function of time (back and forth along its stretch of road), so nothing needs
 * saving and every page shows them in the same place.
 */

import { hashInts, rng } from '../fantasy/gen'
import type { Continent, Place } from './continent'

export const NPC_LOOKS = 8
export const NPC_HEIGHT_M = 1.75

const FIRST = [
  'Aldric', 'Bryn', 'Cedric', 'Dara', 'Elin', 'Fenna', 'Garret', 'Hilde', 'Ivo', 'Jora', 'Kestrel', 'Liesel',
  'Marten', 'Nessa', 'Osric', 'Pell', 'Quinn', 'Rowan', 'Sabine', 'Tamsin', 'Ulric', 'Vera', 'Wendel', 'Yara',
  'Bram', 'Corin', 'Edda', 'Halvard', 'Ilse', 'Maren', 'Odo', 'Ragna', 'Sten', 'Tilda', 'Wyn', 'Agnes',
]
const TRADE = ['miller', 'baker', 'smith', 'weaver', 'herbalist', 'innkeeper', 'carpenter', 'shepherd', 'scribe', 'cooper']

export interface Npc {
  id: string
  name: string
  /** Index of the look (sprite sheet). */
  look: number
  home: string
  homeName: string
  role: 'giver' | 'walker'
  /** What they do ("the miller"), for the dialog. */
  trade: string
  /** Standing NPCs: where and facing. Walkers: their stretch of road (2+ points). */
  path: [number, number][]
  heading: number
  /** Metres per second while walking; 0 for standing. */
  speed: number
  /** Where along the path at time 0, metres. */
  offset: number
}

/** A stretch of the roads leaving a place, `from` to `to` metres from it, shifted to one side. */
function streetFrom(c: Continent, p: Place, index: number, from: number, to: number, side: number): [number, number][] | null {
  const roads = c.roads.filter((r) => r.from === p.id || r.to === p.id)
  if (!roads.length) return null
  const road = roads[index % roads.length]
  const pts = road.from === p.id ? road.points : [...road.points].reverse()
  const out: [number, number][] = []
  let d = 0
  for (let i = 0; i + 1 < pts.length && d < to; i++) {
    const [x0, z0] = pts[i]
    const [x1, z1] = pts[i + 1]
    const len = Math.hypot(x1 - x0, z1 - z0) || 1
    const nx = (z1 - z0) / len
    const nz = -(x1 - x0) / len
    if (d + len >= from) out.push([x0 + nx * side, z0 + nz * side])
    d += len
    if (d >= to) out.push([x1 + nx * side, z1 + nz * side])
  }
  return out.length >= 2 ? out : null
}

export function makeNpcs(c: Continent): Npc[] {
  const out: Npc[] = []
  for (const p of c.places) {
    if (p.kind !== 'village' && p.kind !== 'city' && p.kind !== 'castle') continue
    const r = rng(hashInts(c.seed, 1200, ...p.id.split('').map((ch) => ch.charCodeAt(0))))
    const person = (role: Npc['role'], k: number): Omit<Npc, 'path' | 'heading' | 'speed' | 'offset'> => ({
      id: `npc-${p.id}-${k}`,
      name: FIRST[Math.floor(r() * FIRST.length)],
      look: Math.floor(r() * NPC_LOOKS),
      home: p.id,
      homeName: p.name,
      role,
      trade: p.kind === 'castle' ? (k === 0 ? 'steward' : 'guard') : TRADE[Math.floor(r() * TRADE.length)],
    })
    // The quest giver: by the square, a little off the middle, facing it.
    const a = r() * Math.PI * 2
    const gx = p.x + Math.sin(a) * 7
    const gz = p.z + Math.cos(a) * 7
    out.push({ ...person('giver', 0), path: [[gx, gz]], heading: Math.atan2(p.x - gx, p.z - gz), speed: 0, offset: 0 })
    // Townsfolk walking the streets.
    const walkers = p.kind === 'city' ? 6 : p.kind === 'castle' ? 2 : 3
    for (let k = 1; k <= walkers; k++) {
      const side = r() < 0.5 ? -2.4 : 2.4
      const path = streetFrom(c, p, k, 4 + r() * 10, 45 + r() * (p.kind === 'city' ? 90 : 50), side)
      if (!path) continue
      out.push({ ...person('walker', k), path, heading: 0, speed: 0.9 + r() * 0.5, offset: r() * 500 })
    }
  }
  return out
}

function pathLength(path: [number, number][]): number {
  let len = 0
  for (let i = 0; i + 1 < path.length; i++) len += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])
  return len
}

const lengths = new WeakMap<Npc, number>()

/** Where an NPC is at time `t` (seconds) and which way it faces; walkers pause at each end. */
export function npcAt(npc: Npc, t: number): { x: number; z: number; heading: number; moving: boolean } {
  if (npc.speed === 0 || npc.path.length < 2) return { x: npc.path[0][0], z: npc.path[0][1], heading: npc.heading, moving: false }
  let len = lengths.get(npc)
  if (len === undefined) {
    len = pathLength(npc.path)
    lengths.set(npc, len)
  }
  const pause = 3
  const leg = len / npc.speed
  const cycle = 2 * (leg + pause)
  let u = ((t + npc.offset) % cycle + cycle) % cycle
  let back = false
  if (u >= leg + pause) {
    u -= leg + pause
    back = true
  }
  const moving = u < leg
  const d = Math.min(leg, u) * npc.speed
  let s = back ? len - d : d
  for (let i = 0; i + 1 < npc.path.length; i++) {
    const [x0, z0] = npc.path[i]
    const [x1, z1] = npc.path[i + 1]
    const seg = Math.hypot(x1 - x0, z1 - z0)
    if (s <= seg || i + 2 === npc.path.length) {
      const f = seg ? Math.min(1, s / seg) : 0
      const h = Math.atan2(x1 - x0, z1 - z0)
      return { x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, heading: back ? h + Math.PI : h, moving }
    }
    s -= seg
  }
  const [x, z] = npc.path[npc.path.length - 1]
  return { x, z, heading: 0, moving: false }
}
