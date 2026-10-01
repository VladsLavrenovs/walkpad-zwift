/**
 * "Real world" world: Google Photorealistic 3D Tiles in CesiumJS, following the active route.
 *
 * Cost rules (CLAUDE.md + the bridge's cost guard):
 * - Listed only when VITE_WORLD_MODE=real (dev default is the placeholder world).
 * - Nothing is requested from Google without a key, without an active route, or before the
 *   bridge granted a session (POST /tiles3d/session, counted per day/month). Refused: the app
 *   falls back to the placeholder world with the bridge's message.
 * - Cesium itself is loaded only then (a separate, large chunk).
 *
 * Camera: the walker is at the distance along the route (interpolated every frame by the app);
 * the heading looks LOOK_AHEAD_M ahead so corners become curves; a damped chase camera sits
 * ~25 m behind and ~15 m above, never below the 3D tiles under it. Google's attribution is
 * shown on screen (Cesium's credit display, moved to the top left so overlays do not hide it).
 */

import type { Polyline } from '../routes/geo'
import { HEIGHT_TAU_S, cameraUp, chaseOffset, damp, dampAngle, lookAheadHeading } from './chase'
import type { World, WorldContext } from './world'

type CesiumModule = typeof import('cesium')
type Viewer = import('cesium').Viewer

const SAMPLE_EVERY_S = 0.3
const TARGET_ABOVE_GROUND_M = 1.5 // aim at the walker's chest, not the ground

export class RealWorld implements World {
  readonly showsWalker = true
  private ctx!: WorldContext
  private root!: HTMLDivElement
  private note!: HTMLDivElement
  private Cesium: CesiumModule | null = null
  private viewer: Viewer | null = null
  private state: 'waiting' | 'starting' | 'ready' | 'stopped' = 'waiting'
  private line: Polyline | null = null
  private heading = 0
  private walkerGround = 0
  private cameraGround = 0
  private sinceSample = 0
  private disposed = false

  init(container: HTMLElement, ctx: WorldContext): void {
    this.ctx = ctx
    this.root = document.createElement('div')
    this.root.className = 'real-world'
    this.root.innerHTML = '<div class="real-cesium"></div><div class="real-note"></div>'
    this.note = this.root.querySelector('.real-note')!
    container.append(this.root)
    if (!import.meta.env.VITE_GOOGLE_MAPS_API_KEY) {
      this.state = 'stopped'
      this.showNote('No Google Maps key: set VITE_GOOGLE_MAPS_API_KEY in web/.env and rebuild.')
      return
    }
    this.showNote('Waiting for an active map route (choose one on the Routes page; fantasy trails have no map).')
  }

  update(distanceM: number, _speedKmh: number, dt: number): void {
    if (this.state === 'waiting') {
      // Start only once there is a route to follow: no route, no Google session.
      if (this.ctx.route()) void this.start()
      return
    }
    if (this.state !== 'ready' || !this.viewer || !this.Cesium) return
    const line = this.ctx.route()
    if (!line) return
    this.follow(line, distanceM, dt)
  }

