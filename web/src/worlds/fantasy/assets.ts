/**
 * The building kit for the fantasy world: Quaternius "Medieval Village MegaKit" models and
 * textures (CC0, credits: docs/art/CREDITS.md) from public/worlds/fantasy (imported by
 * web/tools/import_quaternius.py), plus a few procedural pieces (foundations, battlements,
 * lanterns, the windmill) textured with the same hand-painted textures.
 *
 * Models are split per material into plain geometries (position, normal, uv). Buildings are
 * baked: all pieces of a chunk merged into one mesh per material, a handful of draw calls for a
 * whole street. Small scattered props (fences, crates...) are instanced like trees.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { PropKind } from './gen'

/** Which model backs which scattered prop kind. */
export const MODEL_FOR: Partial<Record<PropKind, string>> = {
  ruinwall: 'Wall_UnevenBrick_Straight',
  ruinwindow: 'Wall_UnevenBrick_Window_Wide_Round',
  ruindoor: 'Wall_UnevenBrick_Door_Round',
  fence: 'Prop_WoodenFence_Single',
  wagon: 'Prop_Wagon',
  crate: 'Prop_Crate',
  rubble: 'Prop_Brick2',
}

/** Every kit model the buildings use (see house(), tower(), castleOf() in gen.ts). */
export const BUILDING_MODELS = [
  'Wall_Plaster_Straight', 'Wall_Plaster_Window_Wide_Round', 'Wall_Plaster_Door_Round', 'Wall_Plaster_WoodGrid',
  'Wall_UnevenBrick_Straight', 'Wall_UnevenBrick_Window_Wide_Round', 'Wall_UnevenBrick_Door_Round',
  'Wall_UnevenBrick_Window_Thin_Round', 'Wall_BottomCover', 'Corner_Exterior_Wood',
  'Roof_RoundTiles_4x4', 'Roof_RoundTiles_4x6', 'Roof_RoundTiles_6x6', 'Roof_RoundTiles_6x8',
  'Roof_Front_Brick4', 'Roof_Front_Brick6', 'Roof_Tower_RoundTiles', 'Prop_Chimney', 'Prop_Chimney2',
  'Window_Wide_Round1', 'Window_Thin_Round1', 'WindowShutters_Wide_Round_Open', 'WindowShutters_Wide_Round_Closed',
  'Door_1_Round', 'Prop_Vine1', 'Prop_Vine4', 'Prop_WoodenFence_Single', 'Prop_WoodenFence_Extension1', 'Prop_Brick2',
]

export type MatKey =
  | 'plaster' | 'uneven' | 'tiles' | 'wood' | 'rock' | 'brick' | 'vine' | 'glass' | 'glassDark' | 'metal' | 'paint' | 'glow'

/** The kit's material names (glTF) to ours. */
const MATERIALS: [string, MatKey][] = [
  ['MI_UnevenBrick', 'uneven'],
  ['MI_Brick', 'brick'],
  ['MI_Plaster', 'plaster'],
  ['MI_WoodTrim', 'wood'],
  ['MI_RockTrim', 'rock'],
  ['MI_RoundTiles', 'tiles'],
  ['MI_Vine', 'vine'],
  ['MI_WindowGlass', 'glass'],
  ['MI_MetalOrnaments', 'metal'],
]

export function matKey(name: string | undefined): MatKey {
  return MATERIALS.find(([prefix]) => name?.startsWith(prefix))?.[1] ?? 'rock'
}

/** Hand-painted textures per material: base colour and normal map. */
export const TEXTURES: Partial<Record<MatKey, [string, string]>> = {
  plaster: ['T_Plaster_BaseColor.jpg', 'T_Plaster_Normal.jpg'],
  uneven: ['T_UnevenBrick_BaseColor.jpg', 'T_UnevenBrick_Normal.jpg'],
  tiles: ['T_RoundTiles_BaseColor.jpg', 'T_RoundTiles_Normal.jpg'],
  wood: ['T_WoodTrim_BaseColor.jpg', 'T_WoodTrim_Normal.jpg'],
  rock: ['T_RockTrim_BaseColor.jpg', 'T_RockTrim_Normal.jpg'],
  brick: ['T_Brick_BaseColor.jpg', 'T_Brick_Normal.jpg'],
}

export interface ModelPart {
  mat: MatKey
  /** Position, normal, uv (and color for 'paint'); indexed or not. */
  geometry: THREE.BufferGeometry
}

