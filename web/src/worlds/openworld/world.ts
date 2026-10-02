/**
 * "Open world": walk the continent you saved and chose on the world map (the active world on the
 * bridge). The pad says how far; A/D (or Q/E) turn. Your position is saved on the bridge per
 * world, so the next walk continues where this one stopped.
 *
 * - Terrain in 64 m tiles around you: fine (2 m grid, plants, buildings) near, coarse further,
 *   and one low-detail mesh of the whole island behind them, so far mountains are always there.
 *   At most one piece of work per frame (a tile, or a tile's buildings).
 * - Water: the sea, flat lakes, river ribbons following the land, waterfalls with spray.
 * - Towns, castles, ruins and windmills from towns.ts, built from the fantasy kit and baked
 *   per tile; plants from flora.ts as instanced meshes.
 * - Same chase camera (with turn / tilt / zoom), walker sprite placement, sky, light and bloom
 *   as the fantasy world (scene.ts).
 * - Remote (view-only) pages never move or save: they follow the position the bridge has.
 */

import * as THREE from 'three'
import type { SavedWorld } from '../../bridge'
import { damp, dampAngle } from '../chase'
import { Kit, BUILDING_MODELS, MODEL_FOR, bake, millBlades } from '../fantasy/assets'
import {
  FACES_PATH, QUALITY, type Quality, SMALL_PLANTS, formatClock, hourOfDay, isTimeMode, parseClock, type TimeMode,
} from '../fantasy/gen'
import { DEFAULT_VIEW, type OrbitView, clampView, orbitPose, walkerPlacement } from '../fantasy/orbit'
import { PropLibrary } from '../fantasy/props'
import { CLOCK, glowPointsMaterial, groundMaterial, noiseTexture, rippleNormals, waterfallMaterial } from '../fantasy/shaders'
import type { World, WorldContext } from '../world'
import { type Continent, OW_BIOMES, OW_BIOME_NAMES, Water, WORLD_M, cellAt } from './continent'
import { decodeSnapshot } from './continent/snapshot'
import { fieldAt, plantTile } from './flora'
import { Ground, riverHalfWidth } from './ground'
import { colorAt } from './mapdraw'
import { STEER_KEYS, TURN_RATE, step } from './movement'
import { Progress } from './progress'
import { Scene3d } from './scene'
import { type Building, type Footprint, type TownProp, insideFoot, layoutTowns } from './towns'

const TILE = 64
const FINE_M = 190
const WALKER_M = 1.7
const SAVE_EVERY_S = 4
const KEYS = { quality: 'walkpad.openworld.quality', time: 'walkpad.openworld.time', clock: 'walkpad.openworld.clock', view: 'walkpad.openworld.camera' }
const FAR_KINDS = new Set(['pine', 'oak', 'birch', 'rock'])
const RIVER_DROP = 1.5 - 0.55 // ground is carved this much below the grid; water sits 0.55 above the bed

const color = (hex: string) => new THREE.Color(hex)
const GROUND = {
  forest: color('#2f4c27'), ruins: color('#55684f'), meadow: color('#6a9a40'), fields: color('#6f9440'), falls: color('#5f7a45'),
}
const FIELD_COLORS: Record<string, THREE.Color> = {
  wheat: color('#b8a050'), green: color('#4f7f30'), plough: color('#6b5038'), lavender: color('#6a6a8a'), pasture: color('#6f9a42'),
}
const ROCK = color('#7a756b')
const SNOW = color('#e9eef1')
const SAND = color('#cbbd8a')
const DIRT = color('#8f7a58')
const BED = color('#5b5847')

interface Tile {
  key: string
  level: 0 | 1
  group: THREE.Group
  owned: THREE.BufferGeometry[]
  instanced: THREE.InstancedMesh[]
  small: THREE.Object3D[]
  spinners: THREE.Object3D[]
  needsBuildings: boolean
}

interface RiverLine {
  pts: [number, number][]
  level: number[]
  half: number[]
  /** Unit vector to the right of the flow at each point. */
  right: [number, number][]
}

export class OpenWorld implements World {
  readonly showsWalker = true
  readonly usesRoute = false
  private ctx!: WorldContext
  private root!: HTMLDivElement
  private note!: HTMLDivElement
  private s3!: Scene3d
  private kit!: Kit
  private props!: PropLibrary
  private groundMat!: THREE.MeshStandardMaterial
  private waterMat!: THREE.MeshStandardMaterial
  private fallMat = waterfallMaterial()
  private sprayMat = glowPointsMaterial('#e8f4ff', 2.4, 0)
  private textures: THREE.Texture[] = []
  private blades = millBlades()
  private quality: Quality = 'high'
  private timeMode: TimeMode = 'cycle'
  private fixedHour = 12
  private disposed = false

  // The world
  private saved: SavedWorld | null = null
  private c: Continent | null = null
  private ground: Ground | null = null
  private buildings: Building[] = []
  private townProps: TownProp[] = []
  private feet = new Map<number, Footprint[]>()
  private rivers: RiverLine[] = []
  private far: THREE.Mesh | null = null
  /** Centre (x, z) and radius of the hole in the far mesh. */
  private farHole = { value: new THREE.Vector3(0, 0, 0) }
  private sea!: THREE.Mesh
  private tiles = new Map<string, Tile>()
  private kitReady = false

  // The walker
  private player = { x: WORLD_M / 2, z: WORLD_M / 2, heading: 0 }
  private camHeading = 0
  private lastOdometer: number | null = null
  private walkedBase = 0
  private walkedHere = 0
  private turn = new Set<string>()
  private held = false
  private savedAt = 0
  private lastSave = { x: 0, z: 0, heading: 0 }
  private follow: { x: number; z: number; heading: number } | null = null
  private pollAt = 0

