/**
 * World map page (#/worldmap): the whole open-world continent of a seed, top-down, nothing
 * hidden. Terrain (biomes, relief, sea, lakes, province borders) is drawn into map tiles from the
 * generator; rivers, roads, bridges, places and province names go on top. Generation runs in a
 * Web Worker. Try seeds, save the world you like (a snapshot on the bridge: later generator
 * changes never reshape it), keep several, and pick the one you walk in. Saving and switching
 * are local-only; the public (view-only) site can look.
 */

import type { BridgeClient, SavedWorld } from '../../bridge'
import { L } from '../../routes/map'
import { type Continent, GENERATOR_VERSION, OW_BIOMES, OW_BIOME_NAMES, type Place, type PlaceKind, WORLD_M } from './continent'
import { decodeSnapshot, encodeSnapshot } from './continent/snapshot'
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

/** What the map shows: a seed being tried out, or a saved world. */
type Shown = { kind: 'preview'; seed: number; world: Continent } | { kind: 'saved'; saved: SavedWorld; world: Continent }

export class WorldMapPage {
  private readonly el: HTMLDivElement
  private readonly bridge: BridgeClient
  private readonly canEdit: () => boolean
  private map: L.Map | null = null
  private layers: L.Layer[] = []
  private worker: Worker | null = null
  private info!: HTMLSpanElement
  private title!: HTMLSpanElement
  private seedInput!: HTMLInputElement
  private saveButton!: HTMLButtonElement
  private mineButton!: HTMLButtonElement
  private panel!: HTMLDivElement
  private generating = 0
  private shown: Shown | null = null
  private saved: SavedWorld[] = []

  constructor(parent: HTMLElement, bridge: BridgeClient, canEdit: () => boolean) {
    this.bridge = bridge
    this.canEdit = canEdit
    this.el = document.createElement('div')
    this.el.className = 'worldmap-page'
    this.el.hidden = true
    this.el.innerHTML = `
      <header>
        <h1>World map</h1>
        <span class="wm-title"></span>
        <label>seed <input type="number" class="wm-seed" min="1" step="1"></label>
        <button type="button" class="wm-go">Generate</button>
        <button type="button" class="wm-random">Random</button>
        <button type="button" class="wm-save" hidden>Save this world</button>
        <button type="button" class="wm-mine">My worlds</button>
        <span class="wm-info muted"></span>
        <a href="#/" class="link">Back to walking</a>
      </header>
      <div class="wm-worlds" hidden></div>
      <div class="wm-map"></div>`
    parent.append(this.el)
    this.info = this.el.querySelector('.wm-info')!
    this.title = this.el.querySelector('.wm-title')!
    this.seedInput = this.el.querySelector('.wm-seed')!
    this.saveButton = this.el.querySelector('.wm-save')!
    this.mineButton = this.el.querySelector('.wm-mine')!
    this.panel = this.el.querySelector('.wm-worlds')!
    this.el.querySelector<HTMLButtonElement>('.wm-go')!.onclick = () => this.generate(Number(this.seedInput.value) || 1)
    this.el.querySelector<HTMLButtonElement>('.wm-random')!.onclick = () => this.generate(1 + Math.floor(Math.random() * 999_999))
    this.seedInput.onkeydown = (e) => {
      if (e.key === 'Enter') this.generate(Number(this.seedInput.value) || 1)
    }
    this.saveButton.onclick = () => void this.saveShown()
    this.mineButton.onclick = () => {
      this.panel.hidden = !this.panel.hidden
      if (!this.panel.hidden) void this.refreshList()
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
      void this.start()
    } else {
      this.map.invalidateSize()
      void this.refreshList()
    }
  }

  hide(): void {
    this.el.hidden = true
  }

