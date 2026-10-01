/**
 * Chase-camera maths for the 3D world, kept pure so it can be tested without Cesium.
 *
 * Heading looks a few metres ahead along the route, so a corner turns into a smooth curve
 * instead of a snap; heading and heights are damped (frame-rate independent); the camera sits
 * BACK_M behind and UP_M above the walker, never below the ground under it.
 */

import { type Polyline, bearing } from '../routes/geo'

export const LOOK_AHEAD_M = 12
export const BACK_M = 25
export const UP_M = 15
export const MIN_CLEARANCE_M = 4
export const HEADING_TAU_S = 0.9
export const HEIGHT_TAU_S = 0.6

/** Heading (degrees from north) from `distance` towards the point `ahead` metres further on. */
export function lookAheadHeading(line: Polyline, distance: number, ahead = LOOK_AHEAD_M): number {
  const here = line.at(distance)
  const end = Math.min(distance + ahead, line.length)
  if (end - distance < 0.5) return here.heading // at the very end: keep the last segment's heading
  return bearing(here.point, line.at(end).point)
}

/** Shortest signed difference b - a in degrees, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (((b - a) % 360) + 540) % 360 - 180
  if (d === -180) d = 180
  return d
}

/** Move `current` towards `target` (degrees) with time constant `tau`; wraps at 360. */
export function dampAngle(current: number, target: number, dt: number, tau = HEADING_TAU_S): number {
  const k = 1 - Math.exp(-Math.max(0, dt) / tau)
  return (current + angleDelta(current, target) * k + 360) % 360
}

export function damp(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / tau))
}

/** Camera offset from the walker in local east/north/up metres. */
export function chaseOffset(headingDeg: number, back = BACK_M, up = UP_M): { east: number; north: number; up: number } {
  const h = (headingDeg * Math.PI) / 180
  return { east: -Math.sin(h) * back, north: -Math.cos(h) * back, up }
}

/** Camera height above the walker's ground: UP_M, raised if the ground (or a roof) under the
 * camera is higher, so it never ends up inside the 3D tiles. */
export function cameraUp(walkerGround: number, cameraGround: number, up = UP_M): number {
  return Math.max(up, cameraGround - walkerGround + MIN_CLEARANCE_M)
}
