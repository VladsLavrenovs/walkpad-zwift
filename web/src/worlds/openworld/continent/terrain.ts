/**
 * The landmass and its relief: an organic coastline from domain-warped noise and a soft falloff
 * towards the map edge (always sea there), rolling lowlands, and mountain ranges of ridged noise
 * where a slow "range" field says so.
 */

import { fbm, noise2 } from '../../fantasy/gen'

function smooth(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

/** Ridged multifractal-ish noise in [0, 1]: sharp crests, wide valleys. */
function ridged(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  let weight = 1
  for (let o = 0; o < octaves; o++) {
    let v = 1 - Math.abs(noise2(seed + o * 7919, x * freq, z * freq))
    v *= v
    v *= weight
    weight = Math.min(1, v * 1.6)
    sum += v * amp
    norm += amp
    amp *= 0.5
    freq *= 2.03
  }
  return sum / norm
}

/**
 * "Continentalness" at normalised map coordinates (u, v in [0, 1]): noise shapes the land
 * (bays, peninsulas, islands); a gentle pull towards the middle and a guard band keep open sea
 * at the map edge. Land is where it exceeds the sea shift chosen by `buildHeights`.
 */
export function continentalness(seed: number, u: number, v: number): number {
  const nx = u * 2 - 1
  const nz = v * 2 - 1
  // Domain warp: bends the coast into bays and peninsulas.
  const wx = nx + 0.34 * fbm(seed + 11, nx * 1.6 + 3.1, nz * 1.6 - 1.3, 4)
  const wz = nz + 0.34 * fbm(seed + 12, nx * 1.6 - 5.7, nz * 1.6 + 2.9, 4)
  const d2 = wx * wx + wz * wz
  let cont = 0.2 - d2 * 0.8 + 0.8 * fbm(seed + 13, nx * 2.2 + 9.7, nz * 2.2 + 4.1, 5) + 0.12 * fbm(seed + 19, nx * 7 - 2.2, nz * 7 + 5.5, 3)
  cont -= smooth((Math.sqrt(d2) - 0.85) / 0.25) * 1.2
  // Guard: open sea beyond a circle well inside the map edge (a coast that reaches it curves
  // with it instead of running along a straight map border).
  cont -= smooth((Math.hypot(nx, nz) - 0.92) / 0.08) * 3
  return cont
}

/**
 * Ground height in metres from continentalness (minus the sea shift: > 0 is land); negative is
 * sea floor. Pure and continuous, so it can be sampled at any resolution.
 */
export function elevationAt(seed: number, u: number, v: number, seaShift: number, contHere?: number): number {
  const nx = u * 2 - 1
  const nz = v * 2 - 1
  const cont = (contHere ?? continentalness(seed, u, v)) - seaShift
  if (cont <= 0) return Math.max(-160, cont * 900 - 1.5) // the sea gets deep quickly off the coast
  const land = smooth(cont / 0.12) // 0 at the shore, 1 inland
  // Mountain ranges: a slow field picks where they run; ridged noise shapes them.
  const range = smooth((fbm(seed + 14, nx * 1.25 - 2.3, nz * 1.25 + 7.7, 3) + 0.02) / 0.3)
  const crest = ridged(seed + 15, nx * 4.2 + 11.1, nz * 4.2 - 3.3, 5)
  const mountains = range * Math.pow(crest, 1.6) * 640
  // Lowland roll and small hills everywhere.
  const roll = (fbm(seed + 16, nx * 3.1 + 1.9, nz * 3.1 + 8.3, 4) * 0.5 + 0.5) * 70
  const hills = fbm(seed + 17, nx * 11 - 4.4, nz * 11 + 6.6, 3) * 16
  return 1.2 + cont * 60 + (roll + hills) * land + mountains * land
}

/** Slow field in [0, 1]: where the old elven lands were (ruins). */
export function loreAt(seed: number, u: number, v: number): number {
  return Math.min(1, Math.max(0, fbm(seed + 18, u * 7.3 + 2.2, v * 7.3 - 9.1, 3) * 0.9 + 0.5))
}

/** Share of the map that is land: the sea level is set so every seed gets about this much. */
export const LAND_SHARE = 0.47

/** Heights of every cell centre of an n x n grid, and the sea shift used (keep it for sampling). */
export function buildHeights(seed: number, n: number): { height: Float32Array; seaShift: number } {
  const cont = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) cont[j * n + i] = continentalness(seed, (i + 0.5) / n, (j + 0.5) / n)
  }
  const sorted = Float32Array.from(cont).sort()
  const seaShift = sorted[Math.floor((1 - LAND_SHARE) * (sorted.length - 1))]
  const height = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) height[j * n + i] = elevationAt(seed, (i + 0.5) / n, (j + 0.5) / n, seaShift, cont[j * n + i])
  }
  return { height, seaShift }
}

/** Slope (rise over run) of the land by central differences; the sea floor counts as sea level,
 * so the drop-off under water does not make every coast a cliff. */
export function buildSlopes(height: Float32Array, n: number, cell: number): Float32Array {
  const h = height.map((v) => Math.max(0, v))
  const s = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const l = h[j * n + Math.max(0, i - 1)]
      const r = h[j * n + Math.min(n - 1, i + 1)]
      const b = h[Math.max(0, j - 1) * n + i]
      const t = h[Math.min(n - 1, j + 1) * n + i]
      s[j * n + i] = Math.hypot(r - l, t - b) / (2 * cell)
    }
  }
  return s
}

/** Box blur (radius 1), `passes` times: the lie of the land rather than single-cell bumps. */
export function blur(field: Float32Array, n: number, passes = 2): Float32Array {
  let src = field
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(n * n)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let sum = 0
        let count = 0
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const a = i + di
            const b = j + dj
            if (a < 0 || b < 0 || a >= n || b >= n) continue
            sum += src[b * n + a]
            count++
          }
        }
        out[j * n + i] = sum / count
      }
    }
    src = out
  }
  return src
}