  // Camera
  private view: OrbitView = { ...DEFAULT_VIEW }
  private shownView: OrbitView = { ...DEFAULT_VIEW }
  private refCamera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000)
  private pointers = new Map<number, { x: number; y: number }>()
  private pinch = 0

  // HUD
  private compass!: HTMLDivElement
  private where!: HTMLDivElement
  private banner!: HTMLDivElement
  private progress!: Progress
  private minimap!: HTMLCanvasElement
  private mapImage: HTMLCanvasElement | null = null
  private miniAt = 0
  private province = -1
  private bannerTimer: ReturnType<typeof setTimeout> | null = null
  private debugEl!: HTMLDivElement
  private debug = false
  private fps = 60
  private buildMs = 0
  private resize = new ResizeObserver(() => this.fit())

  init(container: HTMLElement, ctx: WorldContext): void {
    this.ctx = ctx
    const q = readKey(KEYS.quality)
    this.quality = q === 'high' || q === 'medium' || q === 'low' ? q : 'high'
    const mode = readKey(KEYS.time)
    this.timeMode = isTimeMode(mode) ? mode : 'cycle'
    this.fixedHour = parseClock(readKey(KEYS.clock)) ?? 12
    if (!ctx.obs) this.view = loadView()
    this.shownView = { ...this.view }
    this.root = document.createElement('div')
    this.root.className = 'fantasy-world openworld'
    this.root.innerHTML = `
      <div class="ow-compass"><div class="ow-strip"></div><span class="ow-needle"></span></div>
      <div class="ow-where"></div>
      <div class="ow-banner" hidden></div>
      <canvas class="ow-minimap" width="190" height="190"></canvas>
      <div class="fantasy-debug" hidden></div>
      <div class="ow-note"></div>`
    this.compass = this.root.querySelector('.ow-compass')!
    this.where = this.root.querySelector('.ow-where')!
    this.banner = this.root.querySelector('.ow-banner')!
    this.minimap = this.root.querySelector('.ow-minimap')!
    this.debugEl = this.root.querySelector('.fantasy-debug')!
    this.note = this.root.querySelector('.ow-note')!
    this.buildCompass()
    this.progress = new Progress(this.root, ctx.bridge, () => ctx.canEdit())
    container.append(this.root)

    this.s3 = new Scene3d(this.root, this.quality)
    this.kit = new Kit(Math.min(8, this.s3.renderer.capabilities.getMaxAnisotropy()))
    this.props = new PropLibrary()
    const noise = noiseTexture()
    const ripples = rippleNormals()
    ripples.repeat.set(0.08, 0.08)
    this.textures.push(noise, ripples)
    this.groundMat = groundMaterial(noise, this.kit.materials.uneven.map!)
    this.waterMat = new THREE.MeshStandardMaterial({
      color: '#2f6a80', roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.88,
      normalMap: ripples, normalScale: new THREE.Vector2(0.6, 0.6), side: THREE.DoubleSide,
    })
    this.sea = new THREE.Mesh(new THREE.CircleGeometry(4000, 64).rotateX(-Math.PI / 2), this.waterMat)
    this.s3.scene.add(this.sea)
    void this.kit.load([...new Set([...BUILDING_MODELS, ...Object.values(MODEL_FOR)])]).then(() => {
      if (this.disposed) return
      this.props.useKit(this.kit)
      this.kitReady = true
      for (const t of this.tiles.values()) this.dropTile(t) // rebuild with the kit's pieces
    })
    if (!ctx.obs) {
      this.buildToolbar()
      this.listenForCamera()
    }
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('pagehide', this.onPageHide)
    this.resize.observe(this.root)
    this.fit()
    this.showNote('Loading your world…')
    void this.load()
  }

  private fit(): void {
    this.s3.fit()
    this.refCamera.aspect = this.s3.camera.aspect
    this.refCamera.updateProjectionMatrix()
  }

  private showNote(text: string | null, html = false): void {
    this.note.hidden = text === null
    if (html) this.note.innerHTML = text ?? ''
    else this.note.textContent = text ?? ''
  }

  // --- loading -------------------------------------------------------------------------------

  private async load(): Promise<void> {
    let worlds: SavedWorld[]
    try {
      worlds = await this.ctx.bridge.worlds()
    } catch (err) {
      this.showNote(`Could not reach the bridge: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const active = worlds.find((w) => w.active)
    if (!active) {
      this.showNote('No world chosen yet. Open the <a href="#/worldmap">Map</a>, find a world you like and <b>Save this world</b>: you will walk in it here.', true)
      return
    }
    try {
      const { continent } = await decodeSnapshot(await this.ctx.bridge.worldSnapshot(active.id))
      if (this.disposed) return
      this.useWorld(active, continent)
    } catch (err) {
      this.showNote(`Could not load ${active.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private useWorld(saved: SavedWorld, c: Continent): void {
    this.saved = saved
    this.c = c
    const ground = new Ground(c)
    this.ground = ground
    const towns = layoutTowns(c, ground)
    this.buildings = towns.buildings
    this.townProps = towns.props
    this.feet.clear()
    for (const b of this.buildings) {
      if (!b.foot) continue
      const k = bucket(b.foot.x, b.foot.z)
      for (const dk of [0, 1, -1, 1000, -1000, 1001, -1001, 999, -999]) {
        const list = this.feet.get(k + dk)
        if (list) list.push(b.foot)
        else this.feet.set(k + dk, [b.foot])
      }
    }
    this.rivers = c.rivers.map((r) => {
      const pts = r.points
      const right = pts.map((_, i): [number, number] => {
        const a = pts[Math.max(0, i - 1)]
        const b = pts[Math.min(pts.length - 1, i + 1)]
        const dx = b[0] - a[0]
        const dz = b[1] - a[1]
        const l = Math.hypot(dx, dz) || 1
        return [dz / l, -dx / l]
      })
      return { pts, right, half: r.flow.map(riverHalfWidth), level: pts.map(([x, z]) => ground.base(x, z) - RIVER_DROP) }
    })
    this.buildFar()
    this.player = saved.x !== null && saved.z !== null
      ? { x: saved.x, z: saved.z, heading: saved.heading ?? 0 }
      : spawn(c)
    this.camHeading = this.player.heading
    this.walkedBase = saved.walked_m
    this.lastSave = { ...this.player }
    this.province = -1
    this.showNote(null)
    this.renderMapImage()
    void this.progress.start(saved.id)
  }

  /** The whole island, low detail, a little below the tiles (they cover it near you). */
  private buildFar(): void {
    const c = this.c!
    const g = this.ground!
    const m = 160
    const step = WORLD_M / (m - 1)
    const pos = new Float32Array(m * m * 3)
    const col = new Float32Array(m * m * 3)
    const tmp = new Uint8ClampedArray(4)
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const x = i * step
        const z = j * step
        const cell = cellAt(c, x, z)
        let y = g.base(x, z) - 0.6
        if (c.water[cell] === Water.Lake) y = c.surface[cell] - 0.3
        colorAt(c, x, z, step, tmp, 0)
        const k = j * m + i
        pos.set([x, Math.max(y, -40), z], k * 3)
        col.set([(tmp[0] / 255) ** 2.2, (tmp[1] / 255) ** 2.2, (tmp[2] / 255) ** 2.2], k * 3)
      }
    }
    const index: number[] = []
    for (let j = 0; j < m - 1; j++) for (let i = 0; i < m - 1; i++) {
      const a = j * m + i
      index.push(a, a + m, a + 1, a + 1, a + m, a + m + 1)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setIndex(index)
    geo.computeVertexNormals()
    this.far?.geometry.dispose()
    if (this.far) this.s3.scene.remove(this.far)
    this.far = new THREE.Mesh(geo, this.farMaterial())
    this.far.frustumCulled = false
    this.s3.scene.add(this.far)
  }

  /** The far mesh is cut away where the detailed tiles are (no poking through near rivers). */
  private farMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uHole = this.farHole
      shader.vertexShader = 'varying vec2 vFarXZ;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarXZ = position.xz;')
      shader.fragmentShader = 'uniform vec3 uHole;\nvarying vec2 vFarXZ;\n' + shader.fragmentShader.replace(
        'void main() {', 'void main() {\n  if (distance(vFarXZ, uHole.xy) < uHole.z) discard;')
    }
    m.customProgramCacheKey = () => 'ow-far'
    return m
  }

  // --- frame -----------------------------------------------------------------------------------

  update(distanceM: number, _speedKmh: number, dt: number): void {
    this.fps += ((dt > 0 ? 1 / dt : 60) - this.fps) * 0.05
    CLOCK.value += Math.min(dt, 0.1)
    const hour = hourOfDay(this.timeMode, Date.now(), 9, this.fixedHour)
    const g = this.ground
    if (!g || !this.c) {
      this.s3.camera.position.set(0, 30, 0)
      this.s3.camera.lookAt(100, 30, 100)
      this.s3.atmosphere(hour, { forest: 0, ruins: 0, meadow: 1, fields: 0, falls: 0 }, { x: 0, y: 0, z: 0 }, dt, null)
      this.s3.render()
      return
    }
    const metres = this.lastOdometer === null ? 0 : Math.max(0, distanceM - this.lastOdometer)
    this.lastOdometer = distanceM
    const p = this.player
    if (this.ctx.canEdit()) {
      // Local: the pad walks, the keys steer.
      let turn = 0
      for (const code of this.turn) turn += STEER_KEYS[code] ?? 0
      p.heading = wrap(p.heading + Math.sign(turn) * TURN_RATE * dt)
      const moved = step(p, metres, (x, z) => this.blocked(x, z))
      this.held = moved.held && metres > 0
      p.x = moved.x
      p.z = moved.z
      this.walkedHere += metres
      this.maybeSave(dt)
    } else {
      this.followBridge(dt)
    }

    this.stream()
    // Camera: behind the facing direction, eased; the user's orbit and zoom on top.
    this.camHeading = (dampAngle((this.camHeading * 180) / Math.PI, (p.heading * 180) / Math.PI, dt, 0.35) * Math.PI) / 180
    const v = this.shownView
    v.yaw = clampView({ ...v, yaw: v.yaw + shortestTurn(v.yaw, this.view.yaw) * (1 - Math.exp(-dt / 0.12)) }).yaw
    v.elevation = damp(v.elevation, this.view.elevation, dt, 0.12)
    v.zoom = damp(v.zoom, this.view.zoom, dt, 0.12)
    const gy = this.feetY(p.x, p.z)
    const pose = orbitPose(p.x, p.z, this.camHeading, v)
    const ox = pose.camera.x - p.x
    const oz = pose.camera.z - p.z
    const t = this.clear(p.x, p.z, ox, oz)
    const cx = p.x + ox * t
    const cz = p.z + oz * t
    let camY = Math.max(gy + pose.camera.y * (t < 1 ? Math.max(0.5, t) : 1), g.height(cx, cz) + 1.2)
    // Keep the line of sight to the walker's head over the ground (a hill between them).
    const head = gy + WALKER_M
    for (const f of [0.2, 0.4, 0.6, 0.8]) {
      const ground = g.height(cx + (p.x - cx) * f, cz + (p.z - cz) * f) + 0.6
      const lineY = camY + (head - camY) * f
      if (lineY < ground) camY += (ground - lineY) / (1 - f)
    }
    const cam = this.s3.camera
    cam.position.set(cx, damp(cam.position.y || camY, camY, dt, 0.25), cz)
    cam.lookAt(pose.target.x, gy + pose.target.y, pose.target.z)
    this.placeWalker(gy)

    const w = g.biomes(p.x, p.z)
    this.progress.tick(dt, this.c, p.x, p.z, w)
    const night = this.s3.atmosphere(hour, w, { x: p.x, y: gy, z: p.z }, dt, this.kitReady ? this.kit : null)
    this.fallMat.uniforms.uLight.value = 0.25 + (1 - night) * 0.85
    this.sprayMat.uniforms.uAlpha.value = 0.18 + (1 - night) * 0.25
    this.sea.position.set(p.x, 0, p.z)
    this.farHole.value.set(p.x, p.z, QUALITY[this.quality].viewM - TILE * 0.8)
    for (const tile of this.tiles.values()) for (const s of tile.spinners) s.rotateZ(dt * 0.55)
    this.updateSmallVisibility()
    this.s3.render()
    this.updateHud(w)
  }

  /** Where the walker's feet are: on the ground, or wading in a river. */
  private feetY(x: number, z: number): number {
    const g = this.ground!
    const h = g.height(x, z)
    const water = g.water(x, z, h)
    return water?.kind === 'river' ? Math.max(h, water.level - 0.45) : h
  }

  private blocked(x: number, z: number): boolean {
    if (x < 30 || z < 30 || x > WORLD_M - 30 || z > WORLD_M - 30) return true
    const g = this.ground!
    const h = g.height(x, z)
    const water = g.water(x, z, h)
    if (water && water.kind !== 'river' && water.level - h > 0.35) return true // the sea and lakes
    if (Math.abs(g.height(x + 1, z) - h) > 0.9 || Math.abs(g.height(x, z + 1) - h) > 0.9) return true // cliffs
    const list = this.feet.get(bucket(x, z))
    return list !== undefined && list.some((f) => insideFoot(f, x, z, 0.25))
  }

  /** How far towards the camera offset the camera may go before a building is in the way. */
  private clear(px: number, pz: number, ox: number, oz: number): number {
    for (let i = 1; i <= 16; i++) {
      const t = i / 16
      const x = px + ox * t
      const z = pz + oz * t
      const list = this.feet.get(bucket(x, z))
      if (list?.some((f) => insideFoot(f, x, z, 0.8))) return Math.max(0.15, (i - 1) / 16)
    }
    return 1
  }

  private placeWalker(gy: number): void {
    const p = this.player
    const ref = orbitPose(p.x, p.z, this.camHeading, DEFAULT_VIEW)
    this.refCamera.position.set(ref.camera.x, gy + ref.camera.y, ref.camera.z)
    this.refCamera.lookAt(ref.target.x, gy + ref.target.y, ref.target.z)
    this.refCamera.updateMatrixWorld()
    this.s3.camera.updateMatrixWorld()
    const w = this.root.clientWidth || window.innerWidth
    const h = this.root.clientHeight || window.innerHeight
    const screen = (camera: THREE.Camera, y: number) => {
      const v = new THREE.Vector3(p.x, y, p.z).project(camera)
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, behind: v.z > 1 }
    }
    this.ctx.placeWalker(walkerPlacement(
      screen(this.s3.camera, gy), screen(this.s3.camera, gy + WALKER_M), screen(this.refCamera, gy), screen(this.refCamera, gy + WALKER_M),
    ))
  }

  // --- saving and following ---------------------------------------------------------------------

  private maybeSave(dt: number, force = false): void {
    if (!this.saved || !this.ctx.canEdit()) return
    this.savedAt += dt
    const p = this.player
    const moved = Math.hypot(p.x - this.lastSave.x, p.z - this.lastSave.z) > 3 || Math.abs(p.heading - this.lastSave.heading) > 0.2
    if (!force && (this.savedAt < SAVE_EVERY_S || !moved)) return
    this.savedAt = 0
    this.lastSave = { ...p }
    void this.ctx.bridge.setWorldState(this.saved.id, {
      x: p.x, z: p.z, heading: p.heading, walked_m: this.walkedBase + this.walkedHere,
    }, force).catch(() => { /* next time */ })
  }

  private readonly onPageHide = (): void => this.maybeSave(0, true)

  /** View-only pages: ease towards where the bridge says the walker is. */
  private followBridge(dt: number): void {
    this.pollAt -= dt
    if (this.pollAt <= 0) {
      this.pollAt = 4
      void this.ctx.bridge.worlds().then((ws) => {
        const w = ws.find((x) => x.id === this.saved?.id)
        if (w && w.x !== null && w.z !== null) this.follow = { x: w.x, z: w.z, heading: w.heading ?? 0 }
      }).catch(() => {})
    }
    if (!this.follow) return
    const p = this.player
    const k = 1 - Math.exp(-dt / 1.5)
    p.x += (this.follow.x - p.x) * k
    p.z += (this.follow.z - p.z) * k
    p.heading = wrap(p.heading + shortest(p.heading, this.follow.heading) * k)
  }

  // --- tiles ----------------------------------------------------------------------------------------

  private stream(): void {
    const q = QUALITY[this.quality]
    const radius = q.viewM // beyond it, the low-detail island mesh
    const p = this.player
    const t0x = Math.floor(p.x / TILE)
    const t0z = Math.floor(p.z / TILE)
    const reach = Math.ceil(radius / TILE)
    const wanted = new Map<string, { tx: number; tz: number; level: 0 | 1; d: number }>()
    for (let tz = t0z - reach; tz <= t0z + reach; tz++) {
      for (let tx = t0x - reach; tx <= t0x + reach; tx++) {
        if (tx < 0 || tz < 0 || tx * TILE >= WORLD_M || tz * TILE >= WORLD_M) continue
        const d = Math.hypot((tx + 0.5) * TILE - p.x, (tz + 0.5) * TILE - p.z)
        if (d > radius) continue
        wanted.set(`${tx},${tz}`, { tx, tz, level: d < FINE_M ? 0 : 1, d })
      }
    }
    for (const t of [...this.tiles.values()]) {
      const want = wanted.get(t.key)
      // Hysteresis: a fine tile stays fine a little longer (no flicker at the boundary).
      if (!want || (want.level !== t.level && !(t.level === 0 && want.d < FINE_M + 40))) this.dropTile(t)
    }
    const t0 = performance.now()
    let work = false
    for (const want of [...wanted.values()].sort((a, b) => a.d - b.d)) {
      const have = this.tiles.get(`${want.tx},${want.tz}`)
      if (!have) {
        this.tiles.set(`${want.tx},${want.tz}`, this.buildTile(want.tx, want.tz, want.level))
        work = true
      } else if (have.needsBuildings && want.d < q.buildM * 1.4) {
        this.addBuildings(have, want.tx, want.tz)
        work = true
      }
      if (work) break
    }
    if (work) this.buildMs = Math.max(performance.now() - t0, this.buildMs * 0.98)
  }

  private updateSmallVisibility(): void {
    const near = QUALITY[this.quality].grassM
    const p = this.player
    for (const t of this.tiles.values()) {
      if (!t.small.length) continue
      const [tx, tz] = t.key.split(',').map(Number)
      const d = Math.hypot((tx + 0.5) * TILE - p.x, (tz + 0.5) * TILE - p.z)
      for (const m of t.small) m.visible = d < near + 45
    }
  }

  private buildTile(tx: number, tz: number, level: 0 | 1): Tile {
    const g = this.ground!
    const c = this.c!
    const tile: Tile = {
      key: `${tx},${tz}`, level, group: new THREE.Group(), owned: [], instanced: [], small: [], spinners: [],
      needsBuildings: this.kitReady,
    }
    const add = (obj: THREE.Object3D, geo?: THREE.BufferGeometry) => {
      tile.group.add(obj)
      if (geo) tile.owned.push(geo)
    }
    const x0 = tx * TILE
    const z0 = tz * TILE
    const stepM = level === 0 ? 2 : 8
    const n = TILE / stepM + 1
    // Heights with a one-vertex border, so normals at the tile edge match the neighbour's.
    const hb = new Float32Array((n + 2) * (n + 2))
    for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) hb[(j + 1) * (n + 2) + i + 1] = g.height(x0 + i * stepM, z0 + j * stepM)
    const H = (i: number, j: number) => hb[(j + 1) * (n + 2) + i + 1]
    const skirt = 4 * n
    const count = n * n + skirt
    const pos = new Float32Array(count * 3)
    const nor = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    const road = new Float32Array(count)
    const uv = new Float32Array(count * 2)
    const cl = new THREE.Color()
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        const x = x0 + i * stepM
        const z = z0 + j * stepM
        const h = H(i, j)
        const nx = -(H(i + 1, j) - H(i - 1, j)) / (2 * stepM)
        const nz = -(H(i, j + 1) - H(i, j - 1)) / (2 * stepM)
        const nl = Math.hypot(nx, 1, nz)
        pos.set([x, h, z], k * 3)
        nor.set([nx / nl, 1 / nl, nz / nl], k * 3)
        this.groundColor(x, z, h, 1 / nl, cl)
        col.set([cl.r, cl.g, cl.b], k * 3)
        const r = g.road(x, z)
        road[k] = r.cobble
        uv.set([x / 2.6, z / 2.6], k * 2)
      }
    }
    // Skirts: a strip hanging down along each edge hides cracks next to a coarser tile.
    const edge: number[] = []
    for (let i = 0; i < n; i++) edge.push(i) // south
    for (let i = 0; i < n; i++) edge.push((n - 1) * n + i) // north
    for (let j = 0; j < n; j++) edge.push(j * n) // west
    for (let j = 0; j < n; j++) edge.push(j * n + n - 1) // east
    edge.forEach((src, e) => {
      const k = n * n + e
      pos.set([pos[src * 3], pos[src * 3 + 1] - 3, pos[src * 3 + 2]], k * 3)
      nor.set([nor[src * 3], nor[src * 3 + 1], nor[src * 3 + 2]], k * 3)
      col.set([col[src * 3], col[src * 3 + 1], col[src * 3 + 2]], k * 3)
    })
    const index: number[] = []
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      index.push(a, a + n, a + 1, a + 1, a + n, a + n + 1)
    }
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < n - 1; i++) {
        const a = edge[side * n + i]
        const b = edge[side * n + i + 1]
        const sa = n * n + side * n + i
        const sb = sa + 1
        index.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb) // both windings: seen from either side
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setAttribute('road', new THREE.BufferAttribute(road, 1))
    geo.setAttribute('groundUv', new THREE.BufferAttribute(uv, 2))
    geo.setIndex(index)
    geo.computeBoundingSphere()
    const mesh = new THREE.Mesh(geo, this.groundMat)
    mesh.receiveShadow = QUALITY[this.quality].shadows && level === 0
    add(mesh, geo)

    this.addLakes(tile, x0, z0, add)
    this.addRivers(x0, z0, add)
    for (const f of c.waterfalls) {
      if (f.x >= x0 && f.x < x0 + TILE && f.z >= z0 && f.z < z0 + TILE) this.addWaterfall(f.x, f.z, add)
    }
    this.addPlants(tile, x0, z0, level, add)
    this.s3.scene.add(tile.group)
    return tile
  }

  private groundColor(x: number, z: number, h: number, up: number, out: THREE.Color): void {
    const g = this.ground!
    if (h < 0.6) {
      out.copy(SAND)
      return
    }
    const w = g.biomes(x, z)
    out.setRGB(0, 0, 0)
    for (const b of OW_BIOMES) {
      const base = b === 'fields' ? FIELD_COLORS[fieldAt(this.c!.seed, x, z)].clone().lerp(GROUND.fields, 0.25) : GROUND[b]
      out.r += base.r * w[b]
      out.g += base.g * w[b]
      out.b += base.b * w[b]
    }
    out.lerp(ROCK, Math.min(1, Math.max(0, (h - 330) / 120)) * 0.85)
    out.lerp(ROCK, Math.min(1, Math.max(0, (0.86 - up) / 0.22)))
    out.lerp(SNOW, Math.min(1, Math.max(0, (h - 470) / 60)))
    if (h < 2.5) out.lerp(SAND, (2.5 - h) / 2.5)
    const r = g.road(x, z)
    out.lerp(DIRT, r.onRoad * (1 - r.cobble))
    if (g.rivers.nearest(x, z).edge < 1) out.lerp(BED, 0.6)
  }

  /** Lake water on a 4 m grid, only where the ground is below the lake and next to its cells
   * (a whole-tile plane would hang in the air over the valley below a lake's outlet). */
  private addLakes(_tile: Tile, x0: number, z0: number, add: (o: THREE.Object3D, g?: THREE.BufferGeometry) => void): void {
    const c = this.c!
    const g = this.ground!
    const step = 4
    const n = TILE / step
    const pos: number[] = []
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const xa = x0 + i * step
        const za = z0 + j * step
        const level = lakeNear(c, xa + step / 2, za + step / 2)
        if (level === null) continue
        const corners = [[xa, za], [xa + step, za], [xa, za + step], [xa + step, za + step]]
        if (!corners.some(([x, z]) => g.height(x, z) < level)) continue
        const [p0, p1, p2, p3] = corners
        pos.push(p0[0], level, p0[1], p2[0], level, p2[1], p1[0], level, p1[1], p1[0], level, p1[1], p2[0], level, p2[1], p3[0], level, p3[1])
      }
    }
    if (!pos.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const uv = new Float32Array((pos.length / 3) * 2)
    for (let k = 0; k < pos.length / 3; k++) uv.set([pos[k * 3] * 0.15, pos[k * 3 + 2] * 0.15], k * 2)
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.computeVertexNormals()
    add(new THREE.Mesh(geo, this.waterMat), geo)
  }

  /** River ribbons: the stretches of every river whose points fall in this tile (plus one). */
  private addRivers(x0: number, z0: number, add: (o: THREE.Object3D, g?: THREE.BufferGeometry) => void): void {
    const pos: number[] = []
    const uv: number[] = []
    const index: number[] = []
    const inside = (x: number, z: number) => x >= x0 - 1 && x < x0 + TILE + 1 && z >= z0 - 1 && z < z0 + TILE + 1
    for (const r of this.rivers) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = r.pts[i]
        const [bx, bz] = r.pts[i + 1]
        if (!inside((ax + bx) / 2, (az + bz) / 2)) continue
        const base = pos.length / 3
        for (const k of [i, i + 1]) {
          const [x, z] = r.pts[k]
          const [rx, rz] = r.right[k]
          const hw = r.half[k] + 0.6
          pos.push(x - rx * hw, r.level[k], z - rz * hw, x + rx * hw, r.level[k], z + rz * hw)
          uv.push(x * 0.15, z * 0.15, x * 0.15 + 0.3, z * 0.15)
        }
        index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
      }
    }
    if (!index.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setIndex(index)
    geo.computeVertexNormals()
    add(new THREE.Mesh(geo, this.waterMat), geo)
  }

  /** A waterfall over the steep stretch of its river, with spray where it lands. */
  private addWaterfall(x: number, z: number, add: (o: THREE.Object3D, g?: THREE.BufferGeometry) => void): void {
    let best: { r: RiverLine; i: number; d: number } | null = null
    for (const r of this.rivers) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const d = Math.hypot(r.pts[i][0] - x, r.pts[i][1] - z)
        if (!best || d < best.d) best = { r, i, d }
      }
    }
    if (!best || best.d > 40) return
    const { r } = best
    const a = Math.max(0, best.i - 2)
    const b = Math.min(r.pts.length - 1, best.i + 3)
    const pos: number[] = []
    const uv: number[] = []
    const index: number[] = []
    for (let k = a; k <= b; k++) {
      const [px, pz] = r.pts[k]
      const [rx, rz] = r.right[k]
      const hw = r.half[k] + 0.8
      const y = r.level[k] + 0.25
      pos.push(px - rx * hw, y, pz - rz * hw, px + rx * hw, y, pz + rz * hw)
      const t = (k - a) / Math.max(1, b - a)
      uv.push(0, t, 1, t)
      if (k < b) {
        const o = (k - a) * 2
        index.push(o, o + 2, o + 1, o + 1, o + 2, o + 3)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setIndex(index)
    add(new THREE.Mesh(geo, this.fallMat), geo)
    const [fx, fz] = r.pts[b]
    const n = 40
    const sp = new Float32Array(n * 3)
    const seeds = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      sp.set([fx + (Math.random() - 0.5) * r.half[b] * 2.5, r.level[b] + Math.random() * 3, fz + (Math.random() - 0.5) * r.half[b] * 2.5], i * 3)
      seeds[i] = Math.random()
    }
    const spray = new THREE.BufferGeometry()
    spray.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    spray.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
    add(new THREE.Points(spray, this.sprayMat), spray)
  }

  private addPlants(tile: Tile, x0: number, z0: number, level: 0 | 1, add: (o: THREE.Object3D) => void): void {
    const q = QUALITY[this.quality]
    const g = this.ground!
    let plants = plantTile(g, this.c!.seed, x0, z0, TILE, q.density, level === 0 ? q.density * 0.45 : 0,
      (x, z) => (this.feet.get(bucket(x, z)) ?? []).some((f) => insideFoot(f, x, z, 1.2)))
    // Far tiles: only what reads at a distance (trees and rocks), a few draw calls each.
    if (level === 1) plants = plants.filter((p) => FAR_KINDS.has(p.kind))
    for (const tp of level === 0 ? this.townProps : []) {
      if (tp.x >= x0 && tp.x < x0 + TILE && tp.z >= z0 && tp.z < z0 + TILE) plants.push({ ...tp, scale: 1 })
    }
    const byKind = new Map<string, typeof plants>()
    for (const p of plants) {
      const list = byKind.get(p.kind)
      if (list) list.push(p)
      else byKind.set(p.kind, [p])
    }
    const m = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const white = new THREE.Color(1, 1, 1)
    for (const [kind, list] of byKind) {
      const small = SMALL_PLANTS.includes(kind as never)
      for (const part of this.props.parts[kind as keyof PropLibrary['parts']]) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length)
        list.forEach((p, i) => {
          quat.setFromAxisAngle(up, FACES_PATH.includes(kind as never) ? p.rotation : p.rotation)
          m.compose(new THREE.Vector3(p.x, g.height(p.x, p.z) - 0.05, p.z), quat, PropLibrary.size(kind as never, p.scale, p.tint))
          mesh.setMatrixAt(i, m)
          const tint = PropLibrary.color(kind as never, p.tint)
          mesh.setColorAt(i, part.tinted ? tint : white.clone().multiplyScalar(tint.r))
        })
        mesh.castShadow = part.shadow && q.shadows && level === 0
        mesh.computeBoundingSphere()
        add(mesh)
        tile.instanced.push(mesh)
        if (small) tile.small.push(mesh)
      }
    }
  }

  /** Buildings anchored in this tile, baked into one mesh per material (a frame after the tile). */
  private addBuildings(tile: Tile, tx: number, tz: number): void {
    tile.needsBuildings = false
    const g = this.ground!
    const x0 = tx * TILE
    const z0 = tz * TILE
    const items: { model: string; matrix: THREE.Matrix4 }[] = []
    const anchor = new THREE.Matrix4()
    const local = new THREE.Matrix4()
    const shadows = QUALITY[this.quality].shadows
    for (const b of this.buildings) {
      if (b.x < x0 || b.x >= x0 + TILE || b.z < z0 || b.z >= z0 + TILE) continue
      anchor.makeRotationY(b.yaw).setPosition(b.x, g.height(b.x, b.z), b.z)
      for (const piece of b.pieces) {
        if (!this.kit.has(piece.model)) continue
        local.makeRotationY(piece.ry).setPosition(piece.x, piece.y, piece.z)
        items.push({ model: piece.model, matrix: anchor.clone().multiply(local) })
      }
      if (b.kind === 'windmill') {
        const hub = new THREE.Group()
        anchor.clone().multiply(local.makeTranslation(0, 8.3, 3.25)).decompose(hub.position, hub.quaternion, hub.scale)
        const spin = new THREE.Group()
        hub.add(spin)
        for (const part of this.blades) {
          const mesh = new THREE.Mesh(part.geometry, this.kit.materials[part.mat])
          mesh.castShadow = shadows
          spin.add(mesh)
        }
        spin.rotation.z = b.x % 6
        tile.group.add(hub)
        tile.spinners.push(spin)
      }
    }
    for (const [mat, geometry] of bake(this.kit, items)) {
      const mesh = new THREE.Mesh(geometry, this.kit.materials[mat])
      mesh.castShadow = shadows && mat !== 'glass' && mat !== 'glassDark'
      mesh.receiveShadow = shadows
      tile.group.add(mesh)
      tile.owned.push(geometry)
    }
  }

  private dropTile(t: Tile): void {
    this.s3.scene.remove(t.group)
    for (const g of t.owned) g.dispose()
    for (const m of t.instanced) m.dispose()
    this.tiles.delete(t.key)
  }

  // --- HUD ------------------------------------------------------------------------------------------

  private buildCompass(): void {
    const strip = this.compass.querySelector('.ow-strip')!
    const marks: string[] = []
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }
    for (let d = -360; d <= 720; d += 15) {
      const deg = ((d % 360) + 360) % 360
      const label = names[deg] ?? '·'
      marks.push(`<span style="left:${(d + 360) * 4}px" class="${names[deg] ? 'big' : ''}">${label}</span>`)
    }
    strip.innerHTML = marks.join('')
  }

  private updateHud(w: Record<string, number>): void {
    const p = this.player
    const deg = ((p.heading * 180) / Math.PI + 360) % 360
    const strip = this.compass.querySelector<HTMLElement>('.ow-strip')!
    strip.style.transform = `translateX(${-(deg + 360) * 4 + this.compass.clientWidth / 2}px)`
    const c = this.c!
    const prov = c.province[cellAt(c, p.x, p.z)]
    const province = prov >= 0 ? c.provinces[prov]?.name : null
    if (prov >= 0 && prov !== this.province) {
      if (this.province !== -1 || this.walkedHere > 0) this.showBanner(province!)
      this.province = prov
    }
    let near: string | null = null
    let nearD = 350
    for (const pl of c.places) {
      const d = Math.hypot(pl.x - p.x, pl.z - p.z)
      if (d < nearD) {
        nearD = d
        near = pl.name
      }
    }
    const biome = OW_BIOMES.reduce((a, b) => (w[b] > w[a] ? b : a))
    this.where.textContent = [province, near ? (nearD < 120 ? near : `near ${near}`) : null, OW_BIOME_NAMES[biome], this.held ? 'blocked: turn A / D' : null]
      .filter(Boolean).join(' · ')
    this.miniAt -= 1
    if (this.miniAt <= 0) {
      this.miniAt = 10
      this.drawMinimap()
    }
    if (this.debug) {
      const info = this.s3.renderer.info.render
      this.debugEl.textContent = [
        `${this.saved?.name} · seed ${c.seed}`,
        `x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  heading ${deg.toFixed(0)}°  ground ${this.ground!.height(p.x, p.z).toFixed(1)} m`,
        `biome ${OW_BIOMES.filter((b) => w[b] > 0.02).map((b) => `${b} ${(w[b] * 100).toFixed(0)}%`).join(', ')}`,
        `walked here ${(this.walkedHere / 1000).toFixed(2)} km · total ${((this.walkedBase + this.walkedHere) / 1000).toFixed(2)} km`,
        `fps ${this.fps.toFixed(0)}  ·  draw calls ${info.calls}  ·  triangles ${info.triangles}`,
        `tiles ${this.tiles.size} (build ≤ ${this.buildMs.toFixed(1)} ms)  ·  quality ${this.quality}  ·  kit ${this.kitReady ? 'ready' : 'loading'}`,
      ].join('\n')
    }
  }

  private showBanner(text: string): void {
    this.banner.textContent = text
    this.banner.hidden = false
    this.banner.classList.remove('fade')
    void this.banner.offsetWidth
    this.banner.classList.add('fade')
    if (this.bannerTimer) clearTimeout(this.bannerTimer)
    this.bannerTimer = setTimeout(() => { this.banner.hidden = true }, 4500)
  }

  /** The world map once, small, for the minimap (in slices, not to stall a frame). */
  private renderMapImage(): void {
    const c = this.c!
    const size = 320
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(size, size)
    const mpp = WORLD_M / size
    let row = 0
    const slice = () => {
      if (this.disposed || this.c !== c) return
      const end = Math.min(size, row + 24)
      for (; row < end; row++) {
        for (let px = 0; px < size; px++) colorAt(c, (px + 0.5) * mpp, WORLD_M - (row + 0.5) * mpp, mpp, img.data, (row * size + px) * 4)
      }
      if (row < size) {
        setTimeout(slice, 0)
        return
      }
      ctx.putImageData(img, 0, 0)
      ctx.lineCap = 'round'
      ctx.strokeStyle = '#2f78b4'
      for (const r of c.rivers) {
        ctx.lineWidth = 1
        ctx.beginPath()
        r.points.forEach(([x, z], i) => (i ? ctx.lineTo(x / mpp, (WORLD_M - z) / mpp) : ctx.moveTo(x / mpp, (WORLD_M - z) / mpp)))
        ctx.stroke()
      }
      ctx.strokeStyle = '#7b5733'
      ctx.lineWidth = 1.4
      for (const r of c.roads) {
        ctx.beginPath()
        r.points.forEach(([x, z], i) => (i ? ctx.lineTo(x / mpp, (WORLD_M - z) / mpp) : ctx.moveTo(x / mpp, (WORLD_M - z) / mpp)))
        ctx.stroke()
      }
      this.mapImage = canvas
    }
    slice()
  }

  /** North-up minimap, about 2 km across, centred on the walker. */
  private drawMinimap(): void {
    const ctx = this.minimap.getContext('2d')!
    const S = this.minimap.width
    ctx.clearRect(0, 0, S, S)
    if (!this.mapImage) return
    const p = this.player
    const span = 2000
    const mpp = WORLD_M / this.mapImage.width
    const sx = (p.x - span / 2) / mpp
    const sy = (WORLD_M - p.z - span / 2) / mpp
    ctx.save()
    ctx.beginPath()
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = '#1c3d63'
    ctx.fillRect(0, 0, S, S)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.mapImage, sx, sy, span / mpp, span / mpp, 0, 0, S, S)
    const scale = S / span
    for (const pl of this.c!.places) {
      const dx = (pl.x - p.x) * scale + S / 2
      const dy = -(pl.z - p.z) * scale + S / 2
      if (dx < 0 || dy < 0 || dx > S || dy > S) continue
      ctx.fillStyle = pl.kind === 'castle' ? '#5a2d5c' : pl.kind === 'waterfall' ? '#1f5f9a' : '#2b2017'
      ctx.fillRect(dx - 2, dy - 2, pl.kind === 'city' ? 6 : 4, pl.kind === 'city' ? 6 : 4)
    }
    ctx.restore()
    // The walker: an arrow pointing where she faces.
    ctx.save()
    ctx.translate(S / 2, S / 2)
    ctx.rotate(p.heading)
    ctx.fillStyle = '#ff5a5a'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(0, -9)
    ctx.lineTo(6, 7)
    ctx.lineTo(0, 3)
    ctx.lineTo(-6, 7)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
    ctx.strokeStyle = 'rgb(255 255 255 / 0.5)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 12px system-ui'
    ctx.fillText('N', S / 2 - 4, 14)
  }

  // --- toolbar and input -----------------------------------------------------------------------------

  private buildToolbar(): void {
    const bar = document.createElement('div')
    bar.className = 'fantasy-toolbar'
    bar.innerHTML = `
      <span class="fantasy-trail ow-name"></span>
      <label>quality <select class="fq"><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select></label>
      <label>time <select class="ft"><option value="cycle">day cycle</option><option value="real">real time</option><option value="fixed">fixed time</option></select>
        <input type="time" class="fclock" step="300" aria-label="time of day"></label>
      <span class="fantasy-hint muted">A / D: turn · drag: look · wheel: zoom</span>
      <button type="button" class="ow-map">Map (M)</button>`
    const fq = bar.querySelector<HTMLSelectElement>('.fq')!
    const ft = bar.querySelector<HTMLSelectElement>('.ft')!
    const clock = bar.querySelector<HTMLInputElement>('.fclock')!
    fq.value = this.quality
    ft.value = this.timeMode
    clock.value = formatClock(this.fixedHour)
    clock.hidden = this.timeMode !== 'fixed'
    fq.onchange = () => {
      this.quality = fq.value as Quality
      writeKey(KEYS.quality, this.quality)
      this.s3.quality = this.quality
      this.s3.makeRenderer()
      this.fit()
      for (const t of [...this.tiles.values()]) this.dropTile(t)
    }
    ft.onchange = () => {
      this.timeMode = isTimeMode(ft.value) ? ft.value : 'cycle'
      writeKey(KEYS.time, this.timeMode)
      clock.hidden = this.timeMode !== 'fixed'
    }
    clock.oninput = () => {
      const hour = parseClock(clock.value)
      if (hour === null) return
      this.fixedHour = hour
      writeKey(KEYS.clock, formatClock(hour))
    }
    bar.querySelector<HTMLButtonElement>('.ow-map')!.onclick = () => { location.hash = '#/worldmap' }
    this.root.append(bar)
    const name = setInterval(() => {
      if (this.disposed) clearInterval(name)
      else if (this.saved) {
        bar.querySelector('.ow-name')!.textContent = `★ ${this.saved.name}`
        clearInterval(name)
      }
    }, 500)
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.code in STEER_KEYS) this.turn.add(e.code)
    else if (e.code === 'KeyM' && !this.ctx.obs) location.hash = '#/worldmap'
    else if (e.code === 'Backquote') {
      this.debug = !this.debug
      this.debugEl.hidden = !this.debug
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.turn.delete(e.code)
  }

  private readonly onBlur = (): void => this.turn.clear()

  private setView(v: OrbitView): void {
    this.view = clampView(v)
    writeKey(KEYS.view, JSON.stringify(this.view))
  }

  private listenForCamera(): void {
    const root = this.root
    const fromUi = (e: Event) => e.target instanceof Element && e.target.closest('.fantasy-toolbar, .fantasy-debug, .ow-note') !== null
    root.addEventListener('pointerdown', (e) => {
      if (fromUi(e) || (e.pointerType === 'mouse' && e.button !== 0)) return
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      root.setPointerCapture(e.pointerId)
      if (this.pointers.size === 2) this.pinch = pinchDistance(this.pointers)
    })
    root.addEventListener('pointermove', (e) => {
      const last = this.pointers.get(e.pointerId)
      if (!last) return
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.pointers.size === 1) this.setView({ ...this.view, yaw: this.view.yaw - dx * 0.35, elevation: this.view.elevation + dy * 0.25 })
      else if (this.pointers.size === 2) {
        const d = pinchDistance(this.pointers)
        if (this.pinch > 0 && d > 0) this.setView({ ...this.view, zoom: this.view.zoom * (this.pinch / d) })
        this.pinch = d
      }
    })
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId)
      this.pinch = this.pointers.size === 2 ? pinchDistance(this.pointers) : 0
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
  }

  dispose(): void {
    this.maybeSave(0, true)
    this.disposed = true
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('pagehide', this.onPageHide)
    this.resize.disconnect()
    for (const t of [...this.tiles.values()]) this.dropTile(t)
    this.far?.geometry.dispose()
    this.sea.geometry.dispose()
    this.props.dispose()
    this.kit.dispose()
    for (const part of this.blades) part.geometry.dispose()
    for (const t of this.textures) t.dispose()
    this.groundMat.dispose()
    this.waterMat.dispose()
    this.fallMat.dispose()
    this.sprayMat.dispose()
    this.s3.dispose()
    this.root.remove()
  }
}

