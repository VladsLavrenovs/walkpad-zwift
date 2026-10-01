/**
 * World map page (#/worldmap): the whole open-world continent of a seed, top-down, nothing
 * hidden. Terrain (biomes, relief, sea, lakes, province borders) is drawn into map tiles from the
 * generator; rivers, roads, bridges, places and province names go on top. Generation runs in a
 * Web Worker. For judging the world while it is being built; the game's map will reuse this.
 */

import { L } from '../../routes/map'
import { type Continent, OW_BIOMES, OW_BIOME_NAMES, type Place, type PlaceKind, WORLD_M } from './continent'
import { RIVER_FLOW } from './continent/hydro'
import { MAP_COLORS, WATER_COLOR, colorAt } from './mapdraw'

const RIVER_COLOR = '#2f78b4'

const SEED_KEY = 'walkpad.openworld.mapseed'

const SYMBOL: Record<PlaceKind, string> = {
  city: '■', village: '●', castle: '♜', ruins: '✧', windmill: '✣', waterfall: '≋',
}

class TerrainLayer extends L.GridLayer {
  private readonly world: Continent

  constructor(world: Continent) {
    super({ tileSize: 256, minZoom: -6, maxZoom: 3 })
    this.world = world
  }

  createTile(coords: L.Coords): HTMLElement {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(256, 256)
    const scale = 2 ** coords.z // pixels per metre
    const mpp = 1 / scale
    for (let py = 0; py < 256; py++) {
      const z = -(coords.y * 256 + py + 0.5) / scale
      for (let px = 0; px < 256; px++) {
        const x = (coords.x * 256 + px + 0.5) / scale
        colorAt(this.world, x, z, mpp, img.data, (py * 256 + px) * 4)
      }
    }
    ctx.putImageData(img, 0, 0)
    return canvas
  }
}