  /** First visit: the world you walk in, if one is saved; otherwise the last seed tried. */
  private async start(): Promise<void> {
    await this.refreshList()
    const active = this.saved.find((w) => w.active)
    if (active) {
      await this.openSaved(active)
      return
    }
    let seed = 1
    try {
      seed = Number(localStorage.getItem(SEED_KEY)) || 1
    } catch {
      /* ignore */
    }
    this.generate(seed)
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
      this.info.textContent = `${Math.round(performance.now() - t0)} ms · ${summary(world)}`
      this.shown = { kind: 'preview', seed, world }
      this.renderTitle()
      this.draw(world)
      this.worker?.terminate()
      this.worker = null
    }
    this.worker.postMessage({ seed })
  }

  private async openSaved(saved: SavedWorld): Promise<void> {
    const job = ++this.generating
    this.worker?.terminate()
    this.info.textContent = `loading ${saved.name}…`
    try {
      const { continent } = await decodeSnapshot(await this.bridge.worldSnapshot(saved.id))
      if (job !== this.generating) return
      this.shown = { kind: 'saved', saved, world: continent }
      this.seedInput.value = String(saved.seed)
      this.info.textContent = summary(continent)
      this.renderTitle()
      this.draw(continent)
    } catch (err) {
      this.info.textContent = `Could not load ${saved.name}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  private renderTitle(): void {
    const shown = this.shown
    if (!shown) return
    if (shown.kind === 'saved') {
      const s = shown.saved
      this.title.innerHTML = `${s.active ? '<b class="wm-star" title="the world you walk in">★</b> ' : ''}<b>${escapeHtml(s.name)}</b>` +
        ` <span class="muted">saved · seed ${s.seed} · generator v${s.gen_version}</span>`
    } else {
      this.title.innerHTML = `<b>Preview</b> <span class="muted">seed ${shown.seed} · not saved</span>`
    }
    this.saveButton.hidden = !(shown.kind === 'preview' && this.canEdit())
  }

  private async refreshList(): Promise<void> {
    try {
      this.saved = await this.bridge.worlds()
    } catch {
      this.saved = []
    }
    this.mineButton.textContent = `My worlds (${this.saved.length})`
    if (this.shown?.kind === 'saved') {
      const id = this.shown.saved.id
      const fresh = this.saved.find((w) => w.id === id)
      if (fresh) this.shown = { ...this.shown, saved: fresh }
    }
    this.renderTitle()
    this.renderList()
  }

  private renderList(): void {
    const edit = this.canEdit()
    if (this.saved.length === 0) {
      this.panel.innerHTML = `<p class="muted">No saved worlds yet. Try seeds, then “Save this world” on the one you like.
        The first world you save is the one you walk in.</p>`
      return
    }
    this.panel.replaceChildren(...this.saved.map((w) => {
      const row = document.createElement('div')
      row.className = `wm-world${w.active ? ' active' : ''}`
      const walked = w.walked_m > 0 ? ` · walked ${(w.walked_m / 1000).toFixed(1)} km` : ''
      row.innerHTML = `
        <span class="wm-world-name">${w.active ? '★ ' : ''}${escapeHtml(w.name)}</span>
        <span class="muted">seed ${w.seed} · v${w.gen_version} · ${(w.size / 1e6).toFixed(1)} MB${walked}</span>
        <span class="wm-world-actions">
          <button type="button" data-a="view">View</button>
          ${edit && !w.active ? '<button type="button" data-a="walk">Walk here</button>' : ''}
          ${edit ? '<button type="button" data-a="rename">Rename</button><button type="button" data-a="delete">Delete</button>' : ''}
        </span>`
      row.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.onclick = () => void this.act(b.dataset.a!, w)
      })
      return row
    }))
  }

  private async act(action: string, w: SavedWorld): Promise<void> {
    try {
      if (action === 'view') {
        this.panel.hidden = true
        await this.openSaved(w)
      } else if (action === 'walk') {
        this.saved = await this.bridge.setActiveWorld(w.id)
        await this.refreshList()
      } else if (action === 'rename') {
        const name = window.prompt('New name for this world', w.name)?.trim()
        if (!name) return
        await this.bridge.renameWorld(w.id, name.slice(0, 80))
        await this.refreshList()
      } else if (action === 'delete') {
        if (!window.confirm(`Delete “${w.name}”? Your place in it is lost; the seed can make it again only with the same generator version.`)) return
        await this.bridge.deleteWorld(w.id)
        if (this.shown?.kind === 'saved' && this.shown.saved.id === w.id) {
          this.shown = { kind: 'preview', seed: w.seed, world: this.shown.world }
        }
        await this.refreshList()
      }
    } catch (err) {
      this.info.textContent = err instanceof Error ? err.message : String(err)
    }
  }

  private async saveShown(): Promise<void> {
    const shown = this.shown
    if (shown?.kind !== 'preview') return
    const city = shown.world.places.find((p) => p.kind === 'city')
    const name = window.prompt('Name this world', city ? `Isle of ${city.name}` : `World ${shown.seed}`)?.trim()
    if (!name) return
    this.saveButton.disabled = true
    this.info.textContent = 'saving…'
    try {
      const bytes = await encodeSnapshot(shown.world, GENERATOR_VERSION)
      const saved = await this.bridge.saveWorld(name.slice(0, 80), shown.seed, GENERATOR_VERSION, bytes)
      this.shown = { kind: 'saved', saved, world: shown.world }
      this.info.textContent = `saved (${(bytes.length / 1e6).toFixed(1)} MB)${saved.active ? ' · this is the world you walk in' : ''}`
      await this.refreshList()
    } catch (err) {
      this.info.textContent = `Could not save: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      this.saveButton.disabled = false
    }
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
    // Where you are in a saved world (from the bridge).
    const me = this.shown?.kind === 'saved' ? this.shown.saved : null
    if (me && me.x !== null && me.z !== null) {
      const deg = (((me.heading ?? 0) * 180) / Math.PI - 90).toFixed(0) // ➤ points east; heading 0 = north
      add(L.marker(L.latLng(me.z, me.x), {
        title: 'You are here',
        zIndexOffset: 1000,
        icon: L.divIcon({ className: 'wm-me', html: `<i style="transform: translate(-50%, -50%) rotate(${deg}deg)">➤</i>`, iconSize: [0, 0] }),
      }))
    }
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

function summary(world: Continent): string {
  const s = world.stats
  return `land ${s.land_pct}% · ${s.rivers} rivers · ${s.lakes} lakes · ${s.waterfalls} waterfalls · ` +
    `${world.places.length} places · ${world.provinces.length} provinces · ${s.roads} roads`
}
