import { describe, expect, it } from 'vitest'
import { FreeWalkProgress, type KeyValue } from './freewalk'

function memory(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) }
}

describe('free walk progress', () => {
  it('continues where the last walk ended, across page loads', () => {
    const store = memory()
    const first = new FreeWalkProgress(store)
    first.use('123:falls')
    expect(first.position(0)).toBe(0)
    expect(first.position(1430)).toBe(1430) // a 1.43 km walk

    // Reload: the app's odometer starts at 0 again, the world does not.
    const second = new FreeWalkProgress(store)
    second.use('123:falls')
    expect(second.position(0)).toBe(1430)
    expect(second.position(500)).toBe(1930)
  })

  it('starts at the odometer reading it first sees (the page may have walked before)', () => {
    const p = new FreeWalkProgress(memory())
    p.use('w')
    expect(p.position(250)).toBe(0)
    expect(p.position(300)).toBe(50)
  })

  it('a different or new world starts at 0', () => {
    const store = memory()
    const p = new FreeWalkProgress(store)
    p.use('a')
    p.position(0)
    p.position(800)
    p.use('b')
    expect(p.position(800)).toBe(0)
    p.reset('a') // "New world" with the old seed still starts over
    expect(p.position(900)).toBe(0)
  })

  it('ignores a broken saved value', () => {
    const store = memory()
    store.set('walkpad.fantasy.free', '{oops')
    const p = new FreeWalkProgress(store)
    p.use('a')
    expect(p.position(10)).toBe(0)
  })
})
