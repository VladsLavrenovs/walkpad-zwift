/**
 * Quests NPCs offer in the open world, made up from the world itself (pure and deterministic):
 *
 * - deliver: take a letter or a parcel to another town; done when you get there;
 * - visit: go and see a waterfall, ruins, a castle or a windmill; done when you are close;
 * - explore: walk a distance through one kind of land; counts only the metres walked there.
 *
 * Everything finishes by walking: no need to stop or press anything on the way. The bridge keeps
 * taken quests and pays their XP.
 */

import type { Quest } from '../../bridge'
import { hashInts, rng } from '../fantasy/gen'
import { type Continent, OW_BIOMES, OW_BIOME_NAMES, type OwBiome, type Place } from './continent'
import type { Npc } from './npcs'
import { DISCOVER_RADIUS } from './progress'

export interface QuestOffer {
  id: string
  title: string
  kind: Quest['kind']
  xp: number
  data: Record<string, string | number>
  /** What the NPC says. */
  text: string
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

export function bearingWord(fromX: number, fromZ: number, toX: number, toZ: number): string {
  const deg = ((Math.atan2(toX - fromX, toZ - fromZ) * 180) / Math.PI + 360) % 360
  return COMPASS[Math.round(deg / 45) % 8]
}

function km(m: number): string {
  return m < 950 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1)} km`
}

/** Where the walker counts as having arrived at a place. */
export function arriveRadius(p: Place): number {
  return p.kind === 'city' ? 130 : p.kind === 'village' ? 80 : DISCOVER_RADIUS[p.kind]
}

/** The giver's n-th quest. */
export function offerFor(c: Continent, giver: Npc, n: number): QuestOffer | null {
  const home = c.places.find((p) => p.id === giver.home)
  if (!home) return null
  const r = rng(hashInts(c.seed, 1300, n, ...giver.id.split('').map((ch) => ch.charCodeAt(0))))
  const dist = (p: Place) => Math.hypot(p.x - home.x, p.z - home.z)
  const pick = <T>(list: T[]): T | null => (list.length ? list[Math.floor(r() * list.length)] : null)
  const roll = r()
  const id = `${giver.id}:${n}`
  if (roll < 0.5) {
    const to = pick(c.places.filter((p) => p.id !== home.id && (p.kind === 'village' || p.kind === 'city' || p.kind === 'castle')
      && dist(p) > 600 && dist(p) < 3200))
    if (to) {
      const d = dist(to)
      const thing = pick(['a letter', 'a sealed parcel', 'some medicine', 'a bundle of wool', 'a message', 'fresh bread'])!
      return {
        id, kind: 'deliver', xp: Math.min(500, Math.round(40 + d * 0.07)),
        title: `Take ${thing} to ${to.name}`,
        data: { to: to.id, toName: to.name, from: home.id, distance_m: Math.round(d) },
        text: `Would you take ${thing} to ${to.name}? It is about ${km(d)} ${bearingWord(home.x, home.z, to.x, to.z)} of here.`,
      }
    }
  }
  if (roll < 0.8) {
    const sight = pick(c.places.filter((p) => (p.kind === 'waterfall' || p.kind === 'ruins' || p.kind === 'castle' || p.kind === 'windmill')
      && dist(p) > 300 && dist(p) < 2800))
    if (sight) {
      const d = dist(sight)
      return {
        id, kind: 'visit', xp: Math.min(400, Math.round(60 + d * 0.05)),
        title: `See ${sight.name}`,
        data: { to: sight.id, toName: sight.name, from: home.id, distance_m: Math.round(d) },
        text: `Have you ever seen ${sight.name}? Go and see it for yourself, it is ${km(d)} ${bearingWord(home.x, home.z, sight.x, sight.z)} of here.`,
      }
    }
  }
  // Explore: a kind of land this world has plenty of.
  const counts = new Map<OwBiome, number>()
  for (let k = 0; k < c.biome.length; k += 37) {
    const b = c.biome[k]
    if (b !== 255) counts.set(OW_BIOMES[b], (counts.get(OW_BIOMES[b]) ?? 0) + 1)
  }
  const lands = [...counts.entries()].filter(([, n2]) => n2 > 150).map(([b]) => b)
  const biome = pick(lands) ?? 'forest'
  const metres = 500 + Math.round(r() * 15) * 100
  return {
    id, kind: 'explore', xp: Math.min(400, Math.round(40 + metres * 0.1)),
    title: `Walk ${km(metres)} through the ${OW_BIOME_NAMES[biome].toLowerCase()}`,
    data: { biome, biomeName: OW_BIOME_NAMES[biome], metres, from: home.id },
    text: `They say the ${OW_BIOME_NAMES[biome].toLowerCase()} is lovely this time of year. Walk ${km(metres)} through it and tell me all about it.`,
  }
}

export interface QuestState {
  x: number
  z: number
  /** Metres walked since the last step. */
  metres: number
  /** The kind of land most of what is around (null at a border). */
  biome: OwBiome | null
}

/** A quest's progress after a step; `done` once finished. Progress is metres in every kind. */
export function questStep(c: Continent, q: Pick<Quest, 'kind' | 'data' | 'progress'>, s: QuestState): { progress: number; done: boolean } {
  if (q.kind === 'explore') {
    const progress = q.progress + (s.biome === q.data.biome ? s.metres : 0)
    return { progress, done: progress >= Number(q.data.metres) }
  }
  const target = c.places.find((p) => p.id === q.data.to)
  if (!target) return { progress: q.progress, done: false }
  const left = Math.hypot(target.x - s.x, target.z - s.z)
  const total = Number(q.data.distance_m) || left
  return { progress: Math.max(q.progress, Math.min(total, total - left)), done: left <= arriveRadius(target) }
}

/** Where to head for a quest (deliver and visit), for the compass and the minimap. */
export function questTarget(c: Continent, q: Pick<Quest, 'kind' | 'data'>): { x: number; z: number; name: string } | null {
  if (q.kind === 'explore') return null
  const p = c.places.find((x) => x.id === q.data.to)
  return p ? { x: p.x, z: p.z, name: p.name } : null
}

/** How far along a quest is, 0..1. */
export function questFraction(q: Pick<Quest, 'kind' | 'data' | 'progress'>): number {
  const total = q.kind === 'explore' ? Number(q.data.metres) : Number(q.data.distance_m)
  return total > 0 ? Math.min(1, q.progress / total) : 0
}

