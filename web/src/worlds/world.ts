/**
 * Worlds are pluggable. A world draws the scenery inside its own container; the app owns
 * everything else (HUD, walker, controls, stats), which stays the same for every world.
 */

export interface World {
  /** Whether the app shows the walker sprite over this world. */
  readonly showsWalker: boolean
  /** Build the scene inside `container` (full-screen, behind the HUD). */
  init(container: HTMLElement): void | Promise<void>
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