const BASE = `${import.meta.env.BASE_URL}worlds/fantasy/`

/** Planar UVs from the dominant axis of each triangle, `tile` metres per texture repeat. */
export function boxUV(geometry: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  const p = g.getAttribute('position')
  const uv = new Float32Array(p.count * 2)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i)
    b.fromBufferAttribute(p, i + 1)
    c.fromBufferAttribute(p, i + 2)
    const n = b.clone().sub(a).cross(c.clone().sub(a))
    const ax = Math.abs(n.x)
    const ay = Math.abs(n.y)
    const az = Math.abs(n.z)
    for (let k = 0; k < 3; k++) {
      const v = [a, b, c][k]
      const [u, w] = ay >= ax && ay >= az ? [v.x, v.z] : ax >= az ? [v.z, v.y] : [v.x, v.y]
      uv[(i + k) * 2] = u / tile
      uv[(i + k) * 2 + 1] = w / tile
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
}

/** Only the attributes we use; kit meshes stay indexed (shared vertices: a third of the work). */
function plain(geometry: THREE.BufferGeometry, keepIndex = false): THREE.BufferGeometry {
  const g = geometry.index && !keepIndex ? geometry.toNonIndexed() : geometry
  for (const key of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(key)) g.deleteAttribute(key)
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
  g.clearGroups()
  return g
}

function colored(geometry: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const g = plain(geometry)
  const c = new THREE.Color(color)
  const n = g.getAttribute('position').count
  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

function joined(...parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((g) => plain(g)))
  if (!g) throw new Error('could not merge kit geometry')
  return g
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) =>
  new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z)

/** Procedural pieces in the kit's style. */
function proceduralPieces(): Map<string, ModelPart[]> {
  const out = new Map<string, ModelPart[]>()
  const set = (name: string, ...parts: ModelPart[]) => out.set(name, parts)
  for (const [W, D] of [[4, 4], [4, 6], [6, 6], [6, 8]]) {
    set(`found_${W}x${D}`, { mat: 'uneven', geometry: boxUV(box(W + 0.3, 2.0, D + 0.3, 0, -1.8, -0.0), 2.4) })
  }
  set('found_wall', { mat: 'uneven', geometry: boxUV(box(2.02, 2.2, 0.62, 0, -2.1, -0.11), 2.4) })
  set('corner_stone', { mat: 'uneven', geometry: boxUV(box(0.42, 3.0, 0.42, 0, 0.06, 0), 2.4) })
  set('wallcap', { mat: 'uneven', geometry: boxUV(box(2.02, 0.22, 0.62, 0, 0.06, -0.11), 2.4) })
  set('merlon', { mat: 'uneven', geometry: boxUV(box(0.95, 0.85, 0.5, 0, 0.28, -0.04), 2.4) })
  set('gatebeam', { mat: 'uneven', geometry: boxUV(box(5.6, 0.6, 3.8, 0, 0, 0), 2.4) })
  set('gatebeam_small', { mat: 'uneven', geometry: boxUV(box(5.2, 0.6, 0.7, 0, 0, -0.11), 2.4) })
  set('stone_arch', { mat: 'uneven', geometry: boxUV(joined(
    box(1.0, 6.2, 1.0, -3.0, 0, 0), box(1.0, 6.2, 1.0, 3.0, 0, 0),
    box(1.3, 0.5, 1.3, -3.0, 0, 0), box(1.3, 0.5, 1.3, 3.0, 0, 0),
    box(7.4, 0.9, 1.15, 0, 6.2, 0), box(5.0, 0.5, 0.9, 0, 5.75, 0),
    new THREE.ConeGeometry(0.7, 1.4, 4).rotateY(Math.PI / 4).translate(0, 7.8, 0),
    new THREE.ConeGeometry(0.4, 0.9, 4).rotateY(Math.PI / 4).translate(-3.3, 7.55, 0),
    new THREE.ConeGeometry(0.4, 0.9, 4).rotateY(Math.PI / 4).translate(3.3, 7.55, 0),
  ), 2.2) })
  set('lantern',
    { mat: 'metal', geometry: joined(
      new THREE.CylinderGeometry(0.06, 0.09, 3.3, 6).translate(0, 1.65, 0),
      new THREE.CylinderGeometry(0.16, 0.2, 0.25, 6).translate(0, 0.12, 0),
      box(0.05, 0.05, 0.75, 0, 3.15, 0.35),
      new THREE.ConeGeometry(0.22, 0.22, 4).rotateY(Math.PI / 4).translate(0, 3.12, 0.7),
      box(0.3, 0.04, 0.3, 0, 2.62, 0.7),
    ) },
    { mat: 'glow', geometry: plain(box(0.2, 0.38, 0.2, 0, 2.64, 0.7)) },
  )
  set('mill',
    { mat: 'uneven', geometry: boxUV(new THREE.CylinderGeometry(3.3, 3.45, 2.2, 12).translate(0, 0.0, 0), 2.4) },
    { mat: 'plaster', geometry: boxUV(new THREE.CylinderGeometry(2.3, 3.1, 8.2, 12).translate(0, 5.1, 0), 3) },
    { mat: 'tiles', geometry: boxUV(new THREE.ConeGeometry(3.0, 3.4, 12).translate(0, 10.9, 0), 2) },
    { mat: 'wood', geometry: boxUV(joined(box(1.3, 2.2, 0.3, 0, 1.0, 3.05), box(0.25, 0.6, 1.2, 0, 8.3, 2.55)), 1.5) },
    { mat: 'glass', geometry: plain(box(0.9, 1.1, 0.12, 0, 5.4, 2.62)) },
  )
  return out
}

