/**
 * "Fantasy trail" world: a procedurally generated walk in three.js (see gen.ts for the rules).
 *
 * - Seeded: the active trail's seed (or the active route's id, or a per-browser seed when
 *   walking freely), so the same trail always looks the same.
 * - Biomes: dark forest, elven ruins, lakeside meadows, farmlands with windmills, villages of
 *   half-timbered houses, castle towns with gates and walls, a waterfall valley, the neon city.
 * - Terrain is generated in CHUNK_M chunks ahead of the walker and disposed behind it, one new
 *   chunk per frame at most, so generation never causes a hitch. Buildings are assembled from
 *   the CC0 kit (assets.ts) and baked per chunk; trees and plants are InstancedMeshes.
 * - Sky dome with sun, moon, stars and clouds; image-based light from the sky; fog, light rain,
 *   a day/night cycle (accelerated, or real local time); lit windows, lanterns and fireflies at
 *   night; bloom on high quality.
 * - Same smooth motion as the other worlds (the app hands in the smoothed distance) and the same
 *   damped chase camera maths (chase.ts), closer and lower for a walking-level view.
 * - Quality (high/medium/low) and a debug panel (`, off by default).
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { damp, dampAngle } from '../chase'
import type { World, WorldContext } from '../world'
import {
  BIOMES,
  BIOME_NAMES,
  type Biome,
  type BiomeSpan,
  CLIFF_M,
  FACES_PATH,
  PATH_HALF_WIDTH_M,
  type PropKind,
  QUALITY,
  type Quality,
  START_BIOMES,
  type StartBiome,
  RIVER,
  SMALL_PLANTS,
  TERRAIN_HALF_WIDTH_M,
  TrailPath,
  type Weights,
  biomePlan,
  biomeWeights,
  dominantBiome,
  fieldPatch,
  groundHeight,
  hashInts,
  formatClock,
  hourOfDay,
  isTimeMode,
  parseClock,
  type TimeMode,
  isStartBiome,
  nightness,
  noise2,
  rainAt,
  randomSeed,
  randomStartBiome,
  scatter,
  structures,
  sunHeight,
  waterfalls,
} from './gen'
import { BUILDING_MODELS, Kit, MODEL_FOR, bake, millBlades } from './assets'
import { type Box, DEFAULT_VIEW, type OrbitView, clampView, clearance, isDefaultView, orbitPose } from './orbit'
import { FreeWalkProgress } from './freewalk'
import { PropLibrary } from './props'
import { CLOCK, SkyDome, glowPointsMaterial, groundMaterial, noiseTexture, rippleNormals, waterfallMaterial } from './shaders'

const CHUNK_M = 40
const ROW_M = 4
const BEHIND_M = 60
const LOOK_AHEAD_M = 9
/** The walker's height in the scene, for placing the sprite when the camera moves. */
const WALKER_M = 1.7
const CAMERA_KEY = 'walkpad.fantasy.camera'
const HALF_LATERALS = [0.8, 1.6, 2.4, 3.4, 4.8, 6.5, 8.5, 11, 13.5, 16, 18.5, 21, 24, 28, 33, 40, 50, 64, 90, 140, 200]
const LATERALS = [...HALF_LATERALS.map((l) => -l).reverse(), 0, ...HALF_LATERALS]
const QUALITY_KEY = 'walkpad.fantasy.quality'
const TIME_KEY = 'walkpad.fantasy.time'
const CLOCK_KEY = 'walkpad.fantasy.clock'
const FREE_SEED_KEY = 'walkpad.fantasy.seed'
const FREE_START_KEY = 'walkpad.fantasy.start'
const LAKE_LEVEL = -1.3

const color = (hex: string) => new THREE.Color(hex)
const GROUND: Record<Biome, THREE.Color> = {
  forest: color('#2d4a26'),
  ruins: color('#55684f'),
  meadow: color('#6a9a40'),
  fields: color('#6f9440'),
  village: color('#66903f'),
  castle: color('#61883f'),
  falls: color('#4a7a34'),
  city: color('#2b2638'),
}
const PATH: Record<Biome, THREE.Color> = {
  forest: color('#5d4a36'),
  ruins: color('#9b968a'),
  meadow: color('#a08a60'),
  fields: color('#a08a60'),
  village: color('#8a8070'),
  castle: color('#8a8070'),
  falls: color('#857560'),
  city: color('#4a4262'),
}
const PATCH_COLORS: Record<string, THREE.Color> = {
  wheat: color('#b8a050'),
  green: color('#4f7f30'),
  plough: color('#6b5038'),
  lavender: color('#6a6a8a'),
  pasture: color('#6f9a42'),
}
const ROCK = color('#77736a')
const FOG_DENSITY: Record<Biome, number> = {
  forest: 0.016, ruins: 0.015, meadow: 0.0055, fields: 0.005, village: 0.0065, castle: 0.0065, falls: 0.009, city: 0.011,
}
const SKY = {
  dayZenith: color('#3a6fb5'), dayHorizon: color('#bdd5e8'),
  duskZenith: color('#2f3f70'), duskHorizon: color('#f2a26c'),
  nightZenith: color('#03060f'), nightHorizon: color('#121a2e'),
  cityZenith: color('#12061f'), cityHorizon: color('#3a1d4a'),
  mist: color('#a9bbbd'), rain: color('#8d96a0'), forest: color('#5f7262'),
}

interface Chunk {
  index: number
  s0: number
  group: THREE.Group
  owned: THREE.BufferGeometry[]
  instanced: THREE.InstancedMesh[]
  /** Grass, crops and flowers: hidden beyond the quality's grass distance. */
  small: THREE.Object3D[]
  /** Buildings: hidden beyond the quality's building distance. */
  buildings: THREE.Object3D[]
  spinners: THREE.Object3D[]
  /** Buildings are baked on a later frame than the terrain (spreads the work). */
  needsBuildings: boolean
}

interface Trail {
  key: string
  seed: number
  start: StartBiome
  length: number | null
  name: string
  /** The bridge's route id, or null for a free walk. */
  routeId: number | null
}