  private async start(): Promise<void> {
    this.state = 'starting'
    this.showNote('Asking the bridge for a 3D session…')
    const grant = await this.ctx.bridge.request3dSession().catch((err) => ({
      granted: false, message: `3D world unavailable: ${String(err)}`, usage: null,
    }))
    if (this.disposed) return
    if (!grant.granted) {
      this.state = 'stopped'
      this.ctx.fallback(grant.message)
      return
    }
    this.showNote('Loading the 3D world…')
    try {
      ;(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = __CESIUM_BASE_URL__
      const Cesium = await import('cesium')
      await import('cesium/Build/Cesium/Widgets/widgets.css')
      if (this.disposed) return
      this.Cesium = Cesium
      const viewer = new Cesium.Viewer(this.root.querySelector<HTMLElement>('.real-cesium')!, {
        globe: false, // the 3D tiles bring their own ground
        baseLayer: false,
        animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
        selectionIndicator: false, requestRenderMode: false,
      })
      this.viewer = viewer
      viewer.scene.screenSpaceCameraController.enableInputs = false // the route drives the camera
      const tileset = await Cesium.createGooglePhotorealistic3DTileset(
        { key: import.meta.env.VITE_GOOGLE_MAPS_API_KEY },
        { showCreditsOnScreen: true },
      )
      if (this.disposed) return
      viewer.scene.primitives.add(tileset)
      // Real ground height at the start before the first frame, so the camera starts right.
      const line = this.ctx.route()!
      this.line = line
      const start = line.at(0).point
      this.heading = lookAheadHeading(line, 0)
      this.placeCamera(start, this.heading, 0, 0)
      const [ground] = await viewer.scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(start[1], start[0])])
      this.walkerGround = this.cameraGround = ground?.height ?? 0
      this.state = 'ready'
      this.showNote(null)
    } catch (err) {
      this.state = 'stopped'
      this.ctx.fallback(`3D world failed to load: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private follow(line: Polyline, distance: number, dt: number): void {
    const Cesium = this.Cesium!
    const scene = this.viewer!.scene
    const { point } = line.at(distance)
    const heading = lookAheadHeading(line, distance)
    if (line !== this.line) {
      // A different route: snap instead of swinging across the map.
      this.line = line
      this.heading = heading
    } else {
      this.heading = dampAngle(this.heading, heading, dt)
    }

    this.sinceSample += dt
    if (this.sinceSample >= SAMPLE_EVERY_S && scene.sampleHeightSupported) {
      const walker = scene.sampleHeight(Cesium.Cartographic.fromDegrees(point[1], point[0]))
      const off = chaseOffset(this.heading)
      const behind = offsetLatLon(point, off.east, off.north)
      const under = scene.sampleHeight(Cesium.Cartographic.fromDegrees(behind[1], behind[0]))
      if (walker !== undefined) this.walkerTarget = walker
      if (under !== undefined) this.cameraTarget = under
      this.sinceSample = 0
    }
    this.walkerGround = damp(this.walkerGround, this.walkerTarget ?? this.walkerGround, dt, HEIGHT_TAU_S)
    this.cameraGround = damp(this.cameraGround, this.cameraTarget ?? this.cameraGround, dt, HEIGHT_TAU_S)
    this.placeCamera(point, this.heading, this.walkerGround, this.cameraGround)
  }

  private walkerTarget: number | null = null
  private cameraTarget: number | null = null

  private placeCamera(point: [number, number], heading: number, walkerGround: number, cameraGround: number): void {
    const Cesium = this.Cesium!
    const target = Cesium.Cartesian3.fromDegrees(point[1], point[0], walkerGround + TARGET_ABOVE_GROUND_M)
    const off = chaseOffset(heading, undefined, cameraUp(walkerGround, cameraGround))
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(target)
    const position = Cesium.Matrix4.multiplyByPoint(
      enu, new Cesium.Cartesian3(off.east, off.north, off.up - TARGET_ABOVE_GROUND_M), new Cesium.Cartesian3(),
    )
    const direction = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(target, position, new Cesium.Cartesian3()), new Cesium.Cartesian3(),
    )
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cesium.Cartesian3())
    this.viewer!.camera.setView({ destination: position, orientation: { direction, up } })
  }

  private showNote(text: string | null): void {
    this.note.hidden = text === null
    this.note.textContent = text ?? ''
  }

  dispose(): void {
    this.disposed = true
    this.viewer?.destroy()
    this.viewer = null
    this.root.remove()
  }
}

/** A point `east`/`north` metres from `p` (small distances). */
function offsetLatLon(p: [number, number], east: number, north: number): [number, number] {
  const lat = p[0] + north / 111_320
  const lon = p[1] + east / (111_320 * Math.cos((p[0] * Math.PI) / 180))
  return [lat, lon]
}