/** Windmill sails, turning about +z at their origin (the world spins them). */
export function millBlades(): ModelPart[] {
  const wood: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.35, 0.35, 0.5, 8).rotateX(Math.PI / 2)]
  const sail: THREE.BufferGeometry[] = []
  for (let k = 0; k < 4; k++) {
    const turn = (k * Math.PI) / 2
    wood.push(box(0.16, 6.2, 0.12, 0, 0.2, 0.1).rotateZ(turn))
    sail.push(box(1.25, 4.8, 0.04, 0.75, 1.4, 0.14).rotateZ(turn))
    for (let j = 0; j < 5; j++) wood.push(box(1.45, 0.06, 0.06, 0.75, 1.5 + j * 1.15, 0.16).rotateZ(turn))
  }
  return [
    { mat: 'paint', geometry: joined(...wood.map((g) => colored(g, '#5a4030'))) },
    { mat: 'paint', geometry: joined(...sail.map((g) => colored(g, '#e8dcc0'))) },
  ]
}

/** A model's meshes, split and merged per material, in model space. */
function partsOf(root: THREE.Object3D): ModelPart[] {
  const byMat = new Map<MatKey, THREE.BufferGeometry[]>()
  root.updateMatrixWorld(true)
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const g = plain(mesh.geometry.clone(), true).applyMatrix4(mesh.matrixWorld)
    const mat = matKey((mesh.material as THREE.Material).name)
    byMat.set(mat, [...(byMat.get(mat) ?? []), g])
  })
  return [...byMat].map(([mat, geometries]) => ({ mat, geometry: mergeGeometries(geometries)! }))
}

export class Kit {
  readonly materials: Record<MatKey, THREE.MeshStandardMaterial>
  private readonly models = new Map<string, ModelPart[]>()
  private readonly textures: THREE.Texture[] = []

  constructor(maxAnisotropy = 8) {
    const loader = new THREE.TextureLoader()
    const tex = (file: string, srgb: boolean) => {
      const t = loader.load(`${BASE}textures/${file}`)
      t.flipY = false // glTF UV convention
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.anisotropy = maxAnisotropy
      if (srgb) t.colorSpace = THREE.SRGBColorSpace
      this.textures.push(t)
      return t
    }
    const textured = (key: MatKey) => {
      const [base, normal] = TEXTURES[key]!
      return new THREE.MeshStandardMaterial({
        map: tex(base, true), normalMap: tex(normal, false), roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
      })
    }
    const vineMask = tex('T_VineLeaf.png', false)
    this.materials = {
      plaster: textured('plaster'),
      uneven: textured('uneven'),
      tiles: textured('tiles'),
      wood: textured('wood'),
      rock: textured('rock'),
      brick: textured('brick'),
      vine: new THREE.MeshStandardMaterial({ color: '#4f8a24', alphaMap: vineMask, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 }),
      glass: new THREE.MeshStandardMaterial({ color: '#27313b', roughness: 0.15, metalness: 0.4, emissive: '#ffb35c', emissiveIntensity: 0 }),
      glassDark: new THREE.MeshStandardMaterial({ color: '#27313b', roughness: 0.15, metalness: 0.4 }),
      metal: new THREE.MeshStandardMaterial({ color: '#2d2c30', roughness: 0.55, metalness: 0.6 }),
      paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
      glow: new THREE.MeshStandardMaterial({ color: '#ffd7a0', emissive: '#ffb04a', emissiveIntensity: 0.4 }),
    }
    for (const [name, parts] of proceduralPieces()) this.models.set(name, parts)
  }

