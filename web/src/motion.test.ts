import { describe, expect, it } from 'vitest'
import type { SampleMsg } from './bridge'
import { Motion, emaAlpha, modelStepLength } from './motion'

function sample(p: Partial<SampleMsg>): SampleMsg {
  return {
    type: 'sample', t: 0, speed_kmh: 0, distance_m: 0, steps: 0, elapsed_s: 0, belt: 'running', session_id: 1,
    route_id: null, route_progress_m: null, ...p,
  }
}

/** Run `seconds` of 60 fps frames. */
function run(m: Motion, seconds: number, fps = 60): void {
  for (let i = 0; i < Math.round(seconds * fps); i++) m.frame(1 / fps)
}

describe('emaAlpha', () => {
  it('is frame-rate independent', () => {
    let a = 0
    for (let i = 0; i < 60; i++) a += (1 - a) * emaAlpha(1 / 60, 0.6)
    let b = 0
    for (let i = 0; i < 30; i++) b += (1 - b) * emaAlpha(1 / 30, 0.6)
    expect(a).toBeCloseTo(b, 10)
  })
})

describe('Motion', () => {
  it('smooths a speed step instead of jumping', () => {
    const m = new Motion()
    m.onSample(sample({ speed_kmh: 3.6 }))
    m.frame(1 / 60)
    expect(m.speedKmh).toBeGreaterThan(0)
    expect(m.speedKmh).toBeLessThan(0.2)
    run(m, 3)
    expect(m.speedKmh).toBeCloseTo(3.6, 1)
  })

  it('advances the odometer every frame at the smoothed speed', () => {
    const m = new Motion()
    m.speedKmh = 3.6 // already at speed: 1 m/s
    m.onSample(sample({ speed_kmh: 3.6 }))
    const before = m.odometerM
    m.frame(1 / 60)
    expect(m.odometerM - before).toBeCloseTo(1 / 60, 6)
    run(m, 10)
    expect(m.odometerM).toBeCloseTo(10 + 1 / 60, 3)
  })

  it('keeps HUD distance within the 10 m KingSmith bucket and never goes back', () => {
    const m = new Motion()
    m.setProtocol('kingsmith')
    m.speedKmh = 3.6
    m.onSample(sample({ speed_kmh: 3.6, distance_m: 0 }))
    run(m, 15) // 15 m walked, but the pad still says 0 (it only reports 10 m steps)
    expect(m.distanceM).toBeCloseTo(10, 5) // capped at 0 + 10
    m.onSample(sample({ speed_kmh: 3.6, distance_m: 10 }))
    let prev = m.distanceM
    for (let i = 0; i < 300; i++) {
      m.frame(1 / 60)
      expect(m.distanceM).toBeGreaterThanOrEqual(prev)
      prev = m.distanceM
    }
    expect(m.odometerM).toBeCloseTo(20, 1) // the world never pauses
  })

  it('resets session counters on a new session', () => {
    const m = new Motion()
    m.onSample(sample({ distance_m: 500, elapsed_s: 300, session_id: 1 }))
    m.onSample(sample({ distance_m: 0, elapsed_s: 0, session_id: 2 }))
    expect(m.distanceM).toBe(0)
    expect(m.elapsedS).toBe(0)
  })

  it('interpolates time between samples but at most 1.5 s ahead', () => {
    const m = new Motion()
    m.onSample(sample({ speed_kmh: 2, elapsed_s: 10 }))
    run(m, 0.5)
    expect(m.elapsedS).toBeCloseTo(10.5, 1)
    run(m, 5) // the pad stopped counting (nobody on the belt)
    expect(m.elapsedS).toBeCloseTo(11.5, 5)
    m.onSample(sample({ speed_kmh: 2, elapsed_s: 11 }))
    expect(m.elapsedS).toBeCloseTo(11.5, 5) // no step back
  })

  it('coasts to a stop and reports zero cadence', () => {
    const m = new Motion()
    m.onSample(sample({ speed_kmh: 3 }))
    run(m, 3)
    m.onSample(sample({ speed_kmh: 0, belt: 'stopped' }))
    run(m, 5)
    expect(m.speedKmh).toBe(0)
    expect(m.cadence()).toBe(0)
  })

  it('uses the model step length until the pad step counter calibrates it', () => {
    const m = new Motion()
    m.speedKmh = 3.6
    m.onSample(sample({ speed_kmh: 3.6, steps: 0 }))
    expect(m.cadence()).toBeCloseTo(1 / modelStepLength(3.6), 5)
    // The owner takes 0.5 m steps: 2 steps per metre, 1 m/s.
    for (let s = 1; s <= 20; s++) {
      run(m, 1)
      m.onSample(sample({ speed_kmh: 3.6, steps: s * 2 }))
    }
    expect(m.stepLengthM).toBeCloseTo(0.5, 1)
    expect(m.cadence()).toBeCloseTo(2, 1)
  })

  it('does not calibrate from a pad that is not counting steps', () => {
    const m = new Motion()
    m.speedKmh = 1
    for (let i = 0; i < 20; i++) {
      m.onSample(sample({ speed_kmh: 1, steps: 0 })) // nobody on the belt: steps frozen
      run(m, 1)
    }
    expect(m.stepLengthM).toBeNull()
  })

  it('clamps huge frame gaps (background tab)', () => {
    const m = new Motion()
    m.speedKmh = 3.6
    m.onSample(sample({ speed_kmh: 3.6 }))
    m.frame(30)
    expect(m.odometerM).toBeCloseTo(0.25, 5)
  })
})
