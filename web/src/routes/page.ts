/** Routes page (#/routes): the active route, the list, GPX import, and the route planner. */

import type { BridgeClient, Route } from '../bridge'
import { fmtDistance } from '../format'
import { DONE_COLOR, L, ROUTE_COLOR, osmMap } from './map'

export class RoutesPage {
  readonly el: HTMLElement
  private readonly bridge: BridgeClient
  private readonly canEdit: () => boolean
  private readonly onChange: () => void
  private routes: Route[] = []
  private map: L.Map | null = null
  private waypoints: L.LatLng[] = []
  private waypointLayer: L.LayerGroup | null = null
  private plannedLayer: L.LayerGroup | null = null
  private planned: { points: [number, number][]; distance_m: number } | null = null

  constructor(parent: HTMLElement, bridge: BridgeClient, canEdit: () => boolean, onChange: () => void) {
    this.bridge = bridge
    this.canEdit = canEdit
    this.onChange = onChange
    this.el = document.createElement('section')
    this.el.className = 'routes-page'
    this.el.hidden = true
    parent.append(this.el)
  }

  async show(): Promise<void> {
    this.el.hidden = false
    const editable = this.canEdit()
    this.el.innerHTML = `
      <header><h1>Routes</h1><a href="#/" class="link">Back to walking</a></header>
      <p class="muted">The active route moves as you walk, across sessions, until you reach its end.</p>
      <div class="route-list"><p class="muted">Loading…</p></div>
      <div class="route-tools" ${editable ? '' : 'hidden'}>
        <h2>Import a GPX file</h2>
        <form class="gpx-form">
          <input type="file" name="file" accept=".gpx,application/gpx+xml" required>
          <input type="text" name="name" placeholder="Name (optional)" maxlength="200">
          <button type="submit">Import</button>
        </form>
        <h2>Plan a walk</h2>
        <p class="muted">Click the map for the start, then the end (more clicks add stops in between).
          The walking route comes from OpenRouteService via the bridge.</p>
        <div class="planner-bar">
          <button type="button" class="plan-go" disabled>Get walking route</button>
          <button type="button" class="plan-clear">Clear</button>
          <button type="button" class="plan-locate">My location</button>
          <span class="plan-info muted"></span>
        </div>
        <div class="planner-map"></div>
        <form class="plan-save" hidden>
          <input type="text" name="name" placeholder="Route name" maxlength="200" required>
          <button type="submit" name="use" value="0">Save</button>
          <button type="submit" name="use" value="1">Save &amp; walk it</button>
        </form>
      </div>
      <p class="muted" ${editable ? 'hidden' : ''}>View only: routes can be changed from the page on the home network.</p>
      <p class="error" hidden></p>`
    if (editable) this.setUpTools()
    await this.reload()
  }

  hide(): void {
    this.el.hidden = true
  }

  private async reload(): Promise<void> {
    try {
      this.routes = await this.bridge.routes()
    } catch (err) {
      this.error(`Could not load routes: ${String(err)}`)
      return
    }
    this.renderList()
  }