/** A new world: start in the first city, facing along its first road. */
export function spawn(c: Continent): { x: number; z: number; heading: number } {
  const start = c.places.find((p) => p.kind === 'city') ?? c.places.find((p) => p.kind === 'village') ?? c.places[0]
  if (!start) return { x: WORLD_M / 2, z: WORLD_M / 2, heading: 0 }
  const road = c.roads.find((r) => r.from === start.id || r.to === start.id)
  if (!road) return { x: start.x, z: start.z, heading: 0 }
  const pts = road.from === start.id ? road.points : [...road.points].reverse()
  const next = pts[Math.min(pts.length - 1, 3)]
  return { x: start.x, z: start.z, heading: Math.atan2(next[0] - start.x, next[1] - start.z) }
}

function bucket(x: number, z: number): number {
  return Math.floor(z / 32) * 1000 + Math.floor(x / 32)
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

function shortest(from: number, to: number): number {
  return wrap(to - from)
}

function shortestTurn(from: number, to: number): number {
  return ((((to - from + 180) % 360) + 360) % 360) - 180
}

function pinchDistance(pointers: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...pointers.values()]
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
}

function loadView(): OrbitView {
  try {
    const v = JSON.parse(readKey(KEYS.view) ?? 'null') as OrbitView | null
    if (v && [v.yaw, v.elevation, v.zoom].every(Number.isFinite)) return clampView(v)
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_VIEW }
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

/** The level of a lake at (x, z) or in a cell next to it, else null. */
function lakeNear(c: Continent, x: number, z: number): number | null {
  const cell = cellAt(c, x, z)
  if (c.water[cell] === Water.Lake) return c.surface[cell]
  const n = c.n
  for (const d of [-1, 1, -n, n]) {
    const k = cell + d
    if (k >= 0 && k < n * n && c.water[k] === Water.Lake) return c.surface[k]
  }
  return null
}
