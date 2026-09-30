/** Leaflet with OpenStreetMap tiles, shared by the minimap and the route planner. */

import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export { L }

export const ROUTE_COLOR = '#58c4dc'
export const DONE_COLOR = '#3ecf8e'

export function osmMap(el: HTMLElement, options: L.MapOptions = {}): L.Map {
  const map = L.map(el, { zoomControl: true, ...options })
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map)
  return map
}