  private renderList(): void {
    const editable = this.canEdit()
    const list = this.el.querySelector('.route-list')!
    if (this.routes.length === 0) {
      list.innerHTML = '<p class="muted">No routes yet. Import a GPX file or plan a walk below.</p>'
      return
    }
    list.replaceChildren(
      ...this.routes.map((r) => {
        const pct = r.distance_m > 0 ? Math.min(100, (100 * r.progress_m) / r.distance_m) : 0
        const card = document.createElement('div')
        card.className = `route-card${r.active ? ' active' : ''}`
        card.innerHTML = `
          <div class="route-head">
            <b></b><span class="muted">${r.source === 'gpx' ? 'GPX' : 'planned'}</span>
            ${r.active ? '<span class="tag">walking this</span>' : ''}
            ${r.completed_at ? '<span class="tag done">done</span>' : ''}
          </div>
          <div class="bar"><div style="width:${pct.toFixed(1)}%"></div></div>
          <div class="muted">${fmtDistance(r.progress_m)} of ${fmtDistance(r.distance_m)} · ${Math.floor(pct)}%</div>
          <div class="route-actions" ${editable ? '' : 'hidden'}>
            ${r.active ? '<button type="button" data-act="off">Stop using</button>' : '<button type="button" data-act="use">Walk this</button>'}
            <button type="button" data-act="reset">Reset progress</button>
            <button type="button" data-act="rename">Rename</button>
            <button type="button" data-act="delete">Delete</button>
          </div>`
        card.querySelector('b')!.textContent = r.name
        card.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
          b.onclick = () => void this.act(r, b.dataset.act!)
        })
        return card
      }),
    )
  }

  private async act(r: Route, action: string): Promise<void> {
    try {
      if (action === 'use') await this.bridge.setActiveRoute(r.id)
      else if (action === 'off') await this.bridge.setActiveRoute(null)
      else if (action === 'reset') {
        if (!confirm(`Start “${r.name}” again from the beginning?`)) return
        await this.bridge.updateRoute(r.id, { progress_m: 0 })
      } else if (action === 'rename') {
        const name = prompt('Route name', r.name)?.trim()
        if (!name) return
        await this.bridge.updateRoute(r.id, { name })
      } else if (action === 'delete') {
        if (!confirm(`Delete “${r.name}” and its progress?`)) return
        await this.bridge.deleteRoute(r.id)
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
      return
    }
    this.onChange()
    await this.reload()
  }

  private setUpTools(): void {
    const gpx = this.el.querySelector<HTMLFormElement>('.gpx-form')!
    gpx.onsubmit = async (e) => {
      e.preventDefault()
      const data = new FormData(gpx)
      const file = data.get('file')
      if (!(file instanceof File) || file.size === 0) return
      try {
        await this.bridge.importGpx(file, String(data.get('name') ?? ''))
        gpx.reset()
        await this.reload()
      } catch (err) {
        this.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    this.map?.remove()
    this.waypoints = []
    this.planned = null
    const map = osmMap(this.el.querySelector<HTMLElement>('.planner-map')!)
    this.map = map
    map.setView([54, 15], 4)
    this.waypointLayer = L.layerGroup().addTo(map)
    this.plannedLayer = L.layerGroup().addTo(map)
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.waypoints.length >= 10) return
      this.waypoints.push(e.latlng)
      this.planned = null
      this.renderPlan()
    })
    this.el.querySelector<HTMLButtonElement>('.plan-clear')!.onclick = () => {
      this.waypoints = []
      this.planned = null
      this.renderPlan()
    }
    this.el.querySelector<HTMLButtonElement>('.plan-locate')!.onclick = () => {
      navigator.geolocation?.getCurrentPosition(
        (p) => map.setView([p.coords.latitude, p.coords.longitude], 15),
        () => this.error('Location not available'),
      )
    }
    this.el.querySelector<HTMLButtonElement>('.plan-go')!.onclick = () => void this.plan()
    const save = this.el.querySelector<HTMLFormElement>('.plan-save')!
    save.onsubmit = (e) => {
      e.preventDefault()
      const use = (e.submitter as HTMLButtonElement | null)?.value === '1'
      void this.save(String(new FormData(save).get('name') ?? ''), use)
    }
    // A route to look at first: the most recent one, if any.
    void this.bridge.routes().then(async (routes) => {
      const recent = routes[0]
      if (!recent) return
      const full = await this.bridge.route(recent.id)
      if (full.points?.length) map.fitBounds(L.latLngBounds(full.points), { padding: [20, 20] })
    }).catch(() => {})
  }

  private renderPlan(): void {
    this.waypointLayer?.clearLayers()
    this.plannedLayer?.clearLayers()
    this.waypoints.forEach((ll, i) => {
      const last = i === this.waypoints.length - 1 && i > 0
      L.circleMarker(ll, {
        radius: 8, weight: 2, color: '#fff', fillOpacity: 1,
        fillColor: i === 0 ? DONE_COLOR : last ? '#e5383b' : ROUTE_COLOR,
      }).bindTooltip(i === 0 ? 'Start' : last ? 'End' : `Stop ${i}`).addTo(this.waypointLayer!)
    })
    if (this.planned) {
      L.polyline(this.planned.points, { color: ROUTE_COLOR, weight: 5 }).addTo(this.plannedLayer!)
    }
    this.el.querySelector<HTMLButtonElement>('.plan-go')!.disabled = this.waypoints.length < 2
    this.el.querySelector<HTMLFormElement>('.plan-save')!.hidden = this.planned === null
    this.el.querySelector('.plan-info')!.textContent = this.planned
      ? `Walking route: ${fmtDistance(this.planned.distance_m)}`
      : this.waypoints.length === 0 ? 'Click the start point.' : this.waypoints.length === 1 ? 'Now click the end point.' : ''
  }

  private async plan(): Promise<void> {
    const info = this.el.querySelector('.plan-info')!
    info.textContent = 'Planning…'
    try {
      this.planned = await this.bridge.planRoute(this.waypoints.map((ll) => [ll.lat, ll.lng]))
      this.renderPlan()
      this.map?.fitBounds(L.latLngBounds(this.planned.points), { padding: [20, 20] })
    } catch (err) {
      info.textContent = ''
      this.error(`No route: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async save(name: string, use: boolean): Promise<void> {
    if (!this.planned || !name.trim()) return
    try {
      const route = await this.bridge.saveRoute(name.trim(), this.planned.points)
      if (use) await this.bridge.setActiveRoute(route.id)
      this.waypoints = []
      this.planned = null
      this.renderPlan()
      this.el.querySelector<HTMLFormElement>('.plan-save')!.reset()
      this.onChange()
      await this.reload()
    } catch (err) {
      this.error(`Could not save: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private error(text: string): void {
    const el = this.el.querySelector<HTMLElement>('.error')!
    el.textContent = text
    el.hidden = false
    setTimeout(() => (el.hidden = true), 6000)
  }
}
