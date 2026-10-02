import { describe, expect, it } from 'vitest'
import type { GameProfile } from '../../bridge'
import { progressText } from '../../profile'
import { type Continent, cellAt, generateContinent } from './continent'
import { DISCOVER_RADIUS, discoveriesAt, knownKey, profileNews } from './progress'

const meadow = { forest: 0, ruins: 0, meadow: 1, fields: 0, falls: 0 }
const mixed = { forest: 0.4, ruins: 0, meadow: 0.35, fields: 0.25, falls: 0 }

describe('discoveries', () => {
  let c: Continent
  it('finds a place within its radius, the province and the land, once', { timeout: 30_000 }, () => {
    c = generateContinent(2024)
    const city = c.places.find((p) => p.kind === 'city')!
    const near = discoveriesAt(c, city.x + DISCOVER_RADIUS.city - 5, city.z, meadow, new Set())
    expect(near.map((f) => f.kind).sort()).toEqual(['biome', 'place', 'province'])
    expect(near.find((f) => f.kind === 'place')!.key).toBe(city.id)
    expect(near.find((f) => f.kind === 'province')!.key).toBe(String(c.province[cellAt(c, city.x + DISCOVER_RADIUS.city - 5, city.z)]))
    // Already known: nothing again.
    const known = new Set(near.map((f) => knownKey(f.kind, f.key)))
    expect(discoveriesAt(c, city.x, city.z, meadow, known)).toEqual([])
    // Too far from the city: not discovered.
    const far = discoveriesAt(c, city.x + DISCOVER_RADIUS.city + 400, city.z, meadow, known)
    expect(far.some((f) => f.key === city.id)).toBe(false)
    // A mixed border is not yet "this kind of land".
    expect(discoveriesAt(c, city.x, city.z, mixed, new Set()).some((f) => f.kind === 'biome')).toBe(false)
  })
})

const profile = (level: number, unlocked: string[]): GameProfile => ({
  xp: 0, level, level_start_xp: 0, next_level_xp: 100, metrics: {},
  breakdown: { walking: 0, discoveries: 0, achievements: 0 },
  achievements: ['wanderer', 'habit'].map((id) => ({
    id, title: id === 'wanderer' ? 'Wanderer' : 'A habit', description: '', xp: 150, metric: 'distance_km', target: 10,
    progress: 0, unlocked_at: unlocked.includes(id) ? 1 : null,
  })),
})

describe('toasts', () => {
  it('announce level ups and newly unlocked achievements only', () => {
    expect(profileNews(null, profile(2, ['habit']))).toEqual([]) // the first profile is not news
    expect(profileNews(profile(2, ['habit']), profile(3, ['habit', 'wanderer']))).toEqual(['Level 3!', 'Achievement: Wanderer · +150 XP'])
    expect(profileNews(profile(3, ['habit']), profile(3, ['habit']))).toEqual([])
  })

  it('progress reads well', () => {
    const a = profile(1, [])
    expect(progressText({ ...a.achievements[0], progress: 3.456, target: 10 })).toBe('3.5 / 10 km')
    expect(progressText({ ...a.achievements[0], metric: 'villages', progress: 2, target: 5 })).toBe('2 / 5')
    expect(progressText({ ...a.achievements[0], metric: 'longest_streak_days', progress: 2, target: 7 })).toBe('2 / 7 days')
  })
})
