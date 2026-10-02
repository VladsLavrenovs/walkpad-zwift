import { beforeAll, describe, expect, it } from 'vitest'
import { type Continent, generateContinent } from './continent'
import { type Npc, makeNpcs, npcAt } from './npcs'
import { arriveRadius, bearingWord, offerFor, questStep, questTarget } from './quests'

let c: Continent
let npcs: Npc[]

beforeAll(() => {
  c = generateContinent(2024)
  npcs = makeNpcs(c)
}, 30_000)

describe('people', () => {
  it('every village, city and castle has a quest giver and townsfolk; the same every time', () => {
    for (const p of c.places.filter((q) => q.kind === 'village' || q.kind === 'city' || q.kind === 'castle')) {
      const here = npcs.filter((n) => n.home === p.id)
      expect(here.filter((n) => n.role === 'giver'), p.name).toHaveLength(1)
      expect(here.filter((n) => n.role === 'walker').length, p.name).toBeGreaterThan(0)
    }
    expect(makeNpcs(c)).toEqual(npcs)
    expect(new Set(npcs.map((n) => n.id)).size).toBe(npcs.length)
  })

  it('walkers go back and forth along their street, pausing at the ends; givers stand still', () => {
    const walker = npcs.find((n) => n.role === 'walker')!
    let prev = npcAt(walker, 0)
    let moved = 0
    let paused = 0
    for (let t = 0.1; t < 400; t += 0.1) {
      const at = npcAt(walker, t)
      const step = Math.hypot(at.x - prev.x, at.z - prev.z)
      expect(step).toBeLessThanOrEqual(walker.speed * 0.1 + 1e-6) // never jumps
      if (at.moving) moved++
      else paused++
      prev = at
    }
    expect(moved).toBeGreaterThan(paused)
    expect(paused).toBeGreaterThan(0)
    const giver = npcs.find((n) => n.role === 'giver')!
    expect(npcAt(giver, 0)).toEqual(npcAt(giver, 1234.5))
  })
})

describe('quests', () => {
  const giver = () => npcs.find((n) => n.role === 'giver' && n.home.startsWith('village'))!

  it('each giver has a sequence of quests, the same every time, with sensible XP', () => {
    const kinds = new Set<string>()
    for (const g of npcs.filter((n) => n.role === 'giver').slice(0, 10)) {
      for (let k = 0; k < 4; k++) {
        const q = offerFor(c, g, k)!
        expect(q).toEqual(offerFor(c, g, k))
        expect(q.id).toBe(`${g.id}:${k}`)
        expect(q.xp).toBeGreaterThan(0)
        expect(q.xp).toBeLessThanOrEqual(600)
        expect(q.text.length).toBeGreaterThan(10)
        kinds.add(q.kind)
      }
    }
    expect([...kinds].sort()).toEqual(['deliver', 'explore', 'visit'])
  })

  it('a delivery is done on arriving in the other town, with progress on the way', () => {
    let q = null
    for (let k = 0; k < 20 && !q; k++) {
      const o = offerFor(c, giver(), k)!
      if (o.kind === 'deliver') q = o
    }
    expect(q).not.toBeNull()
    const quest = { kind: q!.kind, data: q!.data, progress: 0 }
    const to = c.places.find((p) => p.id === q!.data.to)!
    const from = c.places.find((p) => p.id === q!.data.from)!
    const half = questStep(c, quest, { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2, metres: 0, biome: null })
    expect(half.done).toBe(false)
    expect(half.progress).toBeGreaterThan(Number(q!.data.distance_m) * 0.3)
    const there = questStep(c, quest, { x: to.x + arriveRadius(to) * 0.5, z: to.z, metres: 0, biome: null })
    expect(there.done).toBe(true)
    expect(questTarget(c, quest)).toEqual({ x: to.x, z: to.z, name: to.name })
  })

  it('exploring counts only the metres walked in that kind of land', () => {
    const quest = { kind: 'explore' as const, data: { biome: 'forest', metres: 1000 }, progress: 0 }
    let progress = 0
    for (let k = 0; k < 30; k++) {
      const r = questStep(c, { ...quest, progress }, { x: 0, z: 0, metres: 50, biome: k % 2 ? 'forest' : 'fields' })
      progress = r.progress
    }
    expect(progress).toBe(750)
    expect(questStep(c, { ...quest, progress: 990 }, { x: 0, z: 0, metres: 20, biome: 'forest' }).done).toBe(true)
  })

  it('directions read like a compass', () => {
    expect(bearingWord(0, 0, 0, 100)).toBe('north')
    expect(bearingWord(0, 0, 100, 0)).toBe('east')
    expect(bearingWord(0, 0, -70, -70)).toBe('south-west')
  })
})
