/** Small map (top right) while a route is active: the route, the part walked, where you are. */

import type { BridgeClient, RouteSummary } from '../bridge'
import { fmtDistance } from '../format'
import { Polyline } from './geo'
import { DONE_COLOR, L, ROUTE_COLOR, osmMap } from './map'

const UPDATE_EVERY_S = 0.25
const DONE_EVERY_S = 2

export class Minimap {
  readonly el: HTMLDivElement
  private readonly label: HTMLDivElement
  private map: L.Map | null = null
  private rest: L.Polyline | null = null
  private done: L.Polyline | null = null
  private marker: L.CircleMarker | null = null
  private routeId: number | null = null
  private loading: number | null = null
  line: Polyline | null = null
  private sinceUpdate = 0
  private sinceDone = 0
  private readonly bridge: BridgeClient

  constructor(parent: HTMLElement, bridge: BridgeClient) {
    this.bridge = bridge
    this.el = document.createElement('div')
    this.el.className = 'minimap'
    this.el.hidden = true
    this.el.innerHTML = '<div class="minimap-map"></div><div class="minimap-label"></div>'
    this.label = this.el.querySelector('.minimap-label')!
    parent.append(this.el)
  }

  /** Called with every status: loads the route's shape when the active route changes. */
  async setRoute(route: RouteSummary | null): Promise<void> {
    if (route === null) {
      this.routeId = null
      this.line = null
      this.el.hidden = true
      return
    }
    if (route.id === this.routeId || route.id === this.loading) return
    this.loading = route.id
    try {
      const full = await this.bridge.route(route.id)
      if (this.loading !== route.id || !full.points) return
      this.routeId = route.id
      this.line = new Polyline(full.points)
      this.el.hidden = false
      this.draw(full.points)
    } catch (err) {
      console.warn('could not load the active route', err)
    } finally {
      if (this.loading === route.id) this.loading = null
    }
  }

  private draw(points: [number, number][]): void {
    if (!this.map) {
      this.map = osmMap(this.el.querySelector<HTMLElement>('.minimap-map')!, {
        zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false,
        doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
      })
      this.map.attributionControl.setPrefix(false)
    }
    this.rest?.remove()
    this.done?.remove()
    this.marker?.remove()
    this.rest = L.polyline(points, { color: ROUTE_COLOR, weight: 4, opacity: 0.8 }).addTo(this.map)
    this.done = L.polyline([], { color: DONE_COLOR, weight: 5 }).addTo(this.map)
    this.marker = L.circleMarker(points[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#e5383b', fillOpacity: 1 })
      .addTo(this.map)
    this.map.setView(points[0], 16)
    this.sinceDone = DONE_EVERY_S
  }

  /** Every frame, with the smooth position along the route (metres). */
  update(position: number, dt: number): void {
    const line = this.line
    if (!line || !this.map || !this.marker) return
    this.sinceUpdate += dt
    this.sinceDone += dt
    if (this.sinceUpdate < UPDATE_EVERY_S) return
    this.sinceUpdate = 0
    const { point } = line.at(position)
    this.marker.setLatLng(point)
    this.map.panTo(point, { animate: false })
    this.label.textContent = `${fmtDistance(position)} / ${fmtDistance(line.length)} · ${Math.floor((100 * position) / line.length)}%`
    if (this.sinceDone >= DONE_EVERY_S && this.done) {
      this.sinceDone = 0
      const i = line.cumulative.findIndex((c) => c > position)
      const walked = i === -1 ? line.points : [...line.points.slice(0, Math.max(1, i)), point]
      this.done.setLatLngs(walked)
    }
  }
}
