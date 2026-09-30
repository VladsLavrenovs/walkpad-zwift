/**
 * Smooth position along the active route between samples. The bridge reports route progress
 * (from the pad's distance, which on the owner's pad moves in 10 m steps); the world and the
 * minimap need it every frame. Same idea as the HUD distance in motion.ts: integrate the smoothed
 * speed, but stay inside [reported, reported + resolution] and never go backwards (except when
 * the route changes or its progress is reset).
 */

export class RouteTracker {
  routeId: number | null = null
  /** Current estimate, metres along the route. */
  position = 0
  private reported = 0
  private resolution = 1

  setResolution(metres: number): void {
    this.resolution = metres
  }

  onReport(routeId: number | null, progress: number | null): void {
    if (routeId === null || progress === null) {
      this.routeId = null
      return
    }
    if (routeId !== this.routeId || progress < this.reported) {
      // Another route, or progress was reset: jump.
      this.routeId = routeId
      this.position = progress
    }
    this.reported = progress
    this.position = Math.min(Math.max(this.position, progress), progress + this.resolution)
  }

  /** Advance by metres walked this frame. */
  advance(metres: number, routeLength: number): void {
    if (this.routeId === null) return
    this.position = Math.min(this.position + metres, this.reported + this.resolution, routeLength)
  }
}
