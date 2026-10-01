/**
 * Walking in the open world: the pad decides how far (metres walked since the last frame), the
 * keys decide where. Steering keys never overlap the belt keys (controls.ts: arrows, Space,
 * Escape). Nothing here can send anything to the belt.
 */

export interface Player {
  x: number
  z: number
  /** Facing direction, radians: 0 = north (+z), positive towards east (+x). */
  heading: number
}

export const TURN_RATE = (70 * Math.PI) / 180 // radians per second while a key is held

/** Keys that turn the walker: -1 left, +1 right. */
export const STEER_KEYS: Record<string, -1 | 1> = { KeyA: -1, KeyQ: -1, KeyD: 1, KeyE: 1 }

/**
 * Move `metres` forward, sliding along whatever blocks the way (try straight on, then
 * increasingly sideways, keeping the forward part of the step). Returns the new position and
 * whether the walker was held back.
 */
export function step(p: Player, metres: number, blocked: (x: number, z: number) => boolean): { x: number; z: number; held: boolean } {
  if (metres <= 0) return { x: p.x, z: p.z, held: false }
  // Long steps (a frame hitch) in pieces, so nothing thin is jumped over.
  const pieces = Math.max(1, Math.ceil(metres / 0.5))
  let { x, z } = p
  let held = false
  for (let k = 0; k < pieces; k++) {
    const d = metres / pieces
    let moved = false
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1]) {
      const h = p.heading + turn
      const len = d * Math.cos(turn)
      const nx = x + Math.sin(h) * len
      const nz = z + Math.cos(h) * len
      if (!blocked(nx, nz)) {
        if (turn !== 0) held = true
        x = nx
        z = nz
        moved = true
        break
      }
    }
    if (!moved) {
      held = true
      break
    }
  }
  return { x, z, held }
}
