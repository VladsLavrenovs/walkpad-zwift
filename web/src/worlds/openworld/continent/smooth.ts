/** Polyline smoothing shared by rivers and roads. */

/** Corner cutting: gentle curves, endpoints kept. */
export function chaikin(pts: [number, number][], rounds: number): [number, number][] {
  let p = pts
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const out: [number, number][] = [p[0]]
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i]
      const [bx, bz] = p[i + 1]
      out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75])
    }
    out.push(p[p.length - 1])
    p = out
  }
  return p
}
