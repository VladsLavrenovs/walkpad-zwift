/**
 * Far trees as sprites ("impostors"): each tree kind is photographed from 8 directions into one
 * texture when the world loads, from the very 3D trees used up close, so near and far match. Far
 * away a tree is a single card that turns to face the camera (around the vertical only, so it
 * never tips over) and shows the photo taken from the direction you look at it from.
 *
 * - `TreeImpostors.mesh()`: a batch of cards (one draw call) for a list of trees.
 * - `FarForest`: sparse cards from the edge of the terrain tiles out to the horizon, in big
 *   blocks, generated cheaply from the continent's grid.
 */

import * as THREE from 'three'
import { type PropKind, hashInts, rng } from '../fantasy/gen'
import { PropLibrary } from '../fantasy/props'
import { type Continent, OW_BIOMES, Water, WORLD_M } from './continent'
import type { Ground } from './ground'

export const SPRITE_TREES: PropKind[] = ['pine', 'oak', 'birch', 'deadtree']
const VIEWS = 8
const CELL_W = 128
const CELL_H = 256

interface KindBox {
  /** Width and height of the photo frame (metres, unscaled tree) and where its base sits. */
  w: number
  h: number
  y0: number
}

export interface TreeCard {
  kind: PropKind
  x: number
  y: number
  z: number
  rotation: number
  scale: number
  tint: number
}

export class TreeImpostors {
  readonly material: THREE.ShaderMaterial
  private readonly target: THREE.WebGLRenderTarget
  private readonly boxes = new Map<PropKind, KindBox>()
  private readonly quad: THREE.PlaneGeometry

