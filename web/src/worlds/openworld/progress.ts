/**
 * Progression in the open world: noticing first visits (places, provinces, kinds of land), sending
 * them to the bridge (which gives the XP), the XP bar, and toasts for discoveries, level-ups and
 * achievements. The bridge owns the numbers; this only shows them. View-only pages never send.
 */

import type { BridgeClient, DiscoveryKind, GameProfile } from '../../bridge'
import { type Continent, OW_BIOMES, OW_BIOME_NAMES, type OwWeights, type PlaceKind, cellAt } from './continent'

/** How close counts as having been to a place, metres. */
export const DISCOVER_RADIUS: Record<PlaceKind, number> = {
  city: 130, village: 80, castle: 70, ruins: 50, windmill: 40, waterfall: 60,
}

export interface Found {
  kind: DiscoveryKind
  key: string
  label: string
}

export const knownKey = (kind: string, key: string) => `${kind}:${key}`

/** What is here that has not been found yet: places in reach, the province, the kind of land. */
export function discoveriesAt(c: Continent, x: number, z: number, w: OwWeights, known: Set<string>): Found[] {
  const out: Found[] = []
  for (const p of c.places) {
    if (known.has(knownKey('place', p.id))) continue
    if (Math.hypot(p.x - x, p.z - z) <= DISCOVER_RADIUS[p.kind]) out.push({ kind: 'place', key: p.id, label: p.name })
  }
  const prov = c.province[cellAt(c, x, z)]
  if (prov >= 0 && !known.has(knownKey('province', String(prov)))) {
    out.push({ kind: 'province', key: String(prov), label: c.provinces[prov]?.name ?? 'a new province' })
  }
  const biome = OW_BIOMES.reduce((a, b) => (w[b] > w[a] ? b : a))
  if (w[biome] > 0.6 && !known.has(knownKey('biome', biome))) out.push({ kind: 'biome', key: biome, label: OW_BIOME_NAMES[biome] })
  return out
}

/** Level ups and achievements between two profiles (for toasts). */
export function profileNews(before: GameProfile | null, after: GameProfile): string[] {
  if (!before) return []
  const news: string[] = []
  if (after.level > before.level) news.push(`Level ${after.level}!`)
  const had = new Set(before.achievements.filter((a) => a.unlocked_at !== null).map((a) => a.id))
  for (const a of after.achievements) {
    if (a.unlocked_at !== null && !had.has(a.id)) news.push(`Achievement: ${a.title} · +${a.xp} XP`)
  }
  return news
}

const POLL_S = 20
const CHECK_S = 0.5

export class Progress {
  private readonly bridge: BridgeClient
  private readonly canEdit: () => boolean
  private readonly bar: HTMLDivElement
  private readonly toasts: HTMLDivElement
  private worldId: number | null = null
  private known = new Set<string>()
  private ready = false
  private profile: GameProfile | null = null
  private pollIn = 0
  private checkIn = 0
  private sending = false

  constructor(root: HTMLElement, bridge: BridgeClient, canEdit: () => boolean) {
    this.bridge = bridge
    this.canEdit = canEdit
    this.bar = document.createElement('div')
    this.bar.className = 'ow-xp'
    this.bar.hidden = true
    this.bar.innerHTML = '<b class="ow-lv"></b><span class="ow-xpbar"><i></i></span><span class="ow-xpnum"></span>'
    this.toasts = document.createElement('div')
    this.toasts.className = 'ow-toasts'
    root.append(this.bar, this.toasts)
  }

  /** A world was loaded: what was already found there, and the walker's profile. */
  async start(worldId: number): Promise<void> {
    this.worldId = worldId
    this.ready = false
    try {
      const [found, profile] = await Promise.all([this.bridge.discoveries(worldId), this.bridge.gameProfile()])
      if (this.worldId !== worldId) return
      this.known = new Set(found.map((d) => knownKey(d.kind, d.key)))
      this.show(profile)
      this.ready = true
    } catch {
      // An older bridge without progression: the world still works, without XP.
      this.bar.hidden = true
    }
  }

  tick(dt: number, c: Continent, x: number, z: number, w: OwWeights): void {
    if (!this.ready || this.worldId === null) return
    this.pollIn -= dt
    if (this.pollIn <= 0) {
      this.pollIn = POLL_S
      void this.bridge.gameProfile().then((p) => this.show(p)).catch(() => {})
    }
    this.checkIn -= dt
    if (this.checkIn > 0 || this.sending || !this.canEdit()) return
    this.checkIn = CHECK_S
    const found = discoveriesAt(c, x, z, w, this.known)
    if (found.length) void this.send(this.worldId, found)
  }

  private async send(worldId: number, found: Found[]): Promise<void> {
    this.sending = true
    for (const f of found) this.known.add(knownKey(f.kind, f.key))
    try {
      const r = await this.bridge.addDiscoveries(worldId, found.map(({ kind, key }) => ({ kind, key })))
      for (const d of r.new) {
        const f = found.find((x) => x.kind === d.kind && x.key === d.key)
        const what = d.kind === 'province' ? 'Entered' : 'Discovered'
        this.toast(`${what} ${f?.label ?? d.key} · +${d.xp} XP`, d.kind === 'place' ? 'place' : 'land')
      }
      this.show(r.profile)
    } catch {
      for (const f of found) this.known.delete(knownKey(f.kind, f.key)) // try again later
      this.checkIn = 10
    } finally {
      this.sending = false
    }
  }

  /** A fresh profile from the bridge (e.g. after a quest): bar and news. */
  update(p: GameProfile): void {
    this.show(p)
  }

  private show(p: GameProfile): void {
    for (const line of profileNews(this.profile, p)) this.toast(line, line.startsWith('Level') ? 'level' : 'achievement')
    this.profile = p
    const span = Math.max(1, p.next_level_xp - p.level_start_xp)
    const into = p.xp - p.level_start_xp
    this.bar.hidden = false
    this.bar.querySelector('.ow-lv')!.textContent = `Lv ${p.level}`
    this.bar.querySelector<HTMLElement>('.ow-xpbar i')!.style.width = `${Math.min(100, (100 * into) / span).toFixed(1)}%`
    this.bar.querySelector('.ow-xpnum')!.textContent = `${into} / ${span} XP`
    this.bar.title = `${p.xp} XP in total (walking ${p.breakdown.walking}, discoveries ${p.breakdown.discoveries}, achievements ${p.breakdown.achievements})`
  }

  toast(text: string, kind: string): void {
    const el = document.createElement('div')
    el.className = `ow-toast ow-toast-${kind}`
    el.textContent = text
    this.toasts.append(el)
    setTimeout(() => el.remove(), 6000)
  }
}
