/**
 * The fantasy world's user camera: orbit around the walker (yaw), look from lower or higher
 * (elevation) and zoom, on top of the damped chase camera. Pure maths, unit-tested.
 *
 * The default view is a close chase camera: 3.6 m behind, 2 m up, looking 9 m ahead (the walker is
 * true to scale, so this keeps her a good size on screen).
 */

export interface OrbitView {
  /** Degrees around the walker; 0 = behind, 180 = in front. */
  yaw: number
  /** Degrees above the horizontal, seen from the walker. */
  elevation: number
  /** Distance factor: 1 = default, < 1 closer, > 1 further away. */
  zoom: number
}

const BACK_M = 3.6
const UP_M = 2
const LOOK_AHEAD_M = 9
const TARGET_Y = 1.1
const DISTANCE_M = Math.hypot(BACK_M, UP_M)
const ELEVATION0 = (Math.atan2(UP_M, BACK_M) * 180) / Math.PI

export const DEFAULT_VIEW: OrbitView = { yaw: 0, elevation: ELEVATION0, zoom: 1 }
export const LIMITS = { elevation: [4, 80] as const, zoom: [0.4, 8] as const }

export function clampView(v: OrbitView): OrbitView {
  const yaw = ((((v.yaw + 180) % 360) + 360) % 360) - 180
  return {
    yaw,
    elevation: Math.min(LIMITS.elevation[1], Math.max(LIMITS.elevation[0], v.elevation)),
    zoom: Math.min(LIMITS.zoom[1], Math.max(LIMITS.zoom[0], v.zoom)),
  }
}

export function isDefaultView(v: OrbitView): boolean {
  return Math.abs(v.yaw) < 0.5 && Math.abs(v.elevation - ELEVATION0) < 0.5 && Math.abs(v.zoom - 1) < 0.01
}

export interface Pose3 {
  x: number
  y: number
  z: number
}

/**
 * Camera position and look target for a walker at (x, z) on the ground (y = 0) heading
 * `heading` (radians, 0 = +z). The target lies ahead in the viewing direction, less so when
 * close or looking down, so the walker stays in the lower part of the frame.
 */
export function orbitPose(x: number, z: number, heading: number, v: OrbitView): { camera: Pose3; target: Pose3 } {
  const dir = heading + (v.yaw * Math.PI) / 180
  const e = (v.elevation * Math.PI) / 180
  const distance = DISTANCE_M * v.zoom
  const back = distance * Math.cos(e)
  const up = distance * Math.sin(e)
  const e0 = (ELEVATION0 * Math.PI) / 180
  const ahead = LOOK_AHEAD_M * Math.min(1, v.zoom) * (Math.cos(e) / Math.cos(e0)) ** 2
  return {
    camera: { x: x - Math.sin(dir) * back, y: up, z: z - Math.cos(dir) * back },
    target: { x: x + Math.sin(dir) * ahead, y: TARGET_Y, z: z + Math.cos(dir) * ahead },
  }
}

/**
 * Where the walker sprite goes, relative to its normal place: the walker's feet and head as
 * seen by the user camera vs. by the default camera (screen pixels, y down). Null: hide it
 * (behind the camera).
 */
export function walkerPlacement(
  feet: { x: number; y: number; behind: boolean },
  head: { x: number; y: number },
  refFeet: { x: number; y: number },
  refHead: { x: number; y: number },
): { dx: number; dy: number; scale: number } | null {
  if (feet.behind) return null
  const h = feet.y - head.y
  const h0 = refFeet.y - refHead.y
  if (h0 <= 0 || h <= 0) return null
  return { dx: feet.x - refFeet.x, dy: feet.y - refFeet.y, scale: h / h0 }
}

/** A rectangle in trail coordinates (s along the path, lateral to the right). */
export interface Box {
  s0: number
  s1: number
  lat0: number
  lat1: number
}

/**
 * How far along the line from the walker to the camera (0..1) the camera may go before it
 * would be inside a building: 1 if nothing is in the way. `forward` and `right` are the
 * camera's offset from the walker in trail coordinates.
 */
export function clearance(walkerS: number, forward: number, right: number, boxes: Box[], margin = 0.8, steps = 24): number {
  const inside = (t: number) => {
    const s = walkerS + forward * t
    const lat = right * t
    return boxes.some((b) => s > b.s0 - margin && s < b.s1 + margin && lat > b.lat0 - margin && lat < b.lat1 + margin)
  }
  for (let i = 1; i <= steps; i++) {
    if (inside(i / steps)) return Math.max(0.15, (i - 1) / steps)
  }
  return 1
}
