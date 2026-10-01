/**
 * Roads between the settlements: a minimum spanning tree (every town reachable) plus a few
 * shortcuts, each routed by A* over a half-resolution cost grid where steep ground is expensive,
 * rivers cost a bridge, lakes and the sea are impassable, and existing roads are cheap (roads
 * merge into a network instead of running in parallel). Paths are smoothed into curves.
 */

import { MinHeap } from './heap'
import { chaikin } from './smooth'
import { isLand } from './places'
import { type Place, type Road, Water } from './types'

const REUSE = 0.3
const BRIDGE = 14
const SHORTCUT_M = 2200

export function buildRoads(
  n: number, cell: number, slope: Float32Array, water: Uint8Array, mainland: Uint8Array, places: Place[],
): Road[] {
  const nodes = places.filter((p) => p.kind === 'city' || p.kind === 'village' || p.kind === 'castle')
  if (nodes.length < 2) return []
  const m = n >> 1 // coarse grid
  const cc = cell * 2
  const fine = (ci: number, cj: number) => Math.min(n - 1, cj * 2) * n + Math.min(n - 1, ci * 2)
  const cost = new Float32Array(m * m)
  const bridge = new Uint8Array(m * m)
  for (let cj = 0; cj < m; cj++) {
    for (let ci = 0; ci < m; ci++) {
      const f = fine(ci, cj)
      const k = cj * m + ci
      // Passable when any of its fine cells is mainland: narrow land bridges stay connected.
      const quad = [f, Math.min(n * n - 1, f + 1), Math.min(n * n - 1, f + n), Math.min(n * n - 1, f + n + 1)]
      if (!quad.some((q) => isLand(water[q]) && mainland[q])) {
        cost[k] = Infinity
        continue
      }
      const s = Math.max(slope[f], slope[Math.min(n * n - 1, f + 1)], slope[Math.min(n * n - 1, f + n)])
      cost[k] = 1 + (s * 9) ** 2
      if (water[f] === Water.River || water[Math.min(n * n - 1, f + 1)] === Water.River || water[Math.min(n * n - 1, f + n)] === Water.River) {
        cost[k] += BRIDGE
        bridge[k] = 1
      }
    }
  }
  const used = new Uint8Array(m * m)
  const cellOf = (p: Place) => Math.min(m - 1, Math.floor(p.z / cc)) * m + Math.min(m - 1, Math.floor(p.x / cc))

  // Edges: minimum spanning tree (Prim) plus shortcuts to near neighbours.
  const dist = (a: Place, b: Place) => Math.hypot(a.x - b.x, a.z - b.z)
  const inTree = new Set<number>([0])
  const edges: [number, number][] = []
  while (inTree.size < nodes.length) {
    let best: [number, number] | null = null
    let bestD = Infinity
    for (const a of inTree) {
      for (let b = 0; b < nodes.length; b++) {
        if (inTree.has(b)) continue
        const d = dist(nodes[a], nodes[b])
        if (d < bestD) {
          bestD = d
          best = [a, b]
        }
      }
    }
    if (!best) break
    edges.push(best)
    inTree.add(best[1])
  }
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
  const have = new Set(edges.map(([a, b]) => key(a, b)))
  for (let a = 0; a < nodes.length; a++) {
    const near = nodes
      .map((p, b) => ({ b, d: dist(nodes[a], p) }))
      .filter((e) => e.b !== a && e.d < SHORTCUT_M && !have.has(key(a, e.b)))
      .sort((x, y) => x.d - y.d)[0]
    if (near) {
      edges.push([a, near.b])
      have.add(key(a, near.b))
    }
  }
  edges.sort((x, y) => dist(nodes[x[0]], nodes[x[1]]) - dist(nodes[y[0]], nodes[y[1]]))

  const g = new Float32Array(m * m)
  const from = new Int32Array(m * m)
  const roads: Road[] = []
  // Union-find over the towns: an edge that cannot be routed is replaced by the next nearest
  // town in another group, so every town ends up on the network.
  const group = nodes.map((_, i) => i)
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])))
  const route = (a: number, b: number) => astar(cellOf(nodes[a]), cellOf(nodes[b]), m, cost, used, g, from)
  const queue = [...edges]
  while (queue.length) {
    const [a, b] = queue.shift()!
    let path = route(a, b)
    if (!path) {
      if (find(a) === find(b)) continue // already linked another way
      const fallback = nodes
        .map((p, k) => ({ k, d: dist(nodes[a], p) }))
        .filter((e) => find(e.k) !== find(a))
        .sort((x, y) => x.d - y.d)
        .slice(0, 6)
      let found = -1
      for (const e of fallback) {
        path = route(a, e.k)
        if (path) {
          found = e.k
          break
        }
      }
      if (!path || found < 0) continue
      roads.push(...finish(a, found, path))
      continue
    }
    roads.push(...finish(a, b, path))
  }
  return roads

  function finish(a: number, b: number, path: number[]): Road[] {
    group[find(a)] = find(b)
    for (const k of path) used[k] = 1
    const pts = path.map((k): [number, number] => [((k % m) + 0.5) * cc, (Math.floor(k / m) + 0.5) * cc])
    pts[0] = [nodes[a].x, nodes[a].z]
    pts[pts.length - 1] = [nodes[b].x, nodes[b].z]
    const bridges: [number, number][] = []
    let run: number[] = []
    for (const k of [...path, -1]) {
      if (k >= 0 && bridge[k]) run.push(k)
      else if (run.length) {
        const mid = run[Math.floor(run.length / 2)]
        bridges.push([((mid % m) + 0.5) * cc, (Math.floor(mid / m) + 0.5) * cc])
        run = []
      }
    }
    return [{ from: nodes[a].id, to: nodes[b].id, points: chaikin(simplify(pts), 2), bridges }]
  }
}

function astar(
  start: number, goal: number, m: number, cost: Float32Array, used: Uint8Array, g: Float32Array, from: Int32Array,
): number[] | null {
  g.fill(Infinity)
  from.fill(-1)
  const gi = goal % m
  const gj = (goal - gi) / m
  const h = (k: number) => Math.hypot((k % m) - gi, Math.floor(k / m) - gj) * REUSE
  const heap = new MinHeap(4096)
  g[start] = 0
  heap.push(h(start), start)
  while (heap.size > 0) {
    const f = heap.peekKey()
    const k = heap.pop()
    if (k === goal) break
    const i = k % m
    const j = (k - i) / m
    if (f > g[k] + h(k) + 1e-6) continue // stale entry
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue
        const ni = i + di
        const nj = j + dj
        if (ni < 0 || nj < 0 || ni >= m || nj >= m) continue
        const nb = nj * m + ni
        const c = cost[nb]
        if (c === Infinity && nb !== goal) continue
        const step = (di && dj ? Math.SQRT2 : 1) * (used[nb] ? Math.min(c, 1) * REUSE : c === Infinity ? 1 : c)
        const ng = g[k] + step
        if (ng < g[nb]) {
          g[nb] = ng
          from[nb] = k
          heap.push(ng + h(nb), nb)
        }
      }
    }
  }
  if (g[goal] === Infinity) return null
  const path: number[] = []
  for (let k = goal; k !== -1; k = from[k]) path.push(k)
  return path.reverse()
}

/** Drop points on straight runs. */
function simplify(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, az] = out[out.length - 1]
    const [bx, bz] = pts[i]
    const [cx, cz] = pts[i + 1]
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
    if (Math.abs(cross) > 1e-6) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}
