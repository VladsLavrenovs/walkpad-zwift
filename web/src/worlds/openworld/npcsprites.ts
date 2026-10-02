/**
 * NPC sprites: one sheet per look, 8 rows x 5 columns, drawn as cards that turn to face the camera
 * (around the vertical) and pick the row for the direction you see them from.
 *
 * Sheet format (for real art later: put `look-<n>.png` in public/worlds/openworld/npc/):
 * - 5 columns: 0 standing, 1-4 the walk cycle (one stride: left foot forward, passing, right
 *   foot forward, passing);
 * - 8 rows, the character seen from 8 directions: row 0 from the front (facing you), then turning
 *   45 degrees at a time so that row 2 shows its right side (it faces the left of the picture),
 *   row 4 its back, row 6 its left side (it faces the right of the picture);
 * - any cell size with a 1:2 width:height ratio, feet at the bottom middle, transparent background.
 * Without a PNG, a simple placeholder figure is painted in code.
 */

import * as THREE from 'three'
import { NPC_HEIGHT_M, NPC_LOOKS } from './npcs'

export const COLS = 5
export const ROWS = 8
const W = 64
const H = 128

interface Look {
  skin: string
  hair: string
  tunic: string
  legs: string
  hat: string | null
}

const LOOKS: Look[] = [
  { skin: '#f1c9a5', hair: '#5a3a22', tunic: '#7b2f2f', legs: '#3d3426', hat: null },
  { skin: '#e8b98f', hair: '#c9a24a', tunic: '#2f5f7b', legs: '#4a3a2a', hat: null },
  { skin: '#c68b5f', hair: '#1f1a17', tunic: '#5f7b2f', legs: '#2e2a26', hat: '#6b4a2a' },
  { skin: '#f4d2b0', hair: '#9b4a26', tunic: '#8a6a3a', legs: '#3a3a44', hat: null },
  { skin: '#8d5b3c', hair: '#2a2420', tunic: '#5a3a6b', legs: '#2f2a24', hat: null },
  { skin: '#efc39c', hair: '#d8d0c0', tunic: '#4a4a52', legs: '#2a2a2e', hat: '#8a8a92' },
  { skin: '#e2ae86', hair: '#3a2a1c', tunic: '#b08a3a', legs: '#5a4630', hat: null },
  { skin: '#f0cba9', hair: '#6b2a1a', tunic: '#2f6b5a', legs: '#3a3020', hat: '#3f5a2a' },
]

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k))
  const b = Math.min(255, Math.round((n & 255) * k))
  return `rgb(${r},${g},${b})`
}

