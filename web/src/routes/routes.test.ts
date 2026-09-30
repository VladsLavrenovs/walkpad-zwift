import { describe, expect, it } from 'vitest'
import { Polyline, bearing, haversine } from './geo'
import { RouteTracker } from './progress'

const LINE: [number, number][] = [
  [56.95, 24.1],
  [56.951, 24.1], // ~111 m north
  [56.951, 24.1018], // ~110 m east
]

describe('geo', () => {
  it('measures and walks a polyline', () => {
    expect(haversine(LINE[0], LINE[1])).toBeCloseTo(111.2, 0)
    const line = new Polyline(LINE)
    expect(line.length).toBeCloseTo(haversine(LINE[0], LINE[1]) + haversine(LINE[1], LINE[2]), 6)
    const start = line.at(-5)
    expect(start.point).toEqual(LINE[0])
    expect(start.heading).toBeCloseTo(0, 0) // north
    const mid = line.at(55.6)
    expect(mid.point[0]).toBeCloseTo(56.9505, 4)
    const turn = line.at(150)
    expect(turn.point[0]).toBeCloseTo(56.951, 6)
    expect(turn.heading).toBeCloseTo(90, 0) // east after the corner
    expect(line.at(1e9).point).toEqual(LINE[2])
  })

  it('computes bearings', () => {
    expect(bearing([0, 0], [0, 1])).toBeCloseTo(90, 5)
    expect(bearing([0, 0], [-1, 0])).toBeCloseTo(180, 5)
  })
})

describe('RouteTracker', () => {
  it('moves smoothly but stays within the reported 10 m bucket', () => {
    const t = new RouteTracker()
    t.setResolution(10)
    t.onReport(1, 100)
    expect(t.position).toBe(100)
    for (let i = 0; i < 60; i++) t.advance(0.25, 1000) // 15 m of walking, no new report
    expect(t.position).toBe(110)
    t.onReport(1, 110)
    t.advance(1, 1000)
    expect(t.position).toBe(111)
  })

  it('jumps on a new route or a progress reset, and stops at the end', () => {
    const t = new RouteTracker()
    t.onReport(1, 500)
    t.onReport(2, 20)
    expect(t.position).toBe(20)
    t.onReport(2, 0) // reset
    expect(t.position).toBe(0)
    t.onReport(2, 99.5)
    t.advance(5, 100)
    expect(t.position).toBe(100)
    t.onReport(null, null)
    expect(t.routeId).toBeNull()
  })
})
