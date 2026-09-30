/**
 * The walker: 4 back-view frames (public/walker/walker_1..4.png), fixed lower-centre over
 * the world. Loop 1-2-3-4 = one gait cycle = 2 steps, so 2 frames per step, driven by cadence.
 * Frames crossfade over CROSSFADE_MS to hide small differences in hair and clothing: the new
 * frame fades in on top of the old one, which stays opaque underneath until the fade is done
 * (a plain two-way fade would make the whole figure see-through mid-fade). The body
 * bobs up slightly once per step; when stopped it settles on frame 1.
 */

export const FRAMES = 4
export const FRAMES_PER_STEP = 2
export const CROSSFADE_MS = 80
/** Bob height as a fraction of the sprite's height, at full effect. */
const BOB_FRACTION = 0.006
/** Speed at which the bob reaches full height. */
const BOB_FULL_KMH = 3

/** Pure gait state: advance by cadence, read frame and bob. */
export class Gait {
  /** Position in the loop, in frames: [0, FRAMES). */
  phase = 0

  advance(stepsPerSecond: number, dt: number): void {
    if (stepsPerSecond <= 0) {
      // Stopped: settle on frame 1 rather than freezing mid-stride.
      this.phase = 0
      return
    }
    this.phase = (this.phase + stepsPerSecond * FRAMES_PER_STEP * dt) % FRAMES
  }

  /** 0-based frame index. */
  frame(): number {
    return Math.floor(this.phase) % FRAMES
  }

  /** Upward offset as a fraction of sprite height: a small arch per step, 0 when stopped. */
  bob(speedKmh: number): number {
    if (speedKmh <= 0) return 0
    const stepPhase = (this.phase / FRAMES_PER_STEP) % 1
    const strength = Math.min(1, speedKmh / BOB_FULL_KMH)
    return Math.sin(Math.PI * stepPhase) * BOB_FRACTION * strength
  }
}

export class Walker {
  readonly el: HTMLDivElement
  private readonly imgs: HTMLImageElement[] = []
  private readonly gait = new Gait()
  private shown = -1
  private z = 1
  private fadeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(parent: HTMLElement, base = import.meta.env.BASE_URL) {
    this.el = document.createElement('div')
    this.el.className = 'walker'
    this.el.setAttribute('aria-hidden', 'true')
    this.el.style.setProperty('--fade', `${CROSSFADE_MS}ms`)
    for (let i = 1; i <= FRAMES; i++) {
      const img = document.createElement('img')
      img.src = `${base}walker/walker_${i}.png`
      img.alt = ''
      img.decoding = 'async'
      img.draggable = false
      this.el.append(img)
      this.imgs.push(img)
    }
    parent.append(this.el)
    this.show(0)
  }

  set visible(on: boolean) {
    this.el.hidden = !on
  }

  update(stepsPerSecond: number, speedKmh: number, dt: number): void {
    this.gait.advance(stepsPerSecond, dt)
    this.show(this.gait.frame())
    const bob = this.gait.bob(speedKmh) * this.el.clientHeight
    this.el.style.transform = `translate(-50%, ${(-bob).toFixed(2)}px)`
  }

  private show(frame: number): void {
    if (frame === this.shown) return
    const next = this.imgs[frame]
    const prev = this.shown >= 0 ? this.imgs[this.shown] : null
    for (const img of this.imgs) if (img !== next && img !== prev) img.classList.remove('on', 'under')
    if (prev) {
      prev.classList.remove('on')
      prev.classList.add('under') // stays fully visible beneath while `next` fades in
    }
    next.style.zIndex = String(++this.z)
    next.classList.remove('under')
    next.classList.add('on')
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.fadeTimer = setTimeout(() => prev?.classList.remove('under'), CROSSFADE_MS)
    this.shown = frame
  }

  dispose(): void {
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.el.remove()
  }
}
