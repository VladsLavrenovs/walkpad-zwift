/**
 * Scattered props for the fantasy world: stylised vegetation and small props built in code
 * (vertex colours, soft normals), plus kit models (assets.ts) for walls, fences, crates and the
 * wagon. A prop kind is one or more parts; each part becomes one InstancedMesh per terrain chunk,
 * so a whole forest is a handful of draw calls. Grass, crops, ferns and tree crowns sway in the
 * wind (shaders.ts).
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MODEL_FOR, type Kit, boxUV } from './assets'
import { hashInts, type PropKind } from './gen'
import { addWind } from './shaders'

export interface Part {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Cast shadows (big, solid things only). */
  shadow: boolean
  /** Takes the per-instance colour (flower heads, neon); otherwise only brightness varies. */
  tinted?: boolean
}

/** Vertex colours, optionally shaded from `dark` at the bottom to the colour at the top. */
function painted(geometry: THREE.BufferGeometry, color: string, dark = 1): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute('uv')
  const c = new THREE.Color(color)
  g.computeBoundingBox()
  const { min, max } = g.boundingBox!
  const p = g.getAttribute('position')
  const colors = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) {
    const t = max.y > min.y ? (p.getY(i) - min.y) / (max.y - min.y) : 1
    const k = dark + (1 - dark) * t
    colors.set([c.r * k, c.g * k, c.b * k], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

/** Push vertices in or out a little (same position, same push: no cracks). */
function lumpy(geometry: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = geometry.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const h = hashInts(seed, Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000)) / 4294967296
    const k = 1 + (h - 0.5) * 2 * amount
    p.setXYZ(i, x * k, y * k, z * k)
  }
  return geometry
}

function at(geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0, ry = 0): THREE.BufferGeometry {
  geometry.rotateX(rx)
  geometry.rotateZ(rz)
  geometry.rotateY(ry)
  geometry.translate(x, y, z)
  return geometry
}

function merged(...parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts)
  if (!g) throw new Error('could not merge prop geometry')
  return g
}

/** A soft foliage blob: a lumpy icosphere with radial normals, darker underneath. */
function blob(r: number, x: number, y: number, z: number, color: string, seed: number, sy = 0.85): THREE.BufferGeometry {
  const g = lumpy(new THREE.IcosahedronGeometry(r, 1), 0.16, seed)
  g.scale(1, sy, 1).translate(x, y, z)
  return painted(g, color, 0.55)
}

type Blade = [number, number, number, number, number] // x, z, height, lean, lean direction

