/**
 * Shader bits for the fantasy world: wind sway for plants, the sky dome (gradient, sun, moon,
 * stars, drifting clouds), the textured ground with cobbled roads, water ripples, waterfalls and
 * glowing particles (fireflies, waterfall spray). All share one clock, `CLOCK`.
 */

import * as THREE from 'three'

/** Seconds since the world started; the world advances it every frame. */
export const CLOCK = { value: 0 }

/** Make a material sway in the wind: more towards the top (`height` metres), `amp` metres. */
export function addWind<T extends THREE.Material>(material: T, amp: number, height: number): T {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = CLOCK
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        float hgt = clamp(position.y / ${height.toFixed(3)}, 0.0, 1.6);
        #ifdef USE_INSTANCING
          vec3 base = instanceMatrix[3].xyz;
        #else
          vec3 base = vec3(0.0);
        #endif
        float ph = base.x * 0.21 + base.z * 0.17;
        float gust = sin(uTime * 0.45 + base.x * 0.025 + base.z * 0.018) * 0.5 + 0.5;
        float sway = (sin(uTime * 1.8 + ph) * 0.65 + sin(uTime * 3.1 + ph * 1.7) * 0.25) * (0.35 + gust);
        transformed.x += sway * ${amp.toFixed(3)} * hgt * hgt;
        transformed.z += sway * ${(amp * 0.6).toFixed(3)} * hgt * hgt;
      }`)
  }
  material.customProgramCacheKey = () => `wind-${amp}-${height}`
  return material
}

/** Tileable value-noise texture (grey, linear), for ground detail and water. */
export function noiseTexture(size = 256, period = 8, seed = 7): THREE.DataTexture {
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const value = (x: number, y: number, p: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = x - xi
    const fy = y - yi
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const c = (dx: number, dy: number) => hash((xi + dx) % p, (yi + dy) % p)
    const a = c(0, 0) + (c(1, 0) - c(0, 0)) * sx
    const b = c(0, 1) + (c(1, 1) - c(0, 1)) * sx
    return a + (b - a) * sy
  }
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      let amp = 0.5
      let p = period
      for (let o = 0; o < 4; o++) {
        v += amp * value((x / size) * p, (y / size) * p, p)
        amp *= 0.5
        p *= 2
      }
      const g = Math.round(Math.min(1, v / 0.9375) * 255)
      data.set([g, g, g, 255], (y * size + x) * 4)
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

/** A ripple normal map from tileable sine waves. */
export function rippleNormals(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  const waves = [[3, 1, 0.9], [-2, 4, 0.6], [5, -3, 0.35], [-7, -5, 0.2], [9, 2, 0.15]]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0
      let dy = 0
      for (const [kx, ky, a] of waves) {
        const ph = ((kx * x + ky * y) / size) * Math.PI * 2
        dx += a * kx * Math.cos(ph) * 0.05
        dy += a * ky * Math.cos(ph) * 0.05
      }
      const n = new THREE.Vector3(-dx, -dy, 1).normalize()
      data.set([(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255, 255], (y * size + x) * 4)
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

const NOISE_GLSL = /* glsl */ `
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm5(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`

/** The sky: a dome that follows the camera. Colours are set every frame by the world. */
export class SkyDome {
  readonly mesh: THREE.Mesh
  readonly uniforms = {
    uTime: CLOCK,
    uZenith: { value: new THREE.Color('#3f74b8') },
    uHorizon: { value: new THREE.Color('#bcd3e6') },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color('#fff1d6') },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uCloud: { value: 0.45 },
    uCloudLit: { value: new THREE.Color('#ffffff') },
    uCloudShade: { value: new THREE.Color('#9aa7b8') },
  }

  constructor(radius = 900) {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // on the far plane
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor;
        uniform vec3 uMoonDir; uniform float uNight; uniform float uCloud; uniform vec3 uCloudLit; uniform vec3 uCloudShade;
        varying vec3 vDir;
        ${NOISE_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, smoothstep(-0.02, 0.6, h));
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (smoothstep(0.9994, 0.9997, sd) * 8.0 + pow(sd, 14.0) * 0.45 + pow(sd, 3.0) * 0.12) * (1.0 - uNight * 0.9);
          float md = max(dot(d, uMoonDir), 0.0);
          col += vec3(0.9, 0.93, 1.0) * (smoothstep(0.99955, 0.9998, md) * 1.6 + pow(md, 80.0) * 0.12) * uNight;
          if (h > 0.0) {
            vec3 cell = floor(d * 260.0);
            float r = hash13(cell);
            if (r > 0.9965) {
              vec3 c = (cell + 0.5) / 260.0;
              float tw = 0.6 + 0.4 * sin(uTime * (1.5 + r * 3.0) + r * 80.0);
              col += vec3(0.85, 0.9, 1.0) * (1.0 - smoothstep(0.0, 0.0028, length(d - normalize(c)))) * tw * uNight * smoothstep(0.0, 0.25, h) * 1.6;
            }
            vec2 cp = d.xz / (h + 0.09) * 0.9 + vec2(uTime * 0.0045, uTime * 0.0016);
            float c = fbm5(cp);
            float cover = smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.28, c);
            float lit = fbm5(cp - uSunDir.xz * 0.06);
            vec3 cc = mix(uCloudShade, uCloudLit, clamp(0.55 + (c - lit) * 4.0, 0.0, 1.0));
            cc += uSunColor * pow(sd, 6.0) * 0.4 * (1.0 - uNight);
            col = mix(col, cc, cover * smoothstep(0.0, 0.12, h) * 0.92);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -10
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

/** Ground: vertex colours with noise detail, and cobblestones where the `road` attribute is 1. */
export function groundMaterial(noise: THREE.Texture, cobble: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: noise }
    shader.uniforms.uCobble = { value: cobble }
    const varyings = 'varying float vRoad;\nvarying vec2 vRoadUv;\nvarying vec3 vGroundPos;\nvarying float vUp;\n'
    shader.vertexShader = 'attribute float road;\nattribute vec2 groundUv;\n' + varyings
      + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = road;\nvRoadUv = groundUv;\nvGroundPos = position;\nvUp = normal.y;')
    shader.fragmentShader = 'uniform sampler2D uNoise;\nuniform sampler2D uCobble;\n' + varyings
      + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec2 xz = vGroundPos.xz;
        float gn = texture2D(uNoise, xz * 0.035).r * 0.5 + texture2D(uNoise, xz * 0.19).r * 0.3 + texture2D(uNoise, xz * 0.9).r * 0.2;
        diffuseColor.rgb *= 0.66 + 0.68 * gn;
        // Cliffs and steep slopes: layered rock (strata along the height, cracks across).
        float steep = 1.0 - smoothstep(0.6, 0.86, vUp);
        if (steep > 0.0) {
          float along = vGroundPos.x * 0.7 + vGroundPos.z * 0.7;
          float strata = texture2D(uNoise, vec2(along * 0.02, vGroundPos.y * 0.13)).r;
          float blocks = texture2D(uNoise, vec2(along * 0.07, vGroundPos.y * 0.035)).r;
          float fine = texture2D(uNoise, vec2(along * 0.45, vGroundPos.y * 0.45)).r;
          float rock = 0.3 + 1.1 * smoothstep(0.25, 0.75, strata) * (0.45 + 0.55 * smoothstep(0.3, 0.7, blocks)) + 0.4 * (fine - 0.5);
          vec3 rockColor = mix(vec3(0.27, 0.26, 0.24), vec3(0.5, 0.46, 0.4), blocks);
          // Moss on the less steep ledges.
          rockColor = mix(rockColor, vec3(0.2, 0.3, 0.13), smoothstep(0.45, 0.75, vUp) * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, rockColor * rock, steep);
        }
        vec3 cob = texture2D(uCobble, vRoadUv).rgb;
        diffuseColor.rgb = mix(diffuseColor.rgb, cob * 0.9, vRoad);`)
  }
  m.customProgramCacheKey = () => 'fantasy-ground'
  return m
}