export class FantasyWorld implements World {
  readonly showsWalker = true
  private ctx!: WorldContext
  private root!: HTMLDivElement
  private renderer!: THREE.WebGLRenderer
  private composer: EffectComposer | null = null
  private bloom: UnrealBloomPass | null = null
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(60, 1, 0.2, 1400)
  private hemi = new THREE.HemisphereLight('#bcd7ff', '#4a3f2c', 0.6)
  private sun = new THREE.DirectionalLight('#fff1d6', 2.6)
  private moon = new THREE.DirectionalLight('#9fb4ff', 0)
  private fog = new THREE.FogExp2('#bdd5e8', 0.006)
  private sky = new SkyDome()
  private envScene = new THREE.Scene()
  private pmrem: THREE.PMREMGenerator | null = null
  private envTarget: THREE.WebGLRenderTarget | null = null
  private envAge = Number.POSITIVE_INFINITY
  private kit!: Kit
  private kitReady = false
  private props!: PropLibrary
  private textures: THREE.Texture[] = []
  private groundMaterial!: THREE.MeshStandardMaterial
  private waterMaterial!: THREE.MeshStandardMaterial
  private fallMaterial = waterfallMaterial()
  private sprayMaterial = glowPointsMaterial('#e8f4ff', 2.4, 0)
  private fireflies!: THREE.Points
  private blades = millBlades()
  private chunks = new Map<number, Chunk>()
  /** Flat ground far below the horizon, following the camera: never sky under the terrain. */
  private underlay = new THREE.Mesh(
    new THREE.CircleGeometry(2500, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#2b4a2a', roughness: 1 }),
  )
  private trail: Trail | null = null
  private path: TrailPath | null = null
  private plan: BiomeSpan[] = []
  private quality: Quality = 'high'
  private timeMode: TimeMode = 'cycle'
  /** The chosen hour for the 'fixed' time mode. */
  private fixedHour = 21
  private heading = 0
  private haveHeading = false
  private rain!: THREE.LineSegments
  private rainPositions!: Float32Array
  private rainIntensity = 0
  private resize = new ResizeObserver(() => this.fit())
  private debugEl!: HTMLDivElement
  private debug = false
  private fps = 60
  /** Slowest recent chunk build (decaying), for the debug panel. */
  private buildMs = 0
  private toolbar: HTMLDivElement | null = null
  private disposed = false
  /** User camera: where it is going (input) and where it is (damped towards it). */
  private view: OrbitView = { ...DEFAULT_VIEW }
  private shownView: OrbitView = { ...DEFAULT_VIEW }
  private pointers = new Map<number, { x: number; y: number }>()
  /** Building footprints near the walker (for the camera), refreshed every 20 m. */
  private nearBuildings: { s: number; boxes: Box[] } = { s: Number.NaN, boxes: [] }
  /** Where a free walk has got to, kept in this browser across page loads. */
  private free = new FreeWalkProgress({ get: readKey, set: writeKey })
  private pinch = 0

  init(container: HTMLElement, ctx: WorldContext): void {
    this.ctx = ctx
    this.quality = (readKey(QUALITY_KEY) as Quality) in QUALITY ? (readKey(QUALITY_KEY) as Quality) : 'high'
    const mode = readKey(TIME_KEY)
    this.timeMode = isTimeMode(mode) ? mode : 'cycle'
    this.fixedHour = parseClock(readKey(CLOCK_KEY)) ?? 21
    if (!ctx.obs) this.view = loadView()
    this.shownView = { ...this.view }
    this.root = document.createElement('div')
    this.root.className = 'fantasy-world'
    this.debugEl = document.createElement('div')
    this.debugEl.className = 'fantasy-debug'
    this.debugEl.hidden = true
    this.root.append(this.debugEl)
    container.append(this.root)

    this.makeRenderer()
    this.kit = new Kit(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()))
    this.props = new PropLibrary()
    const noise = noiseTexture()
    const ripples = rippleNormals()
    ripples.repeat.set(0.08, 0.08)
    this.textures.push(noise, ripples)
    this.groundMaterial = groundMaterial(noise, this.kit.materials.uneven.map!)
    this.waterMaterial = new THREE.MeshStandardMaterial({
      color: '#2f6a80', roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.86,
      normalMap: ripples, normalScale: new THREE.Vector2(0.6, 0.6), side: THREE.DoubleSide,
    })
    // The kit arrives a moment later; regenerate the chunks once it is there.
    void this.kit.load([...new Set([...BUILDING_MODELS, ...Object.values(MODEL_FOR)])]).then(() => {
      if (this.disposed) return
      this.props.useKit(this.kit)
      this.kitReady = true
      this.clearChunks()
    })
    this.scene.fog = this.fog
    this.scene.add(this.sky.mesh, this.hemi, this.sun, this.sun.target, this.moon, this.moon.target, this.underlay)
    this.envScene.add(new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material))
    this.makeFireflies()
    this.makeRain()
    if (!ctx.obs) {
      this.buildToolbar()
      this.listenForCamera()
    }
    window.addEventListener('keydown', this.onKey)
    this.resize.observe(this.root)
    this.fit()
  }

  // --- setup -----------------------------------------------------------------------------------

  private makeRenderer(): void {
    const q = QUALITY[this.quality]
    this.composer?.dispose()
    this.composer = null
    this.bloom = null
    this.pmrem?.dispose()
    this.envTarget?.dispose()
    this.envTarget = null
    this.renderer?.dispose()
    this.renderer?.domElement.remove()
    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias && !q.bloom, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.info.autoReset = false
    this.renderer.shadowMap.enabled = q.shadows
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envAge = Number.POSITIVE_INFINITY
    this.sun.castShadow = q.shadows
    if (q.shadows) {
      const size = this.quality === 'high' ? 2048 : 1024
      this.sun.shadow.mapSize.set(size, size)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
      const cam = this.sun.shadow.camera
      cam.left = cam.bottom = -50
      cam.right = cam.top = 50
      cam.near = 1
      cam.far = 400
      this.sun.shadow.bias = -0.0006
      this.sun.shadow.normalBias = 0.04
    }
    if (q.bloom) {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
      this.composer = new EffectComposer(this.renderer, target)
      this.composer.addPass(new RenderPass(this.scene, this.camera))
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.55, 0.92)
      this.composer.addPass(this.bloom)
      this.composer.addPass(new OutputPass())
    }
    this.renderer.domElement.className = 'fantasy-canvas'
    this.root.prepend(this.renderer.domElement)
    this.fit()
  }

  private fit(): void {
    const w = this.root.clientWidth || window.innerWidth
    const h = this.root.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.composer?.setPixelRatio(this.renderer.getPixelRatio())
    this.composer?.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    for (const m of [this.sprayMaterial, this.fireflies?.material as THREE.ShaderMaterial | undefined]) {
      if (m) m.uniforms.uPixelRatio.value = this.renderer.getPixelRatio()
    }
  }

  private makeFireflies(): void {
    const n = 320
    const pos = new Float32Array(n * 3)
    const seed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      pos.set([(Math.random() - 0.5) * 80, 0.4 + Math.random() * 3.2, (Math.random() - 0.5) * 80], i * 3)
      seed[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1))
    this.fireflies = new THREE.Points(g, glowPointsMaterial('#d8ff7a', 0.22, 80))
    this.fireflies.frustumCulled = false
    this.scene.add(this.fireflies)
  }

  private makeRain(): void {
    const n = QUALITY[this.quality].rainDrops
    this.rainPositions = new Float32Array(n * 6)
    const r = Math.random
    for (let i = 0; i < n; i++) {
      const x = (r() - 0.5) * 50
      const y = r() * 26
      const z = (r() - 0.5) * 50
      this.rainPositions.set([x, y, z, x + 0.05, y - 0.55, z], i * 6)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3))
    if (this.rain) {
      this.scene.remove(this.rain)
      this.rain.geometry.dispose()
      ;(this.rain.material as THREE.Material).dispose()
    }
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#c9d6e6', transparent: true, opacity: 0 }))
    this.rain.frustumCulled = false
    this.scene.add(this.rain)
  }

  private buildToolbar(): void {
    const bar = document.createElement('div')
    bar.className = 'fantasy-toolbar'
    bar.innerHTML = `
      <span class="fantasy-trail"></span>
      <label>quality <select class="fq"><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select></label>
      <label>time <select class="ft"><option value="cycle">day cycle</option><option value="real">real time</option><option value="fixed">fixed time</option></select>
        <input type="time" class="fclock" step="300" aria-label="time of day"></label>
      <button type="button" class="fcam" hidden title="Back to the camera behind the walker (or double-click)">⟲ Reset camera</button>
      <span class="fantasy-hint muted">drag: turn · wheel/pinch: zoom</span>
      <button type="button" class="fn">⟳ New world</button>
      <div class="fantasy-regen" hidden>
        <label>start in <select class="fs"><option value="">random</option>${START_BIOMES.map((b) => `<option value="${b}">${BIOME_NAMES[b]}</option>`).join('')}</select></label>
        <span class="fantasy-regen-note muted"></span>
        <div><button type="button" class="fgo">Generate</button> <button type="button" class="fcancel">Cancel</button></div>
      </div>`
    const fq = bar.querySelector<HTMLSelectElement>('.fq')!
    const ft = bar.querySelector<HTMLSelectElement>('.ft')!
    fq.value = this.quality
    ft.value = this.timeMode
    const clock = bar.querySelector<HTMLInputElement>('.fclock')!
    clock.value = formatClock(this.fixedHour)
    clock.hidden = this.timeMode !== 'fixed'
    clock.oninput = () => {
      const hour = parseClock(clock.value)
      if (hour === null) return
      this.fixedHour = hour
      writeKey(CLOCK_KEY, formatClock(hour))
    }
    fq.onchange = () => this.setQuality(fq.value as Quality)
    ft.onchange = () => {
      this.timeMode = isTimeMode(ft.value) ? ft.value : 'cycle'
      writeKey(TIME_KEY, this.timeMode)
      clock.hidden = this.timeMode !== 'fixed'
    }
    const regen = bar.querySelector<HTMLDivElement>('.fantasy-regen')!
    const note = bar.querySelector<HTMLSpanElement>('.fantasy-regen-note')!
    bar.querySelector<HTMLButtonElement>('.fn')!.onclick = () => {
      const trail = this.trail
      note.textContent = trail?.routeId !== null && trail?.routeId !== undefined
        ? `A new look for “${trail.name}”: new path and scenery; your progress stays.`
        : 'A new free-walk world.'
      regen.hidden = !regen.hidden
    }
    bar.querySelector<HTMLButtonElement>('.fcancel')!.onclick = () => { regen.hidden = true }
    bar.querySelector<HTMLButtonElement>('.fgo')!.onclick = () => {
      const chosen = bar.querySelector<HTMLSelectElement>('.fs')!.value
      regen.hidden = true
      void this.regenerate(isStartBiome(chosen) ? chosen : randomStartBiome())
    }
    bar.querySelector<HTMLButtonElement>('.fcam')!.onclick = () => this.setView({ ...DEFAULT_VIEW })
    this.toolbar = bar
    this.root.append(bar)
    this.updateRegenButton()
  }

  // --- user camera -------------------------------------------------------------------------------

  private setView(v: OrbitView): void {
    this.view = clampView(v)
    writeKey(CAMERA_KEY, JSON.stringify(this.view))
    const reset = this.toolbar?.querySelector<HTMLButtonElement>('.fcam')
    if (reset) reset.hidden = isDefaultView(this.view)
  }

  /** Drag to turn around the walker (and up/down), wheel or pinch to zoom, double-click to reset. */
  private listenForCamera(): void {
    const root = this.root
    const fromUi = (e: Event) => e.target instanceof Element && e.target.closest('.fantasy-toolbar, .fantasy-debug') !== null
    root.addEventListener('pointerdown', (e) => {
      if (fromUi(e) || (e.pointerType === 'mouse' && e.button !== 0)) return
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      root.setPointerCapture(e.pointerId)
      root.classList.add('dragging')
      if (this.pointers.size === 2) this.pinch = pinchDistance(this.pointers)
    })
    root.addEventListener('pointermove', (e) => {
      const last = this.pointers.get(e.pointerId)
      if (!last) return
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.pointers.size === 1) {
        this.setView({ ...this.view, yaw: this.view.yaw - dx * 0.35, elevation: this.view.elevation + dy * 0.25 })
      } else if (this.pointers.size === 2) {
        const d = pinchDistance(this.pointers)
        if (this.pinch > 0 && d > 0) this.setView({ ...this.view, zoom: this.view.zoom * (this.pinch / d) })
        this.pinch = d
      }
    })
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId)
      this.pinch = this.pointers.size === 2 ? pinchDistance(this.pointers) : 0
      if (this.pointers.size === 0) root.classList.remove('dragging')
    }
    root.addEventListener('pointerup', end)
    root.addEventListener('pointercancel', end)
    root.addEventListener('wheel', (e) => {
      if (fromUi(e)) return
      e.preventDefault()
      this.setView({ ...this.view, zoom: this.view.zoom * Math.exp(e.deltaY * 0.0012) })
    }, { passive: false })
    root.addEventListener('dblclick', (e) => {
      if (!fromUi(e)) this.setView({ ...DEFAULT_VIEW })
    })
    this.setView(this.view)
  }

  private buildingsNear(s: number): Box[] {
    if (!this.kitReady) return []
    if (!(Math.abs(s - this.nearBuildings.s) < 20)) {
      const boxes = structures(this.path!.seed, this.plan, s - 90, s + 90).filter((st) => st.foot).map((st) => st.foot!)
      this.nearBuildings = { s, boxes }
    }
    return this.nearBuildings.boxes
  }

  /** Keep the walker sprite on her spot in the scene: relative to where the default camera has her. */
  /** Stand the walker sprite where she is in the scene, true to scale (1.7 m), like everyone else. */
  private placeWalker(here: { x: number; z: number }, _heading: number): void {
    this.camera.updateMatrixWorld()
    const w = this.root.clientWidth || window.innerWidth
    const h = this.root.clientHeight || window.innerHeight
    const screen = (y: number) => {
      const p = new THREE.Vector3(here.x, y, here.z).project(this.camera)
      return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, behind: p.z > 1 }
    }
    const feet = screen(0)
    const head = screen(WALKER_M)
    this.ctx.placeWalkerAt(feet.behind || feet.y <= head.y ? null : { feet, height: feet.y - head.y })
  }

  /** Remote viewers (read-only) cannot change a trail; a free walk is this browser's own. */
  private updateRegenButton(): void {
    const button = this.toolbar?.querySelector<HTMLButtonElement>('.fn')
    if (!button) return
    const locked = this.trail?.routeId != null && !this.ctx.canEdit()
    button.disabled = locked
    button.title = locked ? 'Changing a trail needs local control (read-only here)' : 'Regenerate the world: new seed, choose where to start'
  }

  /** A new seed (and starting biome) for the active trail, or for the free walk. */
  private async regenerate(start: StartBiome): Promise<void> {
    const trail = this.trail
    const seed = randomSeed()
    if (trail?.routeId != null) {
      try {
        // The bridge broadcasts the changed route; the world rebuilds when it arrives.
        await this.ctx.bridge.updateRoute(trail.routeId, { seed, start_biome: start })
      } catch (err) {
        const label = this.toolbar?.querySelector('.fantasy-trail')
        if (label) label.textContent = `Could not regenerate: ${err instanceof Error ? err.message : String(err)}`
      }
      return
    }
    writeKey(FREE_SEED_KEY, String(seed))
    writeKey(FREE_START_KEY, start)
    this.free.reset(`free:${seed}:${start}`)
  }

  private setQuality(q: Quality): void {
    this.quality = q
    writeKey(QUALITY_KEY, q)
    this.makeRenderer()
    this.makeRain()
    this.clearChunks() // regenerate at the new density and shadow setting
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Backquote' || e.target instanceof HTMLInputElement) return
    this.debug = !this.debug
    this.debugEl.hidden = !this.debug
  }

  // --- trail -------------------------------------------------------------------------------------

  private currentTrail(): Trail {
    const route = this.ctx.activeRoute()
    if (route) {
      const seed = route.seed ?? hashInts(route.id, 77)
      const start = isStartBiome(route.start_biome) ? route.start_biome : 'forest'
      return {
        key: `${route.id}:${seed}:${start}:${route.distance_m}`, seed, start, length: route.distance_m, name: route.name, routeId: route.id,
      }
    }
    let seed = Number(readKey(FREE_SEED_KEY))
    if (!Number.isInteger(seed) || seed <= 0) {
      seed = randomSeed()
      writeKey(FREE_SEED_KEY, String(seed))
    }
    const stored = readKey(FREE_START_KEY)
    const start = isStartBiome(stored) ? stored : 'forest'
    return { key: `free:${seed}:${start}`, seed, start, length: null, name: 'Free walk', routeId: null }
  }

  private useTrail(trail: Trail): void {
    this.trail = trail
    this.path = new TrailPath(trail.seed)
    this.plan = biomePlan(trail.seed, trail.length, (trail.length ?? 0) + 500_000, trail.start)
    this.haveHeading = false
    this.nearBuildings = { s: Number.NaN, boxes: [] }
    if (trail.routeId === null) this.free.use(trail.key)
    this.clearChunks()
    const label = this.toolbar?.querySelector('.fantasy-trail')
    if (label) label.textContent = trail.length ? `${trail.name} · ${(trail.length / 1000).toFixed(1)} km` : trail.name
    this.updateRegenButton()
  }

  // --- frame -------------------------------------------------------------------------------------

  update(distanceM: number, _speedKmh: number, dt: number): void {
    const trail = this.currentTrail()
    if (trail.key !== this.trail?.key) this.useTrail(trail)
    const path = this.path!
    // A trail's position comes from the bridge (persisted per route); a free walk continues
    // from where this browser left it.
    const s = Math.max(0, trail.length ? Math.min(distanceM, trail.length) : this.free.position(distanceM))
    this.fps += ((dt > 0 ? 1 / dt : 60) - this.fps) * 0.05
    CLOCK.value += Math.min(dt, 0.1)

    this.stream(s)

    // Walker pose and the damped chase camera (heading looks a few metres ahead: curves).
    const here = path.pose(s)
    const ahead = path.pose(s + LOOK_AHEAD_M)
    const target = Math.atan2(ahead.x - here.x, ahead.z - here.z)
    const targetDeg = (target * 180) / Math.PI
    if (!this.haveHeading) {
      this.heading = targetDeg
      this.haveHeading = true
    } else {
      this.heading = dampAngle(this.heading, targetDeg, dt, 0.7)
    }
    const h = (this.heading * Math.PI) / 180
    const w = biomeWeights(this.plan, s)
    // The user's view (drag / wheel / pinch) eases in; the default is the classic chase camera.
    const v = this.shownView
    v.yaw = clampView({ ...v, yaw: v.yaw + shortestTurn(v.yaw, this.view.yaw) * (1 - Math.exp(-dt / 0.12)) }).yaw
    v.elevation = damp(v.elevation, this.view.elevation, dt, 0.12)
    v.zoom = damp(v.zoom, this.view.zoom, dt, 0.12)
    const pose = orbitPose(here.x, here.z, h, v)
    // Never inside a building: move in towards the walker when one is in the way.
    if (!isDefaultView(v)) {
      const ox = pose.camera.x - here.x
      const oz = pose.camera.z - here.z
      const forward = ox * Math.sin(here.heading) + oz * Math.cos(here.heading)
      const right = ox * Math.cos(here.heading) - oz * Math.sin(here.heading)
      const t = clearance(s, forward, right, this.buildingsNear(s))
      if (t < 1) {
        pose.camera.x = here.x + ox * t
        pose.camera.z = here.z + oz * t
        pose.camera.y = Math.max(1.6, pose.camera.y * t)
      }
    }
    // Stay above the ground under the camera (hills, cliffs) wherever it has been turned to.
    const lateral = -Math.sin((v.yaw * Math.PI) / 180) * Math.hypot(pose.camera.x - here.x, pose.camera.z - here.z)
    const floor = groundHeight(path.seed, pose.camera.x, pose.camera.z, lateral, w) + (isDefaultView(v) ? 1.5 : 0.8)
    const camY = Math.max(pose.camera.y, floor)
    this.camera.position.set(pose.camera.x, damp(this.camera.position.y || camY, camY, dt, 0.25), pose.camera.z)
    this.camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    this.placeWalker(here, h)

    this.underlay.position.set(here.x, -2.5, here.z)
    const under = this.underlay.material as THREE.MeshStandardMaterial
    under.color.setRGB(0, 0, 0)
    for (const b of BIOMES) under.color.add(GROUND[b].clone().multiplyScalar(w[b] * 0.7))

    for (const chunk of this.chunks.values()) {
      const ahead = chunk.s0 - s
      const near = ahead < QUALITY[this.quality].grassM && chunk.s0 + CHUNK_M > s - 20
      for (const m of chunk.small) m.visible = near
      for (const m of chunk.buildings) m.visible = ahead < QUALITY[this.quality].buildM
      for (const spinner of chunk.spinners) spinner.rotateZ(dt * 0.55)
    }
    this.atmosphere(s, w, dt, here)
    this.renderer.info.reset() // the composer renders several passes per frame
    if (this.composer) this.composer.render(dt)
    else this.renderer.render(this.scene, this.camera)
    if (this.debug) this.renderDebug(s, w)
  }

  private atmosphere(s: number, w: Weights, dt: number, here: { x: number; z: number }): void {
    const hour = hourOfDay(this.timeMode, Date.now(), 9, this.fixedHour)
    const night = Math.max(nightness(hour), w.city) // the city is always at night
    const sunUp = sunHeight(hour)
    const dusk = Math.max(0, 1 - Math.abs(sunUp) / 0.3) * (1 - w.city)
    this.rainIntensity = damp(this.rainIntensity, rainAt(this.path!.seed, s, w), dt, 2)
    const wet = Math.min(1, this.rainIntensity)

    const day = 1 - night
    // Sky colours: day -> dusk -> night (the city has its own purple night), mist and rain grey it.
    const u = this.sky.uniforms
    const nightZenith = SKY.nightZenith.clone().lerp(SKY.cityZenith, w.city)
    const nightHorizon = SKY.nightHorizon.clone().lerp(SKY.cityHorizon, w.city)
    u.uZenith.value.copy(SKY.dayZenith).lerp(SKY.duskZenith, dusk * 0.7).lerp(nightZenith, night)
    u.uHorizon.value.copy(SKY.dayHorizon).lerp(SKY.duskHorizon, dusk * 0.85).lerp(nightHorizon, night)
    const grey = Math.max(w.ruins * 0.35, wet * 0.6) * (1 - night * 0.7)
    u.uZenith.value.lerp(SKY.rain, grey * 0.5)
    u.uHorizon.value.lerp(w.ruins > wet ? SKY.mist : SKY.rain, grey)
    u.uHorizon.value.lerp(SKY.forest, w.forest * 0.55 * day)
    u.uNight.value = night
    u.uCloud.value = Math.min(0.95, 0.38 + wet * 0.5 + w.ruins * 0.15 + w.falls * 0.08)
    u.uCloudLit.value.set('#ffffff').lerp(color('#ffc29a'), dusk * 0.8).lerp(color('#2c3446'), night)
    u.uCloudShade.value.set('#9aa6b6').lerp(color('#a0707a'), dusk * 0.6).lerp(color('#0d111b'), night)
    u.uSunColor.value.set('#fff0d8').lerp(color('#ff9a4a'), dusk)
    const sunAngle = ((hour - 6) / 24) * Math.PI * 2
    const sunDir = new THREE.Vector3(Math.cos(sunAngle) * 0.75, Math.sin(sunAngle), 0.42).normalize()
    u.uSunDir.value.copy(sunDir)
    u.uMoonDir.value.copy(sunDir).negate().setY(Math.abs(sunDir.y) * 0.8 + 0.25).normalize()
    this.sky.mesh.position.copy(this.camera.position)
    this.fog.color.copy(u.uHorizon.value)
    this.renderer.setClearColor(u.uHorizon.value)
    let density = 0
    for (const b of BIOMES) density += FOG_DENSITY[b] * w[b]
    this.fog.density = density * (1 + wet * 0.6) * (1 + night * 0.2)

    // Lights (the dark forest is dim under its canopy).
    this.sun.color.copy(u.uSunColor.value)
    this.sun.intensity = Math.max(0, sunUp) * 2.9 * (1 - w.city) * (1 - wet * 0.45) * (1 - w.forest * 0.4) + dusk * 0.4 * day
    this.hemi.color.copy(u.uZenith.value).lerp(color('#ffffff'), 0.45)
    this.hemi.groundColor.set('#4a3f2c').lerp(color('#10121a'), night)
    this.hemi.intensity = 0.25 + day * 0.45 * (1 - w.forest * 0.35) + (w.city > 0.5 ? 0.25 : 0)
    this.moon.intensity = night * 0.45 * (1 - w.city * 0.5)
    const lightDir = sunDir.y > 0.08 ? sunDir : new THREE.Vector3(sunDir.x, 0.08, sunDir.z).normalize()
    this.sun.position.set(here.x + lightDir.x * 150, lightDir.y * 150, here.z + lightDir.z * 150)
    this.sun.target.position.set(here.x, 0, here.z)
    this.moon.position.set(here.x + u.uMoonDir.value.x * 150, u.uMoonDir.value.y * 150, here.z + u.uMoonDir.value.z * 150)
    this.moon.target.position.set(here.x, 0, here.z)
    this.kit.setNight(night)
    this.fallMaterial.uniforms.uLight.value = 0.25 + day * 0.85
    this.sprayMaterial.uniforms.uAlpha.value = 0.18 + day * 0.25
    const ff = this.fireflies.material as THREE.ShaderMaterial
    ff.uniforms.uCenter.value.copy(this.camera.position)
    ff.uniforms.uAlpha.value = night * Math.min(1, w.forest + w.meadow + w.falls + w.fields + w.ruins * 0.6 + w.village * 0.4) * (1 - wet)
    this.fireflies.visible = ff.uniforms.uAlpha.value > 0.01
    this.fireflies.position.y = 0
    if (this.bloom) this.bloom.strength = 0.25 + night * 0.4

    // Image-based light from the sky, refreshed every few seconds (reflections in water too).
    this.envAge += dt
    if (this.envAge > 3 && this.pmrem) {
      this.envAge = 0
      const old = this.envTarget
      this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000)
      this.scene.environment = this.envTarget.texture
      old?.dispose()
    }
    this.scene.environmentIntensity = 0.35 + day * 0.35

    // Rain: drops fall through a box that travels with the camera.
    const mat = this.rain.material as THREE.LineBasicMaterial
    mat.opacity = Math.min(0.55, this.rainIntensity * 0.45)
    this.rain.visible = mat.opacity > 0.01
    if (this.rain.visible) {
      const p = this.rainPositions
      const fall = 11 * dt
      for (let i = 0; i < p.length; i += 6) {
        p[i + 1] -= fall
        p[i + 4] -= fall
        if (p[i + 4] < 0) {
          p[i + 1] += 26
          p[i + 4] += 26
        }
      }
      this.rain.geometry.getAttribute('position').needsUpdate = true
      this.rain.position.set(this.camera.position.x, 0, this.camera.position.z)
    }
  }

  // --- chunk streaming ---------------------------------------------------------------------------

  private stream(s: number): void {
    // Looking back (camera turned or zoomed out) needs more terrain behind the walker.
    const back = Math.abs(this.view.yaw) > 50 ? QUALITY[this.quality].viewM * 0.6 : BEHIND_M * Math.max(1, this.view.zoom)
    const first = Math.floor((s - back) / CHUNK_M)
    const last = Math.floor((s + QUALITY[this.quality].viewM) / CHUNK_M)
    for (const [i, chunk] of this.chunks) {
      if (i < first || i > last) this.dropChunk(chunk)
    }
    // At most one piece of work per frame, nearest first: a chunk's terrain and plants, or a
    // chunk's buildings. No generation hitches. Two chunks exist before the start, so the ground
    // behind the camera is there at position 0 too.
    const t0 = performance.now()
    let work = false
    for (let i = Math.max(-2, first); i <= last && !work; i++) {
      const chunk = this.chunks.get(i)
      if (!chunk) {
        this.chunks.set(i, this.buildChunk(i))
        work = true
      } else if (chunk.needsBuildings) {
        this.addBuildings(chunk)
        work = true
      }
    }
    if (work) this.buildMs = Math.max(performance.now() - t0, this.buildMs * 0.98)
  }

  private buildChunk(index: number): Chunk {
    const path = this.path!
    const seed = path.seed
    const s0 = index * CHUNK_M
    const s1 = s0 + CHUNK_M
    const shadows = QUALITY[this.quality].shadows
    const chunk: Chunk = { index, s0, group: new THREE.Group(), owned: [], instanced: [], small: [], buildings: [], spinners: [], needsBuildings: this.kitReady }
    const add = (obj: THREE.Object3D, geometry?: THREE.BufferGeometry) => {
      chunk.group.add(obj)
      if (geometry) chunk.owned.push(geometry)
    }

    // Ground: rows along the trail, columns across it; shared edges with the neighbours.
    const rows = CHUNK_M / ROW_M + 1
    const cols = LATERALS.length
    const pos = new Float32Array(rows * cols * 3)
    const col = new Float32Array(rows * cols * 3)
    const road = new Float32Array(rows * cols)
    const uv = new Float32Array(rows * cols * 2)
    const c = new THREE.Color()
    for (let r = 0; r < rows; r++) {
      const s = s0 + r * ROW_M
      const w = biomeWeights(this.plan, s)
      const groundColor = new THREE.Color(0, 0, 0)
      const pathColor = new THREE.Color(0, 0, 0)
      for (const b of BIOMES) {
        groundColor.add(GROUND[b].clone().multiplyScalar(w[b]))
        pathColor.add(PATH[b].clone().multiplyScalar(w[b]))
      }
      const town = Math.min(1, w.village + w.castle)
      for (let k = 0; k < cols; k++) {
        const lateral = LATERALS[k]
        const a = Math.abs(lateral)
        const p = path.side(s, lateral)
        const y = groundHeight(seed, p.x, p.z, lateral, w)
        const i = r * cols + k
        pos.set([p.x, y, p.z], i * 3)
        const onPath = a <= PATH_HALF_WIDTH_M
        c.copy(onPath ? pathColor : groundColor)
        if (!onPath && w.fields > 0) {
          const patch = fieldPatch(seed, s, lateral)
          if (patch) c.lerp(PATCH_COLORS[patch], w.fields)
        }
        if (w.falls > 0 && a > CLIFF_M) c.lerp(ROCK, w.falls * Math.min(1, (a - CLIFF_M) / 5) * (a < 33 ? 1 : 0.35))
        if (w.falls > 0 && lateral > RIVER.lat0 && lateral < RIVER.lat1) c.lerp(color('#5b5a4a'), w.falls * 0.6)
        if (w.meadow > 0 && y < LAKE_LEVEL + 0.5) c.lerp(color('#6a6248'), w.meadow * 0.6) // shore
        const jitter = 0.9 + noise2(seed + 5, p.x / 6, p.z / 6) * 0.1
        c.multiplyScalar(jitter)
        col.set([c.r, c.g, c.b], i * 3)
        road[i] = onPath ? town : 0
        uv.set([lateral / 2.6, s / 2.6], i * 2)
      }
    }
    const index3: number[] = []
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = r * cols + k
        // Counter-clockwise seen from above (normals up): lateral is +x, rows go +z.
        index3.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.setAttribute('road', new THREE.BufferAttribute(road, 1))
    g.setAttribute('groundUv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(index3)
    g.computeVertexNormals()
    // Steep slopes show rock.
    const normals = g.getAttribute('normal')
    for (let i = 0; i < normals.count; i++) {
      const steep = Math.max(0, Math.min(1, (0.82 - normals.getY(i)) / 0.25))
      if (steep > 0) {
        c.fromArray(col, i * 3).lerp(ROCK, steep * 0.85)
        col.set([c.r, c.g, c.b], i * 3)
      }
    }
    const ground = new THREE.Mesh(g, this.groundMaterial)
    ground.receiveShadow = shadows
    add(ground, g)

    // Water: lakes in the meadows, the river in the waterfall valley.
    // Wherever the biome has any weight in this stretch: the water then shows up gradually, as
    // the ground sinks below it, instead of starting with a straight edge at a chunk boundary.
    const ends = [biomeWeights(this.plan, s0), biomeWeights(this.plan, s1)]
    const mid = { meadow: Math.max(...ends.map((w) => w.meadow)), falls: Math.max(...ends.map((w) => w.falls)) }
    if (mid.meadow > 0) {
      for (const side of [-1, 1]) add(...this.waterStrip(s0, s1, side * 9, side * TERRAIN_HALF_WIDTH_M, LAKE_LEVEL))
    }
    if (mid.falls > 0) add(...this.waterStrip(s0, s1, RIVER.lat0 - 0.4, RIVER.lat1 + 0.6, RIVER.level))
    for (const fall of waterfalls(seed, this.plan, s0, s1)) this.addWaterfall(chunk, fall.s, fall.side, fall.width)

    // Props: one InstancedMesh per part per kind, keeping out of the buildings nearby.
    const avoid = this.kitReady
      ? structures(seed, this.plan, s0 - 70, s1 + 70).filter((st) => st.foot).map((st) => st.foot!)
      : []
    const placements = scatter(seed, index, s0, s1, this.plan, QUALITY[this.quality].density, avoid)
    const byKind = new Map<PropKind, typeof placements>()
    for (const p of placements) {
      const list = byKind.get(p.kind)
      if (list) list.push(p)
      else byKind.set(p.kind, [p])
    }
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const white = new THREE.Color(1, 1, 1)
    for (const [kind, list] of byKind) {
      const small = SMALL_PLANTS.includes(kind)
      for (const part of this.props.parts[kind]) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length)
        list.forEach((p, i) => {
          const at = path.side(p.s, p.lateral)
          const w = biomeWeights(this.plan, p.s)
          const y = groundHeight(seed, at.x, at.z, p.lateral, w)
          const pose = path.pose(p.s)
          const facing = FACES_PATH.includes(kind)
            ? pose.heading + Math.PI / 2
            : kind === 'strip' ? pose.heading : p.rotation
          // Neon signs hang at different heights on the buildings.
          const lift = kind === 'neon' ? 3 + p.tint * 9 : 0
          q.setFromAxisAngle(up, kind === 'lamp' ? 0 : facing)
          m.compose(new THREE.Vector3(at.x, y - 0.05 + lift, at.z), q, PropLibrary.size(kind, p.scale, p.tint))
          mesh.setMatrixAt(i, m)
          const tint = PropLibrary.color(kind, p.tint)
          mesh.setColorAt(i, part.tinted ? tint : white.clone().multiplyScalar(tint.r))
        })
        mesh.castShadow = part.shadow && shadows
        mesh.receiveShadow = shadows && !small
        mesh.computeBoundingSphere()
        add(mesh)
        chunk.instanced.push(mesh)
        if (small) chunk.small.push(mesh)
      }
    }
    this.scene.add(chunk.group)
    return chunk
  }

  /** Buildings: assembled from the kit, baked into one mesh per material. */
  private addBuildings(chunk: Chunk): void {
    chunk.needsBuildings = false
    const path = this.path!
    const seed = path.seed
    const shadows = QUALITY[this.quality].shadows
    const add = (obj: THREE.Object3D, geometry?: THREE.BufferGeometry) => {
      chunk.group.add(obj)
      if (geometry) chunk.owned.push(geometry)
    }
    const built = structures(seed, this.plan, chunk.s0, chunk.s0 + CHUNK_M)
    if (built.length) {
      const items: { model: string; matrix: THREE.Matrix4 }[] = []
      const anchor = new THREE.Matrix4()
      const local = new THREE.Matrix4()
      for (const st of built) {
        const pose = path.pose(st.s)
        const at = path.side(st.s, st.lateral)
        const y = groundHeight(seed, at.x, at.z, st.lateral, biomeWeights(this.plan, st.s))
        anchor.makeRotationY(pose.heading + st.yaw).setPosition(at.x, y, at.z)
        for (const piece of st.pieces) {
          if (!this.kit.has(piece.model)) continue
          local.makeRotationY(piece.ry).setPosition(piece.x, piece.y, piece.z)
          items.push({ model: piece.model, matrix: anchor.clone().multiply(local) })
        }
        if (st.kind === 'windmill') {
          const blades = new THREE.Group()
          anchor.clone().multiply(local.makeTranslation(0, 8.3, 3.25)).decompose(blades.position, blades.quaternion, blades.scale)
          const spin = new THREE.Group()
          blades.add(spin)
          for (const part of this.blades) {
            const m = new THREE.Mesh(part.geometry, this.kit.materials[part.mat])
            m.castShadow = shadows
            spin.add(m)
          }
          spin.rotation.z = (hashInts(seed, Math.round(st.s)) % 628) / 100
          add(blades)
          chunk.buildings.push(blades)
          chunk.spinners.push(spin)
        }
      }
      for (const [mat, geometry] of bake(this.kit, items)) {
        const mesh = new THREE.Mesh(geometry, this.kit.materials[mat])
        mesh.castShadow = shadows && mat !== 'glass' && mat !== 'glassDark'
        mesh.receiveShadow = shadows
        add(mesh, geometry)
        chunk.buildings.push(mesh)
      }
    }
  }

  /** A strip of water following the path between two laterals. */
  private waterStrip(s0: number, s1: number, lat0: number, lat1: number, y: number): [THREE.Mesh, THREE.BufferGeometry] {
    const path = this.path!
    const p: number[] = []
    for (let s = s0; s < s1; s += ROW_M) {
      const a0 = path.side(s, lat0)
      const a1 = path.side(s, lat1)
      const b0 = path.side(s + ROW_M, lat0)
      const b1 = path.side(s + ROW_M, lat1)
      p.push(a0.x, y, a0.z, a1.x, y, a1.z, b0.x, y, b0.z, a1.x, y, a1.z, b1.x, y, b1.z, b0.x, y, b0.z)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    const uv = new Float32Array((p.length / 3) * 2)
    for (let i = 0; i < p.length / 3; i++) uv.set([p[i * 3], p[i * 3 + 2]], i * 2)
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.computeVertexNormals()
    const mesh = new THREE.Mesh(g, this.waterMaterial)
    mesh.receiveShadow = QUALITY[this.quality].shadows
    return [mesh, g]
  }

  /** A waterfall sliding down the cliff face at `s`, with a pool and spray at its foot. */
  private addWaterfall(chunk: Chunk, s: number, side: number, width: number): void {
    const path = this.path!
    const seed = path.seed
    // Follow the terrain's own columns, so the water lies on the cliff face and not inside it.
    // The water has volume: an outer sheet THICK metres off the face, and end caps that face
    // along the path (the part a walker actually sees from afar).
    const columns = HALF_LATERALS.filter((l) => l >= CLIFF_M - 1 && l <= CLIFF_M + 16).reverse()
    const segments = columns.length - 1
    const THICK = 2.2
    const pos: number[] = []
    const uv: number[] = []
    const index: number[] = []
    const strip = (point: (i: number, e: number) => [number, number, number], u: [number, number]) => {
      const base = pos.length / 3
      for (let i = 0; i <= segments; i++) {
        for (const e of [0, 1]) {
          pos.push(...point(i, e))
          uv.push(u[e], i / segments)
        }
      }
      for (let i = 0; i < segments; i++) {
        const k = base + i * 2
        index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
      }
    }
    const at = (ss: number, i: number, inset: number): [number, number, number] => {
      const lateral = side * columns[i]
      const face = path.side(ss, lateral)
      const y = groundHeight(seed, face.x, face.z, lateral, biomeWeights(this.plan, ss)) + 0.6
      const p = path.side(ss, lateral - side * inset * (0.4 + 0.6 * Math.min(1, i / 2)))
      return [p.x, y, p.z]
    }
    const sA = s - width / 2
    const sB = s + width / 2
    strip((i, e) => at(e ? sB : sA, i, THICK), [0, 1])
    strip((i, e) => at(sA, i, e ? THICK : 0), [0, 0.25])
    strip((i, e) => at(sB, i, e ? THICK : 0), [0.75, 1])
    const footAt = at(s, segments, THICK)
    const foot = { x: footAt[0], y: footAt[1] - 0.6, z: footAt[2] }
    const bottom = columns[segments]
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(index)
    const fall = new THREE.Mesh(g, this.fallMaterial)
    chunk.group.add(fall)
    chunk.owned.push(g)
    // Pool (the river takes the right-hand falls) and spray.
    if (side < 0) {
      const pg = new THREE.CircleGeometry(width * 0.6 + 2, 24).rotateX(-Math.PI / 2).translate(foot.x, foot.y + 0.15, foot.z)
      chunk.group.add(new THREE.Mesh(pg, this.waterMaterial))
      chunk.owned.push(pg)
    }
    const n = Math.round(20 + width * 5)
    const sp = new Float32Array(n * 3)
    const seeds = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const r = (k: number) => hashInts(seed, Math.round(s * 10), i, k) / 4294967296
      const across = path.side(s + (r(1) - 0.5) * width, side * (bottom - THICK - r(2) * 3))
      sp.set([across.x, foot.y + r(3) * 3, across.z], i * 3)
      seeds[i] = r(4)
    }
    const spray = new THREE.BufferGeometry()
    spray.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    spray.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
    const points = new THREE.Points(spray, this.sprayMaterial)
    chunk.group.add(points)
    chunk.owned.push(spray)
  }

  private dropChunk(chunk: Chunk): void {
    this.scene.remove(chunk.group)
    for (const g of chunk.owned) g.dispose()
    for (const mesh of chunk.instanced) mesh.dispose() // instance buffers; shared geometry stays
    this.chunks.delete(chunk.index)
  }

  private clearChunks(): void {
    for (const chunk of [...this.chunks.values()]) this.dropChunk(chunk)
  }

  // --- debug -------------------------------------------------------------------------------------

  private renderDebug(s: number, w: Weights): void {
    const info = this.renderer.info.render
    const biome = dominantBiome(w)
    const mix = BIOMES.filter((b) => w[b] > 0.01).map((b) => `${b} ${(w[b] * 100).toFixed(0)}%`).join(', ')
    const hour = hourOfDay(this.timeMode, Date.now(), 9, this.fixedHour)
    const next = this.plan.find((sp) => sp.start > s)
    this.debugEl.textContent = [
      `seed ${this.trail?.seed}  ·  start ${this.trail?.start}  ·  ${this.trail?.name}`,
      `s ${s.toFixed(1)} m${this.trail?.length ? ` / ${this.trail.length.toFixed(0)} m` : ''}`,
      `biome ${BIOME_NAMES[biome]} (${mix})`,
      next ? `next ${BIOME_NAMES[next.biome]} in ${((next.start - s) / 1000).toFixed(2)} km` : '',
      `time ${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')} (${this.timeMode})  rain ${this.rainIntensity.toFixed(2)}`,
      `fps ${this.fps.toFixed(0)}  ·  draw calls ${info.calls}  ·  triangles ${info.triangles}`,
      `camera yaw ${this.shownView.yaw.toFixed(0)}°  ·  elevation ${this.shownView.elevation.toFixed(0)}°  ·  zoom ${this.shownView.zoom.toFixed(2)}`,
      `chunks ${this.chunks.size} (build ≤ ${this.buildMs.toFixed(1)} ms)  ·  quality ${this.quality}  ·  kit ${this.kitReady ? 'ready' : 'loading'}`,
    ].filter(Boolean).join('\n')
  }

  dispose(): void {
    this.disposed = true
    window.removeEventListener('keydown', this.onKey)
    this.resize.disconnect()
    this.clearChunks()
    this.props.dispose()
    this.kit.dispose()
    for (const part of this.blades) part.geometry.dispose()
    for (const t of this.textures) t.dispose()
    this.groundMaterial.dispose()
    this.waterMaterial.dispose()
    this.fallMaterial.dispose()
    this.sprayMaterial.dispose()
    this.fireflies.geometry.dispose()
    ;(this.fireflies.material as THREE.Material).dispose()
    this.sky.dispose()
    this.underlay.geometry.dispose()
    ;(this.underlay.material as THREE.Material).dispose()
    this.rain.geometry.dispose()
    ;(this.rain.material as THREE.Material).dispose()
    this.envTarget?.dispose()
    this.pmrem?.dispose()
    this.composer?.dispose()
    this.renderer.dispose()
    this.root.remove()
  }
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/** The camera view saved in this browser, or the default. */
function loadView(): OrbitView {
  try {
    const v = JSON.parse(readKey(CAMERA_KEY) ?? 'null') as OrbitView | null
    if (v && [v.yaw, v.elevation, v.zoom].every(Number.isFinite)) return clampView(v)
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_VIEW }
}

/** Degrees to turn from `from` to `to` the short way round. */
function shortestTurn(from: number, to: number): number {
  return ((((to - from + 180) % 360) + 360) % 360) - 180
}

function pinchDistance(pointers: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...pointers.values()]
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
}
