/** Route geometry: distances along a polyline of [lat, lon] points, and where a distance lands. */

export type LatLon = [number, number]

const R = 6_371_000

export function haversine(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180
  const dLat = (b[0] - a[0]) * toRad
  const dLon = (b[1] - a[1]) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)))
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearing(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180
  const y = Math.sin((b[1] - a[1]) * toRad) * Math.cos(b[0] * toRad)
  const x =
    Math.cos(a[0] * toRad) * Math.sin(b[0] * toRad) -
    Math.sin(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.cos((b[1] - a[1]) * toRad)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export class Polyline {
  readonly points: LatLon[]
  /** cumulative[i] = distance from the start to points[i], metres. */
  readonly cumulative: number[]

  constructor(points: LatLon[]) {
    this.points = points
    this.cumulative = [0]
    for (let i = 1; i < points.length; i++) this.cumulative.push(this.cumulative[i - 1] + haversine(points[i - 1], points[i]))
  }

  get length(): number {
    return this.cumulative[this.cumulative.length - 1]
  }

  /** The point `distance` metres along the route (clamped to its ends), and the heading there. */
  at(distance: number): { point: LatLon; heading: number } {
    const pts = this.points
    const d = Math.min(Math.max(distance, 0), this.length)
    let lo = 0
    let hi = pts.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.cumulative[mid] <= d) lo = mid
      else hi = mid
    }
    const seg = this.cumulative[hi] - this.cumulative[lo]
    const t = seg > 0 ? (d - this.cumulative[lo]) / seg : 0
    const a = pts[lo]
    const b = pts[hi]
    return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b) }
  }
}
