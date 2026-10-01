/**
 * Free walk (no trail): how far you have got in this browser's free-walk world, kept across
 * page loads and sessions, so every walk continues where the last one ended instead of
 * starting over in the first biome. A new world ("New world") starts again at 0.
 */

export const FREE_PROGRESS_KEY = 'walkpad.fantasy.free'
/** Save after this many metres (and on every new world). */
const SAVE_EVERY_M = 5

export interface KeyValue {
  get(key: string): string | null
  set(key: string, value: string): void
}

export class FreeWalkProgress {
  private readonly store: KeyValue
  private world = ''
  private offset = 0
  private base: number | null = null
  private saved = 0

  constructor(store: KeyValue) {
    this.store = store
  }

  /** Switch to the free-walk world `world` (seed and start): resume its saved position. */
  use(world: string): void {
    this.world = world
    let stored: { world?: unknown; s?: unknown } | null = null
    try {
      stored = JSON.parse(this.store.get(FREE_PROGRESS_KEY) ?? 'null')
    } catch {
      stored = null
    }
    const s = stored?.world === world && typeof stored.s === 'number' && Number.isFinite(stored.s) ? stored.s : 0
    this.offset = Math.max(0, s)
    this.saved = this.offset
    this.base = null // the next odometer reading is "here"
  }

  /** A new world: start at 0. */
  reset(world: string): void {
    this.store.set(FREE_PROGRESS_KEY, JSON.stringify({ world, s: 0 }))
    this.use(world)
  }

  /** Position in the world for this odometer reading (metres, never going back). */
  position(odometerM: number): number {
    if (this.base === null || odometerM < this.base) this.base = odometerM
    const s = this.offset + (odometerM - this.base)
    if (s - this.saved >= SAVE_EVERY_M) {
      this.store.set(FREE_PROGRESS_KEY, JSON.stringify({ world: this.world, s }))
      this.saved = s
    }
    return s
  }
}