export class WorldMapPage {
  private readonly el: HTMLDivElement
  private map: L.Map | null = null
  private layers: L.Layer[] = []
  private worker: Worker | null = null
  private info!: HTMLSpanElement
  private seedInput!: HTMLInputElement
  private generating = 0

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'worldmap-page'
    this.el.hidden = true
    this.el.innerHTML = `
      <header>
        <h1>World map</h1>
        <label>seed <input type="number" class="wm-seed" min="1" step="1"></label>
        <button type="button" class="wm-go">Generate</button>
        <button type="button" class="wm-random">Random</button>
        <span class="wm-info muted"></span>
        <a href="#/" class="link">Back to walking</a>
      </header>
      <div class="wm-map"></div>`
    parent.append(this.el)
    this.info = this.el.querySelector('.wm-info')!
    this.seedInput = this.el.querySelector('.wm-seed')!
    this.el.querySelector<HTMLButtonElement>('.wm-go')!.onclick = () => this.generate(Number(this.seedInput.value) || 1)
    this.el.querySelector<HTMLButtonElement>('.wm-random')!.onclick = () => this.generate(1 + Math.floor(Math.random() * 999_999))
    this.seedInput.onkeydown = (e) => {
      if (e.key === 'Enter') this.generate(Number(this.seedInput.value) || 1)
    }
  }

  show(): void {
    this.el.hidden = false
    if (!this.map) {
      this.map = L.map(this.el.querySelector<HTMLElement>('.wm-map')!, {
        // keyboard: false: the arrow keys change the belt speed (controls.ts), never pan this map.
        crs: L.CRS.Simple, minZoom: -4, maxZoom: 3, zoomSnap: 0.25, attributionControl: false, keyboard: false,
        preferCanvas: true, maxBounds: L.latLngBounds([0, 0], [WORLD_M, WORLD_M]).pad(0.15),
      })
      this.map.fitBounds([[0, 0], [WORLD_M, WORLD_M]])
      // The page was just shown: measure again once the layout has settled.
      requestAnimationFrame(() => {
        this.map?.invalidateSize()
        this.map?.fitBounds([[0, 0], [WORLD_M, WORLD_M]])
      })
      L.control.scale({ imperial: false, maxWidth: 160 }).addTo(this.map)
      this.legend().addTo(this.map)
      this.map.on('zoomend', () => this.zoomClass())
      this.zoomClass()
      let seed = 1
      try {
        seed = Number(localStorage.getItem(SEED_KEY)) || 1
      } catch {
        /* ignore */
      }
      this.generate(seed)
    } else {
      this.map.invalidateSize()
    }
  }

  hide(): void {
    this.el.hidden = true
  }

  private generate(seed: number): void {
    this.seedInput.value = String(seed)
    try {
      localStorage.setItem(SEED_KEY, String(seed))
    } catch {
      /* ignore */
    }
    this.info.textContent = 'generating…'
    const job = ++this.generating
    const t0 = performance.now()
    this.worker?.terminate()
    this.worker = new Worker(new URL('./continent/worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<Continent>) => {
      if (job !== this.generating) return
      const world = e.data
      const s = world.stats
      this.info.textContent =
        `${Math.round(performance.now() - t0)} ms · land ${s.land_pct}% · ${s.rivers} rivers · ${s.lakes} lakes · ` +
        `${s.waterfalls} waterfalls · ${world.places.length} places · ${world.provinces.length} provinces · ${s.roads} roads`
      this.draw(world)
      this.worker?.terminate()
      this.worker = null
    }
    this.worker.postMessage({ seed })
  }

  private draw(world: Continent): void {
    const map = this.map!
    for (const layer of this.layers) layer.remove()
    this.layers = []
    const add = (layer: L.Layer) => {
      layer.addTo(map)
      this.layers.push(layer)
    }
    add(new TerrainLayer(world))
    const ll = ([x, z]: [number, number]) => L.latLng(z, x)
    // Rivers: thin at the source, wider downstream (one polyline per width class).
    for (const r of world.rivers) {
      let start = 0
      for (let i = 1; i <= r.points.length; i++) {
        const w = (k: number) => Math.min(6, 1.6 + Math.sqrt(r.flow[Math.min(k, r.flow.length - 1)] / RIVER_FLOW) * 1.1)
        if (i === r.points.length || Math.round(w(i)) !== Math.round(w(start))) {
          add(L.polyline(r.points.slice(start, i + 1).map(ll), { color: RIVER_COLOR, weight: w(start), opacity: 1, interactive: false }))
          start = i
        }
      }
    }
    for (const road of world.roads) {
      add(L.polyline(road.points.map(ll), { color: '#efe2bd', weight: 5, opacity: 0.85, interactive: false }))
    }
    for (const road of world.roads) {
      add(L.polyline(road.points.map(ll), { color: '#7b5733', weight: 2.2, opacity: 0.95, interactive: false }))
      for (const b of road.bridges) add(L.circleMarker(ll(b), { radius: 3, color: '#3a3a3a', weight: 1.5, fillColor: '#d9d4c7', fillOpacity: 1, interactive: false }))
    }
    for (const p of world.provinces) {
      add(L.marker(L.latLng(p.z, p.x), {
        interactive: false,
        icon: L.divIcon({ className: 'wm-province', html: `<span>${escapeHtml(p.name)}</span>`, iconSize: [0, 0] }),
      }))
    }
    const order: PlaceKind[] = ['waterfall', 'windmill', 'ruins', 'castle', 'village', 'city']
    for (const kind of order) for (const p of world.places.filter((q) => q.kind === kind)) add(this.placeMarker(p))
  }

  private placeMarker(p: Place): L.Marker {
    return L.marker(L.latLng(p.z, p.x), {
      title: `${p.name} (${p.kind})`,
      icon: L.divIcon({
        className: `wm-place wm-${p.kind}`,
        html: `<i>${SYMBOL[p.kind]}</i><span>${escapeHtml(p.name)}</span>`,
        iconSize: [0, 0],
      }),
    })
  }

  /** Smaller places' names appear as you zoom in. */
  private zoomClass(): void {
    const z = this.map!.getZoom()
    const box = this.el.querySelector('.wm-map')!
    box.classList.toggle('wm-far', z < -2.6)
    box.classList.toggle('wm-mid', z >= -2.6 && z < -1.5)
  }

  private legend(): L.Control {
    const control = new L.Control({ position: 'bottomleft' })
    control.onAdd = () => {
      const div = L.DomUtil.create('div', 'wm-legend')
      const swatch = (color: string, label: string) => `<div><b style="background:${color}"></b>${label}</div>`
      div.innerHTML = [
        ...OW_BIOMES.map((b) => swatch(MAP_COLORS[b], OW_BIOME_NAMES[b])),
        swatch(WATER_COLOR, 'Rivers and lakes'),
        swatch('#7b5733', 'Roads (● bridge)'),
        swatch('#5a2d5c', 'Province borders'),
        ...(['city', 'village', 'castle', 'ruins', 'windmill', 'waterfall'] as PlaceKind[]).map(
          (k) => `<div><i class="wm-${k}">${SYMBOL[k]}</i>${k[0].toUpperCase()}${k.slice(1)}</div>`),
      ].join('')
      L.DomEvent.disableClickPropagation(div)
      return div
    }
    return control
  }

  dispose(): void {
    this.worker?.terminate()
    this.map?.remove()
    this.el.remove()
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}
