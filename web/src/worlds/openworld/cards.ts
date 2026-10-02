/**
 * Small plants as crossed cards: three painted quads crossing at 60 degrees, so they look full
 * from every side and never turn (no swimming). Textures are painted in code (no downloads),
 * each card is 6 triangles instead of the ~30-40 of a clump of 3D blades, so grass and crops
 * can be much denser for the same cost. They sway in the wind like the 3D plants.
 */

import * as THREE from 'three'
import type { PropKind } from '../fantasy/gen'
import type { Part } from '../fantasy/props'
import { addWind } from '../fantasy/shaders'

const CELL = 256
const KINDS = ['grass', 'wheat', 'lavender', 'fern'] as const
type CardKind = (typeof KINDS)[number]

/** Width and height of each card, metres. */
const SIZE: Record<CardKind, [number, number]> = {
  grass: [1.1, 0.75], wheat: [1.2, 1.25], lavender: [1.0, 0.85], fern: [1.4, 0.8],
}

function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A tapered blade from (x, bottom) curving to its tip. */
function blade(ctx: CanvasRenderingContext2D, x: number, h: number, bend: number, w: number, base: string, tip: string): void {
  const y0 = CELL
  const tx = x + bend
  const ty = y0 - h
  const g = ctx.createLinearGradient(0, y0, 0, ty)
  g.addColorStop(0, base)
  g.addColorStop(1, tip)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(x - w, y0)
  ctx.quadraticCurveTo(x - w * 0.4 + bend * 0.3, y0 - h * 0.55, tx, ty)
  ctx.quadraticCurveTo(x + w * 0.4 + bend * 0.3, y0 - h * 0.55, x + w, y0)
  ctx.closePath()
  ctx.fill()
}

function paint(ctx: CanvasRenderingContext2D, kind: CardKind): void {
  const r = seeded(KINDS.indexOf(kind) * 977 + 13)
  if (kind === 'grass') {
    for (let i = 0; i < 54; i++) {
      const x = 14 + Math.pow(r(), 1) * (CELL - 28)
      const shade = 0.75 + r() * 0.5
      // Mostly short blades, a few tall ones: a ragged outline, not a box.
      blade(ctx, x, CELL * (0.22 + Math.pow(r(), 1.8) * 0.75), (r() - 0.5) * 70, 3 + r() * 3,
        `rgb(${30 * shade},${66 * shade},${26 * shade})`, `rgb(${130 * shade},${185 * shade},${80 * shade})`)
    }
  } else if (kind === 'wheat') {
    for (let i = 0; i < 26; i++) {
      const x = 22 + r() * (CELL - 44)
      const h = CELL * (0.5 + r() * 0.3) // ears (about 45 px) stay inside the card
      const bend = (r() - 0.5) * 30
      blade(ctx, x, h, bend, 2.2, '#7a6a2c', '#cfb35c')
      // The ear: a column of little grains near the top.
      for (let k = 0; k < 7; k++) {
        const t = k / 7
        ctx.fillStyle = k % 2 ? '#e2c46c' : '#c9a548'
        ctx.beginPath()
        ctx.ellipse(x + bend * (0.85 + t * 0.15) + (k % 2 ? 3 : -3), CELL - h + 6 + t * 34, 4, 7, 0.3 * (k % 2 ? 1 : -1), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    for (let i = 0; i < 14; i++) blade(ctx, 20 + r() * (CELL - 40), CELL * (0.3 + r() * 0.25), (r() - 0.5) * 50, 3, '#5d6a2c', '#9aa255')
  } else if (kind === 'lavender') {
    for (let i = 0; i < 20; i++) blade(ctx, 30 + r() * (CELL - 60), CELL * (0.35 + r() * 0.3), (r() - 0.5) * 40, 2.5, '#3f6a3a', '#7f9f6a')
    for (let i = 0; i < 18; i++) {
      const x = 30 + r() * (CELL - 60)
      const h = CELL * (0.55 + r() * 0.3)
      const bend = (r() - 0.5) * 24
      blade(ctx, x, h, bend, 1.6, '#4c6f43', '#6a8a55')
      for (let k = 0; k < 9; k++) {
        ctx.fillStyle = ['#8a6ad0', '#7656c0', '#a487e2'][k % 3]
        ctx.beginPath()
        ctx.arc(x + bend + (k % 2 ? 2.5 : -2.5), CELL - h + 4 + k * 5.5, 4 - k * 0.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else {
    // A fern: arching fronds with leaflets.
    for (let f = 0; f < 7; f++) {
      const dir = (f / 6 - 0.5) * 2
      const len = CELL * (0.55 + r() * 0.25)
      ctx.strokeStyle = '#2e5a28'
      ctx.lineWidth = 3
      const pts: [number, number][] = []
      for (let t = 0; t <= 1.0001; t += 0.1) pts.push([CELL / 2 + dir * len * 0.55 * t, CELL - len * Math.sin(t * 2.2) * 0.85])
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.stroke()
      pts.slice(1, -1).forEach(([x, y], i) => {
        const s = 16 * (1 - i / pts.length)
        ctx.fillStyle = i % 2 ? '#3f7a34' : '#4f8f3a'
        for (const side of [-1, 1]) {
          ctx.beginPath()
          ctx.ellipse(x + side * s * 0.4, y - s * 0.3, s * 0.55, s * 0.22, side * 0.9, 0, Math.PI * 2)
          ctx.fill()
        }
      })
    }
  }
}

/** Card parts that replace the 3D blade plants of these kinds (open world only). */
export function cardParts(): { parts: Partial<Record<PropKind, Part[]>>; dispose(): void } {
  const canvas = document.createElement('canvas')
  canvas.width = CELL * KINDS.length
  canvas.height = CELL
  const ctx = canvas.getContext('2d')!
  KINDS.forEach((kind, i) => {
    ctx.save()
    ctx.translate(i * CELL, 0)
    ctx.beginPath()
    ctx.rect(0, 0, CELL, CELL)
    ctx.clip()
    paint(ctx, kind)
    ctx.restore()
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const material = addWind(new THREE.MeshStandardMaterial({
    map: texture, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1,
  }), 0.14, 1)
  const geometries: THREE.BufferGeometry[] = []
  const parts: Partial<Record<PropKind, Part[]>> = {}
  KINDS.forEach((kind, i) => {
    const [w, h] = SIZE[kind]
    const quads: THREE.BufferGeometry[] = []
    for (let k = 0; k < 3; k++) {
      const q = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0).rotateY((k * Math.PI) / 3)
      const uv = q.getAttribute('uv')
      for (let v = 0; v < uv.count; v++) uv.setX(v, (i + uv.getX(v)) / KINDS.length)
      // Normals straight up: cards light like the ground they grow from.
      const n = q.getAttribute('normal')
      for (let v = 0; v < n.count; v++) n.setXYZ(v, 0, 1, 0)
      quads.push(q)
    }
    const g = mergeQuads(quads)
    geometries.push(g)
    parts[kind] = [{ geometry: g, material, shadow: false }]
  })
  return {
    parts,
    dispose() {
      texture.dispose()
      material.dispose()
      for (const g of geometries) g.dispose()
    },
  }
}

function mergeQuads(quads: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (const q of quads) {
    const base = pos.length / 3
    pos.push(...(q.getAttribute('position').array as Float32Array))
    nor.push(...(q.getAttribute('normal').array as Float32Array))
    uv.push(...(q.getAttribute('uv').array as Float32Array))
    for (const i of q.index!.array as Uint16Array) index.push(base + i)
    q.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(index)
  return g
}
