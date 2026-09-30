/**
 * Turns 1-2 Hz pad samples into smooth per-frame motion.
 *
 * - Speed: exponential moving average towards the last reported speed (time constant TAU_S),
 *   so steps in the pad's speed become gentle ramps.
 * - World odometer: advances by smoothed speed x dt every frame and never jumps or goes back.
 *   Worlds move by this.
 * - HUD distance: the same integration, but held inside what the pad reports. The owner's pad
 *   counts distance in 10 m steps (it floors), so the true distance lies in [pad, pad + 10).
 * - HUD time: the pad's counter, interpolated between samples, never ahead by more than
 *   MAX_TIME_LEAD_S (the pad stops counting when nobody walks) and never backwards.
 * - Cadence (steps/s, drives the walker): belt speed / step length. Step length starts from a
 *   model and is calibrated from the pad's step counter when it counts, so the animation is
 *   as smooth as the speed but matches how the owner actually walks.
 */

import type { SampleMsg } from './bridge'

export const TAU_S = 0.6
export const STOPPED_KMH = 0.05
const MAX_TIME_LEAD_S = 1.5
const STEP_LEN_MIN_M = 0.25
const STEP_LEN_MAX_M = 1.0
const STEP_LEN_ALPHA = 0.2

/** EMA weight for a frame of `dt` seconds with time constant `tau`. Frame-rate independent. */
export function emaAlpha(dt: number, tau: number): number {
  return 1 - Math.exp(-Math.max(0, dt) / tau)
}

/** Typical step length at a walking speed; the same model as the bridge's FAKE pad. */
export function modelStepLength(kmh: number): number {
  return 0.45 + 0.05 * kmh
}

/** Pad distance resolution by protocol: KingSmith reports in 10 m steps. */
export function distanceResolution(protocol: string | null): number {
  return protocol === 'kingsmith' ? 10 : 1
}

export class Motion {
  /** Smoothed belt speed, km/h. */
  speedKmh = 0
  /** Monotonic distance for worlds, metres. Never resets. */
  odometerM = 0
  /** Session distance for the HUD, metres. */
  distanceM = 0
  /** Session time for the HUD, seconds. */
  elapsedS = 0
  /** Latest step count from the pad (null: the pad has none). */
  steps: number | null = null
  /** Calibrated step length, metres (null: not calibrated yet, use the model). */
  stepLengthM: number | null = null
  /** Metres moved in the last frame (for anything that advances with the world). */
  lastMetres = 0

  private reportedKmh = 0
  private padDistance = 0
  private padElapsed = 0
  private running = false
  private session: number | null = null
  private resolution = 1
  private lastStepsAt: { steps: number; odometer: number } | null = null

  setProtocol(protocol: string | null): void {
    this.resolution = distanceResolution(protocol)
  }

  onSample(s: SampleMsg): void {
    const newSession = s.session_id !== this.session
    const counterReset = s.distance_m < this.padDistance || s.elapsed_s < this.padElapsed
    if (newSession || counterReset) {
      this.distanceM = s.distance_m
      this.elapsedS = s.elapsed_s
      this.lastStepsAt = null
    }
    this.session = s.session_id
    this.reportedKmh = s.speed_kmh
    this.padDistance = s.distance_m
    this.padElapsed = s.elapsed_s
    this.running = s.belt === 'running' && s.speed_kmh > 0
    this.calibrate(s.steps)
    this.steps = s.steps
    // Keep the HUD inside what the pad just reported.
    this.distanceM = clamp(this.distanceM, s.distance_m, s.distance_m + this.resolution)
    this.elapsedS = clamp(this.elapsedS, s.elapsed_s, s.elapsed_s + MAX_TIME_LEAD_S)
  }

  /** Belt/pad gone: coast down to zero. */
  onDisconnect(): void {
    this.reportedKmh = 0
    this.running = false
  }

  frame(dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.25) // a background tab must not teleport the world
    this.speedKmh += (this.reportedKmh - this.speedKmh) * emaAlpha(dt, TAU_S)
    if (this.reportedKmh === 0 && this.speedKmh < STOPPED_KMH) this.speedKmh = 0
    const metres = (this.speedKmh / 3.6) * dt
    this.lastMetres = metres
    this.odometerM += metres
    this.distanceM = Math.min(this.distanceM + metres, this.padDistance + this.resolution)
    if (this.running) {
      this.elapsedS = Math.min(this.elapsedS + dt, this.padElapsed + MAX_TIME_LEAD_S)
    }
  }

  /** Walking cadence in steps per second (0 when stopped). */
  cadence(): number {
    if (this.speedKmh <= STOPPED_KMH) return 0
    const stepLength = this.stepLengthM ?? modelStepLength(this.speedKmh)
    return this.speedKmh / 3.6 / stepLength
  }

  private calibrate(steps: number | null): void {
    if (steps === null || !this.running) {
      this.lastStepsAt = null
      return
    }
    const prev = this.lastStepsAt
    if (prev === null || steps < prev.steps) {
      this.lastStepsAt = { steps, odometer: this.odometerM }
      return
    }
    const dSteps = steps - prev.steps
    const dMetres = this.odometerM - prev.odometer
    // Integer steps at 1 Hz are coarse: measure over at least 4 steps.
    if (dSteps < 4) return
    const measured = clamp(dMetres / dSteps, STEP_LEN_MIN_M, STEP_LEN_MAX_M)
    this.stepLengthM =
      this.stepLengthM === null ? measured : this.stepLengthM + (measured - this.stepLengthM) * STEP_LEN_ALPHA
    this.lastStepsAt = { steps, odometer: this.odometerM }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