/** Thin tapered, bending blades, coloured from `base` to `tip`. */
function blades(list: Blade[], width: number, base: string, tip: string): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const b = new THREE.Color(base)
  const t = new THREE.Color(tip)
  const c = new THREE.Color()
  for (const [x, z, h, lean, dir] of list) {
    const dx = Math.cos(dir)
    const dz = Math.sin(dir)
    const px = -dz * width
    const pz = dx * width
    const pt = (f: number, side: number): number[] => {
      const bend = Math.sin(lean) * h * f * f
      const w = (1 - f) * side
      return [x + px * w + dx * bend, h * f * Math.cos(lean * f), z + pz * w + dz * bend]
    }
    const v = [pt(0, -1), pt(0, 1), pt(0.5, -1), pt(0.5, 1), pt(1, 0)]
    for (const tri of [[0, 1, 2], [2, 1, 3], [2, 3, 4]]) {
      for (const k of tri) {
        pos.push(...v[k])
        c.copy(b).lerp(t, k < 2 ? 0 : k < 4 ? 0.55 : 1)
        col.push(c.r, c.g, c.b)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  // Normals straight up: blades light like the ground they grow from (no dark backfaces).
  const n = new Float32Array(pos.length)
  for (let i = 1; i < n.length; i += 3) n[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3))
  return g
}

function clump(seed: number, count: number, radius: number, h0: number, h1: number, lean: number): Blade[] {
  const out: Blade[] = []
  for (let i = 0; i < count; i++) {
    const r = (k: number) => hashInts(seed, i, k) / 4294967296
    const a = r(1) * Math.PI * 2
    const d = Math.sqrt(r(2)) * radius
    out.push([Math.cos(a) * d, Math.sin(a) * d, h0 + r(3) * (h1 - h0), lean * (0.4 + r(4)), a + (r(5) - 0.5)])
  }
  return out
}

/** Window grid texture for city towers (emissive at night). */
function windowsTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#0d1018'
  ctx.fillRect(0, 0, 64, 128)
  for (let y = 4; y < 128; y += 8) {
    for (let x = 4; x < 64; x += 8) {
      const on = (x * 7 + y * 13) % 5 < 2
      ctx.fillStyle = on ? (((x + y) % 3 === 0) ? '#ffcf6b' : '#9fe6ff') : '#151a26'
      ctx.fillRect(x, y, 5, 5)
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(2, 4)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class PropLibrary {
  readonly parts: Record<PropKind, Part[]>
  private readonly disposables: { dispose(): void }[] = []

  constructor() {
    const lit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })
    const faceted = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })
    const crowns = addWind(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 0.07, 9)
    const grass = addWind(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }), 0.16, 0.8)
    const crops = addWind(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }), 0.13, 1.3)
    // Light sources are exempt from tone mapping, which would wash their colours out.
    const glow = (color: string) => new THREE.MeshBasicMaterial({ color, fog: true, toneMapped: false })
    const crystal = new THREE.MeshStandardMaterial({
      color: '#7fe9ff', emissive: '#2bd6ff', emissiveIntensity: 1.6, flatShading: true, roughness: 0.2,
    })
    const mushroom = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: '#3a1f6b', emissiveIntensity: 0.6 })
    const tex = windowsTexture()
    const tower = new THREE.MeshStandardMaterial({
      color: '#c9cfe0', map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 1.1, roughness: 0.7,
    })
    const neon = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: true, toneMapped: false })
    const bulb = glow('#ffd98a')
    this.disposables.push(lit, faceted, crowns, grass, crops, crystal, mushroom, tex, tower, neon, bulb)

    const P = (geometry: THREE.BufferGeometry, material: THREE.Material = lit, shadow = true, tinted = false): Part => {
      this.disposables.push(geometry)
      return { geometry, material, shadow, tinted }
    }
    const trunk = (h: number, r0: number, r1: number, color: string) =>
      painted(at(new THREE.CylinderGeometry(r1, r0, h, 7), 0, h / 2, 0), color, 0.7)

    const pineCrown: THREE.BufferGeometry[] = []
    const tiers = 5
    for (let i = 0; i < tiers; i++) {
      const r = 2.4 * (1 - i / (tiers + 0.6))
      const cone = lumpy(new THREE.ConeGeometry(r, 2.6 - i * 0.2, 10, 1), 0.1, 300 + i)
      pineCrown.push(painted(at(cone, 0, 2.6 + i * 1.25, 0, 0, 0, i * 0.7), ['#163a26', '#1a4430', '#1f4f37', '#23593d', '#2a6545'][i], 0.45))
    }
    const oakCrown = [
      blob(1.9, 0, 4.4, 0, '#3f7a33', 1), blob(1.5, 1.4, 3.8, 0.6, '#4a8a3a', 2), blob(1.4, -1.3, 3.9, -0.4, '#467f36', 3),
      blob(1.3, 0.2, 3.7, -1.4, '#3c7231', 4), blob(1.2, -0.3, 5.5, 0.4, '#56993f', 5), blob(1.1, 0.6, 3.6, 1.5, '#43803a', 6),
    ]
    const birchCrown = [
      blob(1.2, 0, 5.4, 0, '#8db84a', 11, 1.1), blob(1.0, 0.8, 4.6, 0.3, '#9cc456', 12, 1.1),
      blob(0.95, -0.7, 4.8, -0.3, '#86b046', 13, 1.1), blob(0.8, 0.1, 6.4, 0.2, '#a6cc60', 14, 1.1),
    ]
    const mossyRock = (() => {
      const g = lumpy(new THREE.IcosahedronGeometry(0.9, 1), 0.28, 21).scale(1.3, 0.75, 1.1).translate(0, 0.32, 0)
      g.computeVertexNormals()
      const p = g.getAttribute('position')
      const n = g.getAttribute('normal')
      const col = new Float32Array(p.count * 3)
      const rock = new THREE.Color('#7b7c78')
      const moss = new THREE.Color('#4f7a34')
      const c = new THREE.Color()
      for (let i = 0; i < p.count; i++) {
        c.copy(rock).lerp(moss, Math.max(0, Math.min(1, (n.getY(i) - 0.45) * 2.2))).multiplyScalar(0.8 + 0.2 * (p.getY(i) + 0.3))
        col.set([c.r, c.g, c.b], i * 3)
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3))
      g.deleteAttribute('uv')
      return g
    })()
    const fronds: Blade[] = []
    for (let i = 0; i < 9; i++) fronds.push([0, 0, 0.8 + (i % 3) * 0.12, 1.1, (i / 9) * Math.PI * 2])

    this.parts = {
      pine: [
        P(trunk(2.6, 0.3, 0.16, '#4a3424')),
        P(merged(...pineCrown), crowns),
      ],
      oak: [
        P(merged(
          trunk(3.6, 0.38, 0.22, '#5a4030'),
          painted(at(new THREE.CylinderGeometry(0.07, 0.14, 1.8, 5), 0.7, 3.3, 0, 0, -0.8), '#5a4030'),
          painted(at(new THREE.CylinderGeometry(0.07, 0.14, 1.6, 5), -0.6, 3.1, 0.2, 0.3, 0.8), '#5a4030'),
        )),
        P(merged(...oakCrown), crowns),
      ],
      birch: [
        P(merged(
          trunk(4.6, 0.17, 0.1, '#e6e1d6'),
          painted(at(new THREE.CylinderGeometry(0.175, 0.175, 0.12, 7), 0, 1.2, 0), '#2e2b28'),
          painted(at(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 7), 0, 2.4, 0), '#2e2b28'),
          painted(at(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 7), 0, 3.4, 0), '#2e2b28'),
        )),
        P(merged(...birchCrown), crowns),
      ],
      deadtree: [P(merged(
        trunk(4.5, 0.24, 0.1, '#4d4540'),
        painted(at(new THREE.CylinderGeometry(0.05, 0.1, 1.8, 4), 0.6, 3.4, 0, 0, -0.9), '#4d4540'),
        painted(at(new THREE.CylinderGeometry(0.05, 0.1, 1.4, 4), -0.5, 2.6, 0, 0, 0.8), '#4d4540'),
      ))],
      rock: [P(mossyRock, faceted)],
      bush: [P(merged(
        blob(0.8, 0, 0.6, 0, '#2f5a2c', 31), blob(0.6, 0.6, 0.45, 0.2, '#386a33', 32), blob(0.55, -0.5, 0.45, -0.2, '#2c5529', 33),
      ), crowns, false)],
      mushroom: [P(merged(
        painted(at(new THREE.CylinderGeometry(0.06, 0.08, 0.35, 6), 0, 0.17, 0), '#e8e2d0'),
        painted(at(new THREE.SphereGeometry(0.22, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.33, 0), '#b8382f'),
        painted(at(new THREE.CylinderGeometry(0.04, 0.05, 0.22, 6), 0.22, 0.11, 0.1), '#e8e2d0'),
        painted(at(new THREE.SphereGeometry(0.13, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0.22, 0.21, 0.1), '#c4452f'),
      ), mushroom, false)],
      fern: [P(blades(fronds, 0.13, '#1d4a22', '#4f8f3a'), grass, false)],
      pillar: [P(merged(
        painted(at(new THREE.CylinderGeometry(0.42, 0.48, 4.2, 10), 0, 2.1, 0), '#b9b6a8', 0.8),
        painted(at(new THREE.BoxGeometry(1.2, 0.35, 1.2), 0, 4.3, 0), '#a8a596'),
        painted(at(new THREE.BoxGeometry(1.3, 0.4, 1.3), 0, 0.2, 0), '#a8a596'),
      ))],
      arch: [P(merged(
        painted(at(new THREE.BoxGeometry(0.9, 5.5, 0.9), -2.6, 2.75, 0), '#b4b1a2', 0.8),
        painted(at(new THREE.BoxGeometry(0.9, 5.5, 0.9), 2.6, 2.75, 0), '#b4b1a2', 0.8),
        painted(at(new THREE.BoxGeometry(6.4, 0.8, 1.0), 0, 5.9, 0), '#a7a495'),
        painted(at(new THREE.ConeGeometry(0.5, 0.9, 4), 0, 6.75, 0), '#a7a495'),
      ))],
      ruinwall: [P(merged(
        painted(at(new THREE.BoxGeometry(4.5, 1.6, 0.6), 0, 0.8, 0), '#a3a091'),
        painted(at(new THREE.BoxGeometry(2.2, 1.0, 0.6), -1.1, 2.1, 0), '#a3a091'),
      ))],
      crystal: [P(new THREE.OctahedronGeometry(0.5, 0).scale(0.6, 2.2, 0.6).translate(0, 1.0, 0), crystal, false)],
      grass: [P(blades(clump(41, 11, 0.32, 0.35, 0.75, 0.5), 0.045, '#2c5420', '#9ccb5c'), grass, false)],
      flower: [
        P(blades(clump(42, 5, 0.12, 0.35, 0.5, 0.25), 0.03, '#2c5a24', '#4f8f3a'), grass, false),
        P(merged(
          painted(at(new THREE.IcosahedronGeometry(0.1, 0).scale(1, 0.5, 1), 0, 0.48, 0), '#ffffff'),
          painted(at(new THREE.IcosahedronGeometry(0.08, 0).scale(1, 0.5, 1), 0.09, 0.38, 0.05), '#ffffff'),
          painted(at(new THREE.IcosahedronGeometry(0.08, 0).scale(1, 0.5, 1), -0.08, 0.42, -0.06), '#ffffff'),
        ), crops, false, true),
      ],
      reed: [P(merged(
        blades(clump(43, 7, 0.25, 1.1, 1.8, 0.2), 0.035, '#4f5f2c', '#8a9a4c'),
        painted(at(new THREE.CylinderGeometry(0.05, 0.05, 0.35, 5), 0, 1.65, 0), '#5a3b25'),
      ), crops, false)],
      wheat: [P(merged(
        blades(clump(44, 16, 0.5, 0.85, 1.15, 0.15), 0.02, '#7d6e30', '#e6c66a'),
        blades(clump(45, 6, 0.45, 0.95, 1.2, 0.3), 0.035, '#8a7a36', '#f0d27a'),
      ), crops, false)],
      cabbage: [P(merged(
        blob(0.26, 0, 0.2, 0, '#6aa84a', 46, 0.8),
        blades(clump(47, 6, 0.1, 0.25, 0.35, 1.2), 0.08, '#3e7a32', '#7fbf5a'),
      ), grass, false)],
      lavender: [P(merged(
        blades(clump(48, 10, 0.25, 0.4, 0.6, 0.3), 0.025, '#3f6a3a', '#6f8f5a'),
        ...clump(49, 10, 0.3, 0.6, 0.85, 0).map(([x, z, h]) => painted(at(new THREE.ConeGeometry(0.05, 0.28, 4), x, h, z, Math.PI), '#8a6ad0')),
      ), crops, false)],
      haybale: [P(merged(
        painted(at(new THREE.CylinderGeometry(0.75, 0.75, 1.25, 16), 0, 0.72, 0, 0, Math.PI / 2), '#cfae5a', 0.75),
        painted(at(new THREE.CylinderGeometry(0.55, 0.55, 1.27, 16), 0, 0.72, 0, 0, Math.PI / 2), '#b8923e'),
      ))],
      scarecrow: [P(merged(
        painted(at(new THREE.CylinderGeometry(0.05, 0.06, 2.2, 5), 0, 1.1, 0), '#5a4030'),
        painted(at(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 5), 0, 1.65, 0, 0, Math.PI / 2), '#5a4030'),
        painted(at(new THREE.BoxGeometry(0.5, 0.65, 0.25), 0, 1.5, 0), '#8a3b2a'),
        painted(at(new THREE.SphereGeometry(0.17, 8, 6), 0, 2.0, 0), '#d9c08a'),
        painted(at(new THREE.ConeGeometry(0.32, 0.32, 8), 0, 2.27, 0), '#4a3a28'),
      ))],
      barrel: [P(merged(
        painted(at(new THREE.CylinderGeometry(0.36, 0.36, 0.95, 12), 0, 0.475, 0), '#7a5634', 0.75),
        painted(at(new THREE.CylinderGeometry(0.4, 0.4, 0.95 * 0.55, 12), 0, 0.475, 0), '#7f5a36', 0.8),
        painted(at(new THREE.CylinderGeometry(0.405, 0.405, 0.06, 12), 0, 0.2, 0), '#2e2b2a'),
        painted(at(new THREE.CylinderGeometry(0.405, 0.405, 0.06, 12), 0, 0.75, 0), '#2e2b2a'),
      ))],
      stall: [P(merged(
        ...[[-1.1, -0.7], [1.1, -0.7], [-1.1, 0.7], [1.1, 0.7]].map(([x, z]) =>
          painted(at(new THREE.BoxGeometry(0.1, 2.3, 0.1), x, 1.15, z), '#5a4030')),
        painted(at(new THREE.BoxGeometry(2.3, 0.9, 1.0), 0, 0.45, 0.2), '#6e4f35', 0.7),
        painted(at(new THREE.BoxGeometry(2.2, 0.12, 0.9), 0, 0.96, 0.2), '#d8a040'),
        ...[0, 1, 2, 3, 4, 5].map((i) => painted(at(new THREE.BoxGeometry(2.6 / 6, 0.05, 1.9), -1.3 + 2.6 / 12 + (i * 2.6) / 6, 2.35, 0.05, 0.22), i % 2 ? '#efe4cf' : '#b8382f')),
      ))],
      well: [P(merged(
        painted(at(new THREE.CylinderGeometry(0.85, 0.9, 0.9, 14, 1, true), 0, 0.45, 0), '#8d8a80', 0.7),
        painted(at(new THREE.CylinderGeometry(0.7, 0.7, 0.05, 14), 0, 0.6, 0), '#24384a'),
        painted(at(new THREE.BoxGeometry(0.12, 2.0, 0.12), -0.8, 1.0, 0), '#5a4030'),
        painted(at(new THREE.BoxGeometry(0.12, 2.0, 0.12), 0.8, 1.0, 0), '#5a4030'),
        painted(at(new THREE.BoxGeometry(1.0, 0.06, 1.4), -0.45, 2.15, 0, 0, 0.6), '#7d3a2c'),
        painted(at(new THREE.BoxGeometry(1.0, 0.06, 1.4), 0.45, 2.15, 0, 0, -0.6), '#7d3a2c'),
        painted(at(new THREE.CylinderGeometry(0.15, 0.12, 0.25, 8), 0, 1.3, 0), '#6e4f35'),
      ))],
      tower: [P(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), tower, true)],
      neon: [P(new THREE.BoxGeometry(4.2, 0.9, 0.15).translate(0, 0.45, 0), neon, false, true)],
      // Glowing kerb strips along both sides of the street.
      strip: [P(new THREE.BoxGeometry(0.08, 0.06, 3.2).translate(0, 0.03, 0), neon, false, true)],
      // Kit-backed kinds (useKit) with simple stand-ins until the models have loaded.
      ruinwindow: [P(merged(painted(at(new THREE.BoxGeometry(2, 3, 0.4), 0, 1.5, 0), '#8d8577')))],
      ruindoor: [P(merged(
        painted(at(new THREE.BoxGeometry(0.5, 3, 0.4), -0.75, 1.5, 0), '#8d8577'),
        painted(at(new THREE.BoxGeometry(0.5, 3, 0.4), 0.75, 1.5, 0), '#8d8577'),
        painted(at(new THREE.BoxGeometry(2, 0.6, 0.4), 0, 2.7, 0), '#8d8577'),
      ))],
      rubble: [P(merged(painted(at(new THREE.BoxGeometry(0.4, 0.22, 0.22), 0, 0.11, 0), '#8a8c8f')), lit, false)],
      fence: [P(merged(
        painted(at(new THREE.BoxGeometry(0.1, 0.8, 0.1), -0.95, 0.4, 0), '#6e4f35'),
        painted(at(new THREE.BoxGeometry(0.1, 0.8, 0.1), 0.95, 0.4, 0), '#6e4f35'),
        painted(at(new THREE.BoxGeometry(2, 0.08, 0.06), 0, 0.6, 0), '#6e4f35'),
      ), lit, false)],
      wagon: [P(merged(painted(at(new THREE.BoxGeometry(1.8, 0.8, 3), 0, 0.8, 0), '#6e4f35')))],
      crate: [P(merged(painted(at(new THREE.BoxGeometry(0.8, 0.8, 0.8), 0, 0.4, 0), '#6e4f35')))],
      lamp: [
        P(merged(painted(at(new THREE.CylinderGeometry(0.06, 0.09, 4.2, 5), 0, 2.1, 0), '#2c2f38'))),
        P(new THREE.SphereGeometry(0.22, 8, 6).translate(0, 4.3, 0), bulb, false),
      ],
    }
  }

  /** Swap the kit models in for their kinds (textured, one part per material). Ruin walls get
   * ivy hanging from their tops; pillars and arches wear the kit's stone. */
  useKit(kit: Kit): void {
    for (const [kind, name] of Object.entries(MODEL_FOR) as [PropKind, string][]) {
      if (!kit.has(name)) continue
      const small = kind === 'rubble' || kind === 'fence' || kind === 'crate'
      this.parts[kind] = kit.model(name).map((p) => ({ geometry: p.geometry, material: kit.materials[p.mat], shadow: !small }))
      if ((kind === 'ruinwall' || kind === 'ruinwindow') && kit.has('Prop_Vine1')) {
        for (const p of kit.model(kind === 'ruinwall' ? 'Prop_Vine1' : 'Prop_Vine4')) {
          const geometry = p.geometry.clone().translate(-0.2, 3.05, 0.12)
          this.disposables.push(geometry)
          this.parts[kind].push({ geometry, material: kit.materials[p.mat], shadow: false })
        }
      }
    }
    const stone = (g: THREE.BufferGeometry) => {
      const geometry = boxUV(g, 2.2)
      this.disposables.push(geometry)
      return { geometry, material: kit.materials.uneven, shadow: true }
    }
    this.parts.pillar = [stone(merged(
      new THREE.CylinderGeometry(0.42, 0.48, 4.2, 12).translate(0, 2.1, 0).toNonIndexed(),
      new THREE.BoxGeometry(1.2, 0.35, 1.2).translate(0, 4.3, 0).toNonIndexed(),
      new THREE.BoxGeometry(1.3, 0.4, 1.3).translate(0, 0.2, 0).toNonIndexed(),
    ))]
    this.parts.arch = [stone(merged(
      new THREE.BoxGeometry(0.9, 5.5, 0.9).translate(-2.6, 2.75, 0).toNonIndexed(),
      new THREE.BoxGeometry(0.9, 5.5, 0.9).translate(2.6, 2.75, 0).toNonIndexed(),
      new THREE.BoxGeometry(6.4, 0.8, 1.0).translate(0, 5.9, 0).toNonIndexed(),
      new THREE.ConeGeometry(0.5, 0.9, 4).translate(0, 6.75, 0).toNonIndexed(),
    ))]
  }

  /** How a placement's scale maps to the instance matrix scale for a kind. */
  static size(kind: PropKind, scale: number, tint: number): THREE.Vector3 {
    switch (kind) {
      case 'tower': return new THREE.Vector3(8 + tint * 10, 14 + Math.pow(tint, 2) * 60, 8 + scale * 6)
      case 'pillar': return new THREE.Vector3(scale, 0.35 + tint * 0.75, scale) // broken to whole
      case 'neon': return new THREE.Vector3(scale, scale, 1)
      // Kit pieces and man-made props have real-world sizes: only a little variation.
      case 'ruinwall':
      case 'ruinwindow':
      case 'ruindoor':
      case 'fence':
      case 'wagon':
      case 'crate':
      case 'barrel':
      case 'stall':
      case 'well':
      case 'haybale':
      case 'scarecrow': {
        const v = 0.92 + tint * 0.2
        return new THREE.Vector3(v, v, v)
      }
      case 'pine':
      case 'oak':
      case 'birch': {
        const v = 0.75 + scale * 0.55
        return new THREE.Vector3(v, v * (0.9 + tint * 0.3), v)
      }
      default: return new THREE.Vector3(scale, scale, scale)
    }
  }

  static color(kind: PropKind, tint: number): THREE.Color {
    if (kind === 'neon' || kind === 'strip') {
      return new THREE.Color().setHSL([0.83, 0.52, 0.12, 0.95, 0.75][Math.floor(tint * 5)], 1, 0.62)
    }
    if (kind === 'flower') return new THREE.Color().setHSL([0.0, 0.13, 0.75, 0.62, 0.92, 0.15][Math.floor(tint * 6)], 0.8, tint > 0.83 ? 0.92 : 0.62)
    const v = 0.85 + tint * 0.3 // gentle brightness variation
    return new THREE.Color(v, v, v)
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
  }
}
