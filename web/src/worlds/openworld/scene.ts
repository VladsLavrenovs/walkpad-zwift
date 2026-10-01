/**
 * The open world's renderer and atmosphere: sky dome (sun, moon, stars, clouds), image-based
 * light from the sky, fog by biome, sun and moon, bloom on high quality, fireflies at night.
 * Adapted from the fantasy trail world (its own copy, so the two can evolve separately).
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import type { Kit } from '../fantasy/assets'
import { QUALITY, type Quality, nightness, sunHeight } from '../fantasy/gen'
import { SkyDome, glowPointsMaterial } from '../fantasy/shaders'
import type { OwWeights } from './continent'

const color = (hex: string) => new THREE.Color(hex)
const SKY = {
  dayZenith: color('#3a6fb5'), dayHorizon: color('#bdd5e8'),
  duskZenith: color('#2f3f70'), duskHorizon: color('#f2a26c'),
  nightZenith: color('#03060f'), nightHorizon: color('#121a2e'),
  mist: color('#a9bbbd'), forest: color('#5f7262'),
}
const FOG: OwWeights = { forest: 0.0065, ruins: 0.0065, meadow: 0.0028, fields: 0.0025, falls: 0.0032 }

export class Scene3d {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000)
  renderer!: THREE.WebGLRenderer
  private composer: EffectComposer | null = null
  private bloom: UnrealBloomPass | null = null
  private readonly hemi = new THREE.HemisphereLight('#bcd7ff', '#4a3f2c', 0.6)
  readonly sun = new THREE.DirectionalLight('#fff1d6', 2.6)
  private readonly moon = new THREE.DirectionalLight('#9fb4ff', 0)
  private readonly fog = new THREE.FogExp2('#bdd5e8', 0.004)
  readonly sky = new SkyDome(3000)
  private readonly envScene = new THREE.Scene()
  private pmrem: THREE.PMREMGenerator | null = null
  private envTarget: THREE.WebGLRenderTarget | null = null
  private envAge = Number.POSITIVE_INFINITY
  private readonly fireflies: THREE.Points
  private readonly root: HTMLElement
  quality: Quality

  constructor(root: HTMLElement, quality: Quality) {
    this.root = root
    this.quality = quality
    this.scene.fog = this.fog
    this.scene.add(this.sky.mesh, this.hemi, this.sun, this.sun.target, this.moon, this.moon.target)
    this.envScene.add(new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material))
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
    this.makeRenderer()
  }

  makeRenderer(): void {
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
      cam.left = cam.bottom = -55
      cam.right = cam.top = 55
      cam.near = 1
      cam.far = 500
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

  fit(): void {
    const w = this.root.clientWidth || window.innerWidth
    const h = this.root.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.composer?.setPixelRatio(this.renderer.getPixelRatio())
    this.composer?.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    ;(this.fireflies.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = this.renderer.getPixelRatio()
  }

  /** Sky, fog, lights for this hour and biome mix around `here` (ground height `y`). */
  atmosphere(hour: number, w: OwWeights, here: { x: number; y: number; z: number }, dt: number, kit: Kit | null): number {
    const night = nightness(hour)
    const day = 1 - night
    const sunUp = sunHeight(hour)
    const dusk = Math.max(0, 1 - Math.abs(sunUp) / 0.3)
    const u = this.sky.uniforms
    u.uZenith.value.copy(SKY.dayZenith).lerp(SKY.duskZenith, dusk * 0.7).lerp(SKY.nightZenith, night)
    u.uHorizon.value.copy(SKY.dayHorizon).lerp(SKY.duskHorizon, dusk * 0.85).lerp(SKY.nightHorizon, night)
    u.uHorizon.value.lerp(SKY.mist, w.ruins * 0.35 * day).lerp(SKY.forest, w.forest * 0.45 * day)
    u.uNight.value = night
    u.uCloud.value = Math.min(0.9, 0.38 + w.ruins * 0.15 + w.falls * 0.1)
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
    for (const b of Object.keys(FOG) as (keyof OwWeights)[]) density += FOG[b] * w[b]
    this.fog.density = density * (1 + night * 0.2)

    this.sun.color.copy(u.uSunColor.value)
    this.sun.intensity = Math.max(0, sunUp) * 2.9 * (1 - w.forest * 0.35) + dusk * 0.4 * day
    this.hemi.color.copy(u.uZenith.value).lerp(color('#ffffff'), 0.45)
    this.hemi.groundColor.set('#4a3f2c').lerp(color('#10121a'), night)
    this.hemi.intensity = 0.25 + day * 0.45 * (1 - w.forest * 0.3)
    this.moon.intensity = night * 0.45
    const lightDir = sunDir.y > 0.08 ? sunDir : new THREE.Vector3(sunDir.x, 0.08, sunDir.z).normalize()
    // The shadow box follows the walker, snapped to whole metres (no shimmering edges).
    const sx = Math.round(here.x)
    const sz = Math.round(here.z)
    this.sun.position.set(sx + lightDir.x * 200, here.y + lightDir.y * 200, sz + lightDir.z * 200)
    this.sun.target.position.set(sx, here.y, sz)
    this.moon.position.set(sx + u.uMoonDir.value.x * 200, here.y + u.uMoonDir.value.y * 200, sz + u.uMoonDir.value.z * 200)
    this.moon.target.position.set(sx, here.y, sz)
    kit?.setNight(night)
    const ff = this.fireflies.material as THREE.ShaderMaterial
    ff.uniforms.uCenter.value.copy(this.camera.position)
    ff.uniforms.uAlpha.value = night * Math.min(1, w.forest + w.meadow + w.falls + w.fields + w.ruins * 0.6)
    this.fireflies.visible = ff.uniforms.uAlpha.value > 0.01
    this.fireflies.position.y = here.y
    if (this.bloom) this.bloom.strength = 0.25 + night * 0.4
    this.envAge += dt
    if (this.envAge > 3 && this.pmrem) {
      this.envAge = 0
      const old = this.envTarget
      this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000)
      this.scene.environment = this.envTarget.texture
      old?.dispose()
    }
    this.scene.environmentIntensity = 0.35 + day * 0.35
    return night
  }

  render(): void {
    this.renderer.info.reset()
    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.sky.dispose()
    this.fireflies.geometry.dispose()
    ;(this.fireflies.material as THREE.Material).dispose()
    this.envTarget?.dispose()
    this.pmrem?.dispose()
    this.composer?.dispose()
    this.renderer.dispose()
  }
}
