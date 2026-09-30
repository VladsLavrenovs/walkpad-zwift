/**
 * Worlds are pluggable. A world draws the scenery inside its own container; the app owns
 * everything else (HUD, walker, controls, stats), which stays the same for every world.
 */

import type { BridgeClient } from '../bridge'

/** What the app offers a world. */
export interface WorldContext {
  bridge: BridgeClient
  /** Whether this page may change things on the bridge (local page, not OBS / view-only). */
  canEdit(): boolean
  /** Show or hide the walker sprite (a world may offer a toggle). */
  setWalkerVisible(on: boolean): void
  /** true for `?view=obs`: no world UI either. */
  obs: boolean
}

export interface World {
  /** Whether the app shows the walker sprite over this world when it starts. */
  readonly showsWalker: boolean
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
