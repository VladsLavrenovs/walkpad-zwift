/**
 * Worlds are pluggable. A world draws the scenery inside its own container; the app owns
 * everything else (HUD, walker, controls, stats), which stays the same for every world.
 */

import type { BridgeClient, RouteSummary } from '../bridge'
import type { Polyline } from '../routes/geo'

/** What the app offers a world. */
export interface WorldContext {
  bridge: BridgeClient
  /** Whether this page may change things on the bridge (local page, not OBS / view-only). */
  canEdit(): boolean
  /** Show or hide the walker sprite (a world may offer a toggle). */
  setWalkerVisible(on: boolean): void
  /**
   * Move/scale the walker sprite from its normal spot (screen pixels; scale about her feet), for
   * a world whose camera can move; null hides her. Worlds that never call it leave her in place.
   */
  placeWalker(p: { dx: number; dy: number; scale: number } | null): void
  /** true for `?view=obs`: no world UI either. */
  obs: boolean
  /** The active route's shape, once loaded (null: no active route, or a trail without a map). */
  route(): Polyline | null
  /** The active route or trail (name, length, seed, progress), or null. */
  activeRoute(): RouteSummary | null
  /** Give up on this world: the app switches to the default world and shows `message`. */
  fallback(message: string): void
}

export interface World {
  /** Whether the app shows the walker sprite over this world when it starts. */
  readonly showsWalker: boolean
  /** false: the world wants the odometer even on an active route (it is not a route world). */
  readonly usesRoute?: boolean
  /** Build the scene inside `container` (full-screen, behind the HUD). */
  init(container: HTMLElement, ctx: WorldContext): void | Promise<void>
  /**
   * Called every frame. `distanceM` is a monotonic odometer (never jumps back), `speedKmh`
   * the smoothed belt speed, `dt` seconds since the previous frame.
   */
  update(distanceM: number, speedKmh: number, dt: number): void
  /** Remove everything `init` created. */
  dispose(): void
}

export interface WorldInfo {
  id: string
  name: string
  create(): World
}
