import { describe, expect, it } from 'vitest'
import { clientId } from './bridge'
import { niceScale } from './charts'
import { bridgeWsUrl, loadConfig } from './config'
import { fmtDistance, fmtDuration } from './format'
import { hash01, sceneryAt } from './worlds/placeholder'

describe('config', () => {
  it('reads the bridge URL and the view mode', () => {
    const c = loadConfig({ VITE_BRIDGE_URL: 'https://bridge.example/' } as ImportMetaEnv, '?view=obs&world=overlay')
    expect(c).toEqual({ bridgeUrl: 'https://bridge.example', obs: true, viewOnly: true, world: 'overlay' })
    expect(loadConfig({} as ImportMetaEnv, '').bridgeUrl).toBe('')
    // Served by the bridge (same origin): may control. Hosted elsewhere: view only.
    expect(loadConfig({} as ImportMetaEnv, '').viewOnly).toBe(false)
    expect(loadConfig({ VITE_BRIDGE_URL: 'https://bridge.example' } as ImportMetaEnv, '').viewOnly).toBe(true)
  })

  it('builds WebSocket URLs, same origin when no bridge URL is set', () => {
    expect(bridgeWsUrl('', '/live?client=a', 'http://192.168.0.242:8080')).toBe('ws://192.168.0.242:8080/live?client=a')
    expect(bridgeWsUrl('https://bridge.example', '/live', 'http://x')).toBe('wss://bridge.example/live')
  })
})

describe('clientId', () => {
  it('is stable across loads and valid for the bridge', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const a = clientId(storage)
    expect(a).toMatch(/^[A-Za-z0-9_.-]{1,64}$/)
    expect(clientId(storage)).toBe(a)
    expect(clientId(null)).toMatch(/^web-/)
  })
})

describe('niceScale', () => {
  it('picks round axis maxima', () => {
    expect(niceScale(0)).toEqual({ top: 1, step: 0.25 })
    expect(niceScale(3700)).toEqual({ top: 4000, step: 1000 })
    expect(niceScale(870)).toEqual({ top: 1000, step: 250 })
  })
})

describe('format', () => {
  it('formats distance and time', () => {
    expect(fmtDistance(850.9)).toBe('850 m')
    expect(fmtDistance(1234)).toBe('1.23 km')
    expect(fmtDuration(65)).toBe('1:05')
    expect(fmtDuration(3725)).toBe('1:02:05')
  })
})

describe('placeholder scenery', () => {
  it('is deterministic per route slot, so revisits look the same', () => {
    expect(sceneryAt(42, 1)).toEqual(sceneryAt(42, 1))
    expect(hash01(1)).not.toBe(hash01(2))
    const things = Array.from({ length: 200 }, (_, i) => sceneryAt(i, -1)).filter(Boolean)
    expect(things.length).toBeGreaterThan(120)
    for (const t of things) expect(t!.x).toBeLessThan(-2) // off the path, on its side
  })
})