/** A placeholder figure in one cell (origin: top left of the cell). */
function paintCell(ctx: CanvasRenderingContext2D, look: Look, row: number, col: number): void {
  const phi = (row * Math.PI) / 4
  const front = Math.cos(phi) // 1 facing you, -1 back
  const side = Math.sin(phi) // +1: you see its right side
  const fx = -side // which way it faces on the picture
  const phase = col === 0 ? null : ((col - 1) / 4) * Math.PI * 2
  const swing = phase === null ? 0 : Math.sin(phase)
  const cx = W / 2
  const ground = H - 4
  // Shadow at the feet.
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.beginPath()
  ctx.ellipse(cx, ground, 13, 4, 0, 0, Math.PI * 2)
  ctx.fill()
  // Legs: apart seen from the front, swinging seen from the side.
  const sep = 3 + 4 * Math.abs(front)
  const stride = swing * 8 * Math.abs(side)
  const lift = phase === null ? 0 : Math.max(0, Math.cos(phase)) * 3 * Math.abs(front)
  const leg = (dx: number, dy: number, dark: number) => {
    ctx.fillStyle = shade(look.legs, dark)
    ctx.fillRect(cx + dx - 3.5, 92 - dy, 7, ground - 92 - 2)
    ctx.fillStyle = shade('#3a2a1c', dark)
    ctx.fillRect(cx + dx - 4 + fx * 1.5, ground - 5 - dy, 9, 5)
  }
  leg(-sep - stride * 0.5, lift, 0.8)
  leg(sep + stride * 0.5, 0, 1)
  // Body.
  const bw = 16 + 9 * Math.abs(front)
  ctx.fillStyle = look.tunic
  ctx.beginPath()
  ctx.roundRect(cx - bw / 2, 58, bw, 40, 6)
  ctx.fill()
  ctx.fillStyle = shade(look.tunic, 0.6)
  ctx.fillRect(cx - bw / 2, 84, bw, 4) // belt
  // Arms: at the sides from the front, swinging from the side.
  const arm = (dx: number, sw: number, dark: number) => {
    ctx.fillStyle = shade(look.tunic, dark)
    ctx.save()
    ctx.translate(cx + dx, 62)
    ctx.rotate(sw * 0.45 * Math.abs(side))
    ctx.beginPath()
    ctx.roundRect(-3, 0, 6, 28, 3)
    ctx.fill()
    ctx.fillStyle = shade(look.skin, dark)
    ctx.fillRect(-3, 26, 6, 5)
    ctx.restore()
  }
  if (Math.abs(front) > 0.3) {
    arm(-bw / 2 - 2, swing, 0.85)
    arm(bw / 2 + 2, -swing, 0.85)
  } else {
    arm(-fx * 2, -swing, 1)
  }
  // Head and hair.
  const hx = cx + fx * 2
  const hy = 46
  ctx.fillStyle = look.skin
  ctx.beginPath()
  ctx.arc(hx, hy, 11, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = look.hair
  if (front < -0.3) {
    ctx.beginPath()
    ctx.arc(hx, hy, 11.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(hx - 10, hy, 20, 10) // hair down the back
  } else {
    ctx.beginPath()
    ctx.arc(hx, hy - 2, 11.5, Math.PI, Math.PI * 2)
    ctx.fill()
    if (Math.abs(side) > 0.3) {
      ctx.beginPath()
      ctx.arc(hx - fx * 4, hy, 9, 0, Math.PI * 2)
      ctx.fill()
    }
    // Eyes.
    ctx.fillStyle = '#2a1e18'
    if (Math.abs(side) < 0.4) {
      ctx.fillRect(hx - 5, hy + 1, 2.5, 3)
      ctx.fillRect(hx + 2.5, hy + 1, 2.5, 3)
    } else {
      ctx.fillRect(hx + fx * 5 - 1, hy + 1, 2.5, 3)
    }
  }
  if (look.hat) {
    ctx.fillStyle = look.hat
    ctx.beginPath()
    ctx.ellipse(hx, hy - 9, 15, 4, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(hx - 9, hy - 22, 18, 14, 4)
    ctx.fill()
  }
}

export function placeholderSheet(look: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = W * COLS
  canvas.height = H * ROWS
  const ctx = canvas.getContext('2d')!
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      ctx.save()
      ctx.translate(col * W, row * H)
      paintCell(ctx, LOOKS[look % LOOKS.length], row, col)
      ctx.restore()
    }
  }
  return canvas
}

/** One NPC to draw this frame. */
export interface NpcDraw {
  look: number
  x: number
  y: number
  z: number
  heading: number
  /** Column: 0 standing, 1-4 walking. */
  frame: number
}

const MAX_PER_LOOK = 64

export class NpcSprites {
  readonly group = new THREE.Group()
  private readonly material: THREE.ShaderMaterial
  private readonly textures: THREE.Texture[] = []
  private readonly batches: { geometry: THREE.InstancedBufferGeometry; base: Float32Array; info: Float32Array; mesh: THREE.Mesh }[] = []

  constructor(base = `${import.meta.env.BASE_URL}worlds/openworld/npc/`) {
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uSheet: { value: null },
        uLight: { value: new THREE.Color(1, 1, 1) },
      }]) as Record<string, THREE.IUniform>,
      fog: true,
      vertexShader: /* glsl */ `
        attribute vec3 iBase;
        attribute vec2 iInfo; // heading, frame column
        varying vec2 vUv;
        #include <fog_pars_vertex>
        void main() {
          vec2 toCam = normalize(cameraPosition.xz - iBase.xz + vec2(1e-4, 0.0));
          vec3 right = vec3(toCam.y, 0.0, -toCam.x);
          vec3 p = iBase + right * position.x * ${(NPC_HEIGHT_M / 2).toFixed(3)} + vec3(0.0, position.y * ${NPC_HEIGHT_M.toFixed(3)}, 0.0);
          float a = atan(toCam.x, toCam.y) - iInfo.x;
          float row = mod(floor(a / 6.2831853 * ${ROWS}.0 + 0.5), ${ROWS}.0);
          vUv = vec2((iInfo.y + uv.x) / ${COLS}.0, (${ROWS}.0 - 1.0 - row + uv.y) / ${ROWS}.0);
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSheet;
        uniform vec3 uLight;
        varying vec2 vUv;
        #include <fog_pars_fragment>
        void main() {
          vec4 c = texture2D(uSheet, vUv);
          if (c.a < 0.5) discard;
          gl_FragColor = vec4(c.rgb * uLight, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    })
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
    const loader = new THREE.TextureLoader()
    for (let look = 0; look < NPC_LOOKS; look++) {
      const texture = new THREE.CanvasTexture(placeholderSheet(look))
      texture.colorSpace = THREE.SRGBColorSpace
      texture.magFilter = THREE.LinearFilter
      this.textures.push(texture)
      const material = this.material.clone()
      material.uniforms.uSheet.value = texture
      // Real art, if there is any, replaces the placeholder.
      loader.load(`${base}look-${look}.png`, (png) => {
        png.colorSpace = THREE.SRGBColorSpace
        this.textures.push(png)
        material.uniforms.uSheet.value = png
      }, undefined, () => { /* no PNG: keep the placeholder */ })
      const geometry = new THREE.InstancedBufferGeometry()
      geometry.index = quad.index!.clone()
      geometry.setAttribute('position', quad.getAttribute('position').clone())
      geometry.setAttribute('uv', quad.getAttribute('uv').clone())
      const baseArr = new Float32Array(MAX_PER_LOOK * 3)
      const info = new Float32Array(MAX_PER_LOOK * 2)
      geometry.setAttribute('iBase', new THREE.InstancedBufferAttribute(baseArr, 3).setUsage(THREE.DynamicDrawUsage))
      geometry.setAttribute('iInfo', new THREE.InstancedBufferAttribute(info, 2).setUsage(THREE.DynamicDrawUsage))
      geometry.instanceCount = 0
      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.batches.push({ geometry, base: baseArr, info, mesh })
    }
    quad.dispose()
  }

  /** Draw these NPCs this frame. */
  set(list: NpcDraw[]): void {
    for (const b of this.batches) b.geometry.instanceCount = 0
    for (const n of list) {
      const b = this.batches[n.look % this.batches.length]
      const i = b.geometry.instanceCount
      if (i >= MAX_PER_LOOK) continue
      b.base.set([n.x, n.y, n.z], i * 3)
      b.info.set([n.heading, n.frame], i * 2)
      b.geometry.instanceCount = i + 1
    }
    for (const b of this.batches) {
      b.geometry.getAttribute('iBase').needsUpdate = true
      b.geometry.getAttribute('iInfo').needsUpdate = true
    }
  }

  setLight(c: THREE.Color): void {
    for (const b of this.batches) (b.mesh.material as THREE.ShaderMaterial).uniforms.uLight.value.copy(c)
  }

  dispose(): void {
    for (const b of this.batches) {
      b.geometry.dispose()
      ;(b.mesh.material as THREE.Material).dispose()
    }
    for (const t of this.textures) t.dispose()
    this.material.dispose()
  }
}
