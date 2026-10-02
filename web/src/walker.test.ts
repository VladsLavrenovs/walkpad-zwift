import { describe, expect, it } from 'vitest'
import { Gait } from './walker'

describe('Gait', () => {
  it('loops 1-2-3-4, two frames per step', () => {
    const g = new Gait()
    const frames: number[] = []
    for (let i = 0; i < 8; i++) {
      frames.push(g.frame())
      g.advance(2, 0.25) // 2 steps/s for 0.25 s = half a step = one frame
    }
    expect(frames).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('one full cycle takes two steps', () => {
    const g = new Gait()
    g.advance(1.5, 2 / 1.5 - 1e-9) // just under two steps
    expect(g.frame()).toBe(3)
    g.advance(1.5, 2e-9)
    expect(g.frame()).toBe(0)
  })

  it('settles on frame 1 when stopped', () => {
    const g = new Gait()
    g.advance(2, 0.6)
    expect(g.frame()).not.toBe(0)
    g.advance(0, 1 / 60)
    expect(g.frame()).toBe(0)
    expect(g.bob(0)).toBe(0)
  })

  it('bobs once per step, subtly', () => {
    const g = new Gait()
    const bobs: number[] = []
    for (let i = 0; i < 100; i++) {
      g.advance(2, 1 / 200) // 100 x 5 ms at 2 steps/s = exactly one step
      bobs.push(g.bob(4))
    }
    expect(Math.max(...bobs)).toBeGreaterThan(0)
    expect(Math.max(...bobs)).toBeLessThanOrEqual(0.01)
    expect(Math.min(...bobs)).toBeGreaterThanOrEqual(0)
    expect(bobs[49]).toBeGreaterThan(bobs[5]) // highest mid-step
  })
})

describe('true-to-scale placement', () => {
  it('moves her feet onto the scene point and scales her to the projected height', async () => {
    const { truePlacement } = await import('./walker')
    const natural = { feetX: 700, feetY: 860, figurePx: 476 }
    expect(truePlacement(natural, { x: 700, y: 860 }, 476)).toEqual({ dx: 0, dy: 0, scale: 1 })
    expect(truePlacement(natural, { x: 650, y: 600 }, 119)).toEqual({ dx: -50, dy: -260, scale: 0.25 })
  })
})
