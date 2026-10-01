import { describe, expect, it } from 'vitest'
import { DEFAULT_VIEW, clampView, clearance, isDefaultView, orbitPose, walkerPlacement } from './orbit'

describe('orbit camera', () => {
  it('the default view is the classic chase camera', () => {
    const { camera, target } = orbitPose(0, 100, 0, DEFAULT_VIEW)
    expect(camera.x).toBeCloseTo(0, 9)
    expect(camera.z).toBeCloseTo(93, 9) // 7 m behind
    expect(camera.y).toBeCloseTo(3.2, 9)
    expect(target).toEqual({ x: expect.closeTo(0, 9), y: 1.1, z: expect.closeTo(109, 9) }) // 9 m ahead
    expect(isDefaultView(DEFAULT_VIEW)).toBe(true)
  })

  it('turning 180 degrees puts the camera in front, looking back', () => {
    const { camera, target } = orbitPose(0, 100, 0, { ...DEFAULT_VIEW, yaw: 180 })
    expect(camera.z).toBeCloseTo(107, 6)
    expect(target.z).toBeLessThan(100)
  })

  it('zoom changes the distance; looking down keeps the walker in view', () => {
    const near = orbitPose(0, 0, 0, { ...DEFAULT_VIEW, zoom: 0.5 }).camera
    const far = orbitPose(0, 0, 0, { ...DEFAULT_VIEW, zoom: 3 }).camera
    expect(Math.hypot(near.z, near.y)).toBeCloseTo(Math.hypot(7, 3.2) * 0.5, 6)
    expect(Math.hypot(far.z, far.y)).toBeCloseTo(Math.hypot(7, 3.2) * 3, 6)
    const top = orbitPose(0, 0, 0, { yaw: 0, elevation: 80, zoom: 1 })
    expect(top.camera.y).toBeGreaterThan(7)
    expect(top.target.z).toBeLessThan(2.5) // looks nearly straight down at the walker
  })

  it('keeps the view within limits', () => {
    expect(clampView({ yaw: 200, elevation: 120, zoom: 50 })).toEqual({ yaw: -160, elevation: 80, zoom: 4 })
    expect(clampView({ yaw: -540, elevation: -5, zoom: 0 })).toEqual({ yaw: 180 - 360, elevation: 4, zoom: 0.35 })
  })

  it('places the walker relative to her default spot, or hides her behind the camera', () => {
    const ref = { feet: { x: 500, y: 700 }, head: { x: 500, y: 300 } }
    expect(walkerPlacement({ ...ref.feet, behind: false }, ref.head, ref.feet, ref.head)).toEqual({ dx: 0, dy: 0, scale: 1 })
    expect(walkerPlacement({ x: 520, y: 600, behind: false }, { x: 520, y: 400 }, ref.feet, ref.head))
      .toEqual({ dx: 20, dy: -100, scale: 0.5 })
    expect(walkerPlacement({ x: 0, y: 0, behind: true }, ref.head, ref.feet, ref.head)).toBeNull()
  })
})

describe('camera and buildings', () => {
  const house = { s0: 100, s1: 106, lat0: 5, lat1: 11 }

  it('the camera stops short of a building in the way', () => {
    expect(clearance(103, 0, 8, [house])).toBeLessThan(0.55) // turned to the right: the house
    expect(clearance(103, 0, -8, [house])).toBe(1) // the other side is open
    expect(clearance(103, -7, 0, [house])).toBe(1) // behind, along the street
  })
})