  /** Load the kit models; ones that fail are left out (buildings then miss that piece). */
  async load(names: string[]): Promise<void> {
    const loader = new GLTFLoader()
    await Promise.all(names.map(async (name) => {
      try {
        const gltf = await loader.loadAsync(`${BASE}models/${name}.gltf`)
        this.models.set(name, partsOf(gltf.scene))
      } catch (err) {
        console.warn(`fantasy world: model ${name} not loaded`, err)
      }
    }))
  }

  has(name: string): boolean {
    return this.models.has(name.split('#')[0])
  }

  /** A model's parts; "name#dark" is the same model with unlit windows. */
  model(name: string): ModelPart[] {
    const [base, variant] = name.split('#')
    const parts = this.models.get(base) ?? []
    return variant === 'dark' ? parts.map((p) => (p.mat === 'glass' ? { ...p, mat: 'glassDark' as MatKey } : p)) : parts
  }

  /** Lit windows and lanterns: off by day, glowing at night. */
  setNight(night: number): void {
    this.materials.glass.emissiveIntensity = night * 1.5
    this.materials.glow.emissiveIntensity = 0.4 + night * 5
  }

  dispose(): void {
    for (const m of Object.values(this.materials)) m.dispose()
    for (const t of this.textures) t.dispose()
    for (const parts of this.models.values()) for (const p of parts) p.geometry.dispose()
  }
}

/**
 * Merge many placed pieces into one geometry per material (positions and normals transformed
 * here, once): a chunk's buildings become a few static meshes.
 */
export function bake(kit: Kit, items: { model: string; matrix: THREE.Matrix4 }[]): Map<MatKey, THREE.BufferGeometry> {
  const lists = new Map<MatKey, { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[]>()
  for (const item of items) {
    for (const part of kit.model(item.model)) {
      const list = lists.get(part.mat)
      if (list) list.push({ geometry: part.geometry, matrix: item.matrix })
      else lists.set(part.mat, [{ geometry: part.geometry, matrix: item.matrix }])
    }
  }
  const out = new Map<MatKey, THREE.BufferGeometry>()
  const normalMatrix = new THREE.Matrix3()
  const v = new THREE.Vector3()
  for (const [mat, list] of lists) {
    const count = list.reduce((n, l) => n + l.geometry.getAttribute('position').count, 0)
    const indexCount = list.reduce((n, l) => n + (l.geometry.index?.count ?? l.geometry.getAttribute('position').count), 0)
    const indices = count > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
    let k = 0
    const pos = new Float32Array(count * 3)
    const nor = new Float32Array(count * 3)
    const uv = new Float32Array(count * 2)
    const withColor = mat === 'paint'
    const col = withColor ? new Float32Array(count * 3) : null
    let o = 0
    for (const { geometry, matrix } of list) {
      const p = geometry.getAttribute('position')
      const n = geometry.getAttribute('normal')
      const t = geometry.getAttribute('uv')
      const c = geometry.getAttribute('color')
      normalMatrix.getNormalMatrix(matrix)
      const index = geometry.index
      if (index) for (let i = 0; i < index.count; i++) indices[k++] = o + index.getX(i)
      else for (let i = 0; i < p.count; i++) indices[k++] = o + i
      for (let i = 0; i < p.count; i++, o++) {
        v.fromBufferAttribute(p, i).applyMatrix4(matrix)
        pos[o * 3] = v.x
        pos[o * 3 + 1] = v.y
        pos[o * 3 + 2] = v.z
        v.fromBufferAttribute(n, i).applyMatrix3(normalMatrix).normalize()
        nor[o * 3] = v.x
        nor[o * 3 + 1] = v.y
        nor[o * 3 + 2] = v.z
        uv[o * 2] = t.getX(i)
        uv[o * 2 + 1] = t.getY(i)
        if (col && c) {
          col[o * 3] = c.getX(i)
          col[o * 3 + 1] = c.getY(i)
          col[o * 3 + 2] = c.getZ(i)
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.setIndex(new THREE.BufferAttribute(indices, 1))
    g.computeBoundingSphere()
    out.set(mat, g)
  }
  return out
}