  constructor(renderer: THREE.WebGLRenderer, props: PropLibrary) {
    this.target = new THREE.WebGLRenderTarget(CELL_W * VIEWS, CELL_H * SPRITE_TREES.length, {
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    })
    this.bake(renderer, props)
    this.quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uAtlas: { value: null }, // set below: merge() cannot copy a render target's texture
        uLight: { value: new THREE.Color(1, 1, 1) },
        uHole: { value: new THREE.Vector3(0, 0, -1) },
      }]) as Record<string, THREE.IUniform>,
      fog: true,
      vertexShader: /* glsl */ `
        attribute vec3 iBase;
        attribute vec2 iSize;
        attribute vec3 iInfo; // rotation, kind row, brightness
        uniform vec3 uHole;   // x, z, radius: cards inside are not drawn (3D trees are there)
        varying vec2 vUv;
        varying float vBright;
        #include <fog_pars_vertex>
        void main() {
          vec3 toCam = cameraPosition - iBase;
          vec2 flat2 = normalize(toCam.xz + vec2(1e-4, 0.0));
          if (uHole.z > 0.0 && distance(iBase.xz, uHole.xy) < uHole.z) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec3 right = vec3(flat2.y, 0.0, -flat2.x);
          vec3 p = iBase + right * position.x * iSize.x + vec3(0.0, position.y * iSize.y, 0.0);
          float a = atan(flat2.x, flat2.y) - iInfo.x;
          float view = mod(floor(a / 6.2831853 * ${VIEWS}.0 + 0.5), ${VIEWS}.0);
          vUv = vec2((view + uv.x) / ${VIEWS}.0, (iInfo.y + uv.y) / ${SPRITE_TREES.length}.0);
          vBright = iInfo.z;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        uniform vec3 uLight;
        varying vec2 vUv;
        varying float vBright;
        #include <fog_pars_fragment>
        void main() {
          vec4 c = texture2D(uAtlas, vUv);
          if (c.a < 0.4) discard;
          gl_FragColor = vec4(c.rgb / max(c.a, 0.001) * uLight * vBright, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    })
    this.material.uniforms.uAtlas.value = this.target.texture
  }

  /** Photograph every kind from VIEWS directions into the atlas (once, at load). */
  private bake(renderer: THREE.WebGLRenderer, props: PropLibrary): void {
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight('#ffffff', '#5a5040', 1.5))
    const sun = new THREE.DirectionalLight('#ffffff', 1.6)
    sun.position.set(0.4, 1, 0.8)
    scene.add(sun)
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    const prevTarget = renderer.getRenderTarget()
    const prevClear = renderer.getClearColor(new THREE.Color())
    const prevAlpha = renderer.getClearAlpha()
    const prevShadows = renderer.shadowMap.enabled
    renderer.shadowMap.enabled = false
    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    SPRITE_TREES.forEach((kind, row) => {
      const tree = new THREE.Group()
      for (const part of props.parts[kind]) tree.add(new THREE.Mesh(part.geometry, part.material))
      const box = new THREE.Box3().setFromObject(tree)
      const reach = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) * 1.05
      const kb = { w: reach * 2, h: (box.max.y - box.min.y) * 1.03, y0: box.min.y }
      this.boxes.set(kind, kb)
      scene.add(tree)
      camera.left = -kb.w / 2
      camera.right = kb.w / 2
      camera.bottom = kb.y0
      camera.top = kb.y0 + kb.h
      camera.position.set(0, 0, 50)
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
      for (let v = 0; v < VIEWS; v++) {
        tree.rotation.y = -(v / VIEWS) * Math.PI * 2
        // Row `row` of the atlas (render targets start at the bottom, like texture v = 0).
        this.target.viewport.set(v * CELL_W, row * CELL_H, CELL_W, CELL_H)
        this.target.scissor.set(v * CELL_W, row * CELL_H, CELL_W, CELL_H)
        this.target.scissorTest = true
        renderer.setRenderTarget(this.target)
        renderer.render(scene, camera)
      }
      scene.remove(tree)
    })
    this.target.scissorTest = false
    this.target.viewport.set(0, 0, this.target.width, this.target.height)
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(prevClear, prevAlpha)
    renderer.shadowMap.enabled = prevShadows
  }

  /** One batch of cards for these trees (one draw call). */
  mesh(cards: TreeCard[]): THREE.Mesh | null {
    const list = cards.filter((c) => this.boxes.has(c.kind))
    if (!list.length) return null
    const g = new THREE.InstancedBufferGeometry()
    // Own copies of the 4-vertex quad: disposing one batch must not free another's buffers.
    g.index = this.quad.index!.clone()
    g.setAttribute('position', this.quad.getAttribute('position').clone())
    g.setAttribute('uv', this.quad.getAttribute('uv').clone())
    const base = new Float32Array(list.length * 3)
    const size = new Float32Array(list.length * 2)
    const info = new Float32Array(list.length * 3)
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    let maxY = -Infinity
    list.forEach((c, i) => {
      const kb = this.boxes.get(c.kind)!
      const s = PropLibrary.size(c.kind, c.scale, c.tint)
      base.set([c.x, c.y + kb.y0 * s.y, c.z], i * 3)
      size.set([kb.w * s.x, kb.h * s.y], i * 2)
      info.set([c.rotation, SPRITE_TREES.indexOf(c.kind), PropLibrary.color(c.kind, c.tint).r], i * 3)
      minX = Math.min(minX, c.x)
      maxX = Math.max(maxX, c.x)
      minZ = Math.min(minZ, c.z)
      maxZ = Math.max(maxZ, c.z)
      maxY = Math.max(maxY, c.y + kb.h * s.y)
    })
    g.setAttribute('iBase', new THREE.InstancedBufferAttribute(base, 3))
    g.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 2))
    g.setAttribute('iInfo', new THREE.InstancedBufferAttribute(info, 3))
    g.instanceCount = list.length
    const centre = new THREE.Vector3((minX + maxX) / 2, maxY / 2, (minZ + maxZ) / 2)
    g.boundingSphere = new THREE.Sphere(centre, Math.hypot(maxX - minX, maxZ - minZ, maxY) / 2 + 20)
    return new THREE.Mesh(g, this.material)
  }

  /** How lit the cards are (they carry baked daylight): 1 by day, darker at dusk and night. */
  setLight(color: THREE.Color): void {
    this.material.uniforms.uLight.value.copy(color)
  }

  dispose(): void {
    this.target.dispose()
    this.quad.dispose()
    this.material.dispose()
  }
}

/** Tree cards per square metre and which kinds, by biome (cheap, from the grid). */
const FAR_DENSITY: Record<string, { per: number; kinds: [PropKind, number][] }> = {
  forest: { per: 1 / 55, kinds: [['pine', 0.7], ['oak', 0.2], ['birch', 0.1]] },
  ruins: { per: 1 / 110, kinds: [['oak', 0.5], ['birch', 0.3], ['pine', 0.2]] },
  falls: { per: 1 / 140, kinds: [['pine', 0.9], ['birch', 0.1]] },
  meadow: { per: 1 / 900, kinds: [['oak', 0.6], ['birch', 0.4]] },
  fields: { per: 1 / 1600, kinds: [['oak', 1]] },
}
export const FAR_BLOCK = 512

/** Tree cards of one far block (deterministic). */
export function farBlockTrees(c: Continent, ground: Ground, bx: number, bz: number): TreeCard[] {
  const r = rng(hashInts(c.seed, 911, bx, bz))
  const out: TreeCard[] = []
  const step = 9
  for (let z = bz * FAR_BLOCK; z < (bz + 1) * FAR_BLOCK; z += step) {
    for (let x = bx * FAR_BLOCK; x < (bx + 1) * FAR_BLOCK; x += step) {
      const px = x + r() * step
      const pz = z + r() * step
      const pick = r()
      const kindPick = r()
      const scale = 0.7 + r() * 0.7
      const rotation = r() * Math.PI * 2
      const tint = r()
      if (px < 0 || pz < 0 || px >= WORLD_M || pz >= WORLD_M) continue
      if (px >= (bx + 1) * FAR_BLOCK || pz >= (bz + 1) * FAR_BLOCK) continue // each tree in one block only
      const cell = Math.floor(pz / c.cell) * c.n + Math.floor(px / c.cell)
      if (c.water[cell] !== Water.Land || c.biome[cell] === 255) continue
      const biome = OW_BIOMES[c.biome[cell]]
      const d = FAR_DENSITY[biome]
      if (pick > d.per * step * step) continue
      const h = ground.base(px, pz)
      if (h < 1 || h > 430 || c.slope[cell] > 0.75) continue // no trees on the beach, peaks or cliffs
      if (ground.roads.nearest(px, pz).edge < 3 || ground.town(px, pz).weight > 0.3) continue
      let acc = 0
      let kind = d.kinds[0][0]
      for (const [k, share] of d.kinds) {
        acc += share
        if (kindPick < acc) {
          kind = k
          break
        }
      }
      out.push({ kind, x: px, y: h - 0.6, z: pz, rotation, scale, tint })
    }
  }
  return out
}
