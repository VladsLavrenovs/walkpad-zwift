import { describe, expect, it } from 'vitest'
import { Polyline } from '../routes/geo'
import { angleDelta, cameraUp, chaseOffset, damp, dampAngle, lookAheadHeading } from './chase'

// North 111 m, then east ~110 m: a right-angle corner.
const CORNER = new Polyline([
  [56.95, 24.1],
  [56.951, 24.1],
  [56.951, 24.1018],
])

describe('chase camera', () => {
  it('turns before the corner, smoothly, thanks to the look-ahead', () => {
    expect(lookAheadHeading(CORNER, 50)).toBeCloseTo(0, 0) // straight north
    const near = lookAheadHeading(CORNER, 105) // corner 6 m ahead: already turning
    expect(near).toBeGreaterThan(20)
    expect(near).toBeLessThan(80)
    expect(lookAheadHeading(CORNER, 130)).toBeCloseTo(90, 0) // past it: east
    // Sweeping through the corner never jumps more than a few degrees per metre.
    let prev = lookAheadHeading(CORNER, 90)
    for (let d = 91; d <= 125; d++) {
      const h = lookAheadHeading(CORNER, d)
      expect(Math.abs(angleDelta(prev, h))).toBeLessThan(12)
      prev = h
    }
  })

  it('keeps a heading at the very end of the route', () => {
    expect(lookAheadHeading(CORNER, CORNER.length)).toBeCloseTo(90, 0)
  })

  it('damps angles the short way round', () => {
    expect(angleDelta(350, 10)).toBe(20)
    expect(angleDelta(10, 350)).toBe(-20)
    let h = 350
    for (let i = 0; i < 600; i++) h = dampAngle(h, 10, 1 / 60)
    expect(h).toBeCloseTo(10, 3)
    expect(dampAngle(350, 10, 1 / 60)).toBeGreaterThan(350) // moved towards 360/0, not back to 10 via 180
  })

  it('damps independent of frame rate', () => {
    let a = 0
    for (let i = 0; i < 60; i++) a = damp(a, 1, 1 / 60, 0.6)
    let b = 0
    for (let i = 0; i < 30; i++) b = damp(b, 1, 1 / 30, 0.6)
    expect(a).toBeCloseTo(b, 10)
  })

  it('places the camera behind and above', () => {
    const north = chaseOffset(0)
    expect(north.north).toBeCloseTo(-25)
    expect(north.east).toBeCloseTo(0)
    expect(north.up).toBe(15)
    const east = chaseOffset(90)
    expect(east.east).toBeCloseTo(-25)
  })

  it('never puts the camera below the ground (or a roof) under it', () => {
    expect(cameraUp(10, 12)).toBe(15)
    expect(cameraUp(10, 40)).toBe(34) // 30 m higher behind (a building): rise above it
  })
})