/** Falling water: streaks scrolling down, foam at the bottom, soft edges. */
export function waterfallMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uLight: { value: 1 } }]) as Record<string, THREE.IUniform>,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uLight;
      varying vec2 vUv;
      ${NOISE_GLSL}
      #include <fog_pars_fragment>
      void main() {
        float flow = vUv.y * 3.0 - uTime * 1.6; // v grows downwards
        float s = vnoise(vec2(vUv.x * 22.0, flow)) * 0.6 + vnoise(vec2(vUv.x * 55.0, flow * 2.3)) * 0.4;
        vec3 col = mix(vec3(0.24, 0.44, 0.55), vec3(0.92, 0.96, 1.0), smoothstep(0.4, 0.9, s));
        float foam = smoothstep(0.82, 1.0, vUv.y);
        col = mix(col, vec3(1.0), foam * 0.8);
        float edge = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.88, 1.0, vUv.x)) * smoothstep(0.0, 0.04, vUv.y);
        gl_FragColor = vec4(col * uLight * 0.92, (0.78 + 0.2 * s) * edge);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  })
  material.uniforms.uTime = CLOCK // merge() copies uniforms; share the clock instead
  return material
}

/**
 * Glowing points: fireflies drifting in a box around the camera, or spray rising at a fixed
 * place. Positions wrap around `uCenter` (box mode) so a few hundred points fill the world.
 */
export function glowPointsMaterial(color: string, size: number, box: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: CLOCK,
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uBox: { value: box },
      uCenter: { value: new THREE.Vector3() },
      uAlpha: { value: 1 },
      uPixelRatio: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uSize; uniform float uBox; uniform vec3 uCenter; uniform float uPixelRatio;
      attribute float seed;
      varying float vBlink;
      void main() {
        vec3 p = position + vec3(sin(uTime * 0.6 + seed * 6.0) * 0.9, sin(uTime * 0.9 + seed * 3.0) * 0.5, cos(uTime * 0.5 + seed * 5.0) * 0.9);
        if (uBox > 0.0) p.xz = mod(p.xz - uCenter.xz + uBox * 0.5, uBox) - uBox * 0.5 + uCenter.xz;
        vBlink = pow(0.5 + 0.5 * sin(uTime * (1.2 + fract(seed * 7.0)) + seed * 40.0), 3.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(uSize * uPixelRatio * 300.0 / max(1.0, -mv.z), 90.0 * uPixelRatio);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha;
      varying float vBlink;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = 1.0 - smoothstep(0.0, 0.5, d);
        gl_FragColor = vec4(uColor * (1.0 + 2.0 * a * a), a * vBlink * uAlpha);
      }`,
  })
}
