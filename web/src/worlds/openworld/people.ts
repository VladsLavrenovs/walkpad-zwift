/**
 * NPCs and quests in the open world: draws the people near you, marks quest givers with "!",
 * lets you talk (F), take a quest (F) or not (N), tracks quests while you walk and finishes them
 * when you get there, and shows the quest log (J). Everything finishes by walking; keys are only
 * needed to talk. View-only pages see the people but cannot talk.
 */

import * as THREE from 'three'
import type { BridgeClient, Quest } from '../../bridge'
import type { Continent, OwBiome } from './continent'
import { type Npc, NPC_HEIGHT_M, makeNpcs, npcAt } from './npcs'
import { NpcSprites, type NpcDraw } from './npcsprites'
import type { Progress } from './progress'
import { type QuestOffer, offerFor, questFraction, questStep, questTarget } from './quests'

const DRAW_M = 160
const TALK_M = 7
const SYNC_S = 15

const GREETINGS = [
  'Safe travels!', 'Lovely day for a walk.', 'Mind the roads after dark.', 'Come back any time.',
  'The baker has fresh bread today.', 'They say the old ruins glow at night.',
]

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

export class People {
  readonly sprites = new NpcSprites()
  private readonly bridge: BridgeClient
  private readonly canEdit: () => boolean
  private readonly progress: Progress
  private readonly prompt: HTMLDivElement
  private readonly dialog: HTMLDivElement
  private readonly journal: HTMLDivElement
  private c: Continent | null = null
  private worldId: number | null = null
  private npcs: Npc[] = []
  private quests: Quest[] = []
  private near: Npc | null = null
  private talking: { npc: Npc; offer: QuestOffer | null } | null = null
  private marks = new THREE.Group()
  private markTexture: THREE.CanvasTexture
  private markMaterial: THREE.SpriteMaterial
  private syncIn = SYNC_S
  private dirty = new Set<string>()
  private finishing = new Set<string>()
  tracked: string | null = null

  constructor(root: HTMLElement, scene: THREE.Scene, bridge: BridgeClient, canEdit: () => boolean, progress: Progress) {
    this.bridge = bridge
    this.canEdit = canEdit
    this.progress = progress
    scene.add(this.sprites.group, this.marks)
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffd34d'
    ctx.strokeStyle = '#4a3200'
    ctx.lineWidth = 5
    ctx.font = 'bold 54px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeText('!', 32, 34)
    ctx.fillText('!', 32, 34)
    this.markTexture = new THREE.CanvasTexture(c)
    this.markTexture.colorSpace = THREE.SRGBColorSpace
    this.markMaterial = new THREE.SpriteMaterial({ map: this.markTexture, depthTest: true, fog: true })
    this.prompt = div(root, 'ow-prompt')
    this.dialog = div(root, 'ow-dialog')
    this.journal = div(root, 'ow-journal')
  }

  async start(c: Continent, worldId: number): Promise<void> {
    this.c = c
    this.worldId = worldId
    this.npcs = makeNpcs(c)
    try {
      this.quests = await this.bridge.quests(worldId)
    } catch {
      this.quests = [] // an older bridge: people, but no quests
    }
    this.tracked = this.active()[0]?.id ?? null
    this.renderJournal()
  }

  active(): Quest[] {
    return this.quests.filter((q) => q.state === 'active')
  }

  /** The tracked quest's destination (for the compass and the minimap). */
  target(): { x: number; z: number; name: string } | null {
    const q = this.quests.find((x) => x.id === this.tracked && x.state === 'active')
    return q && this.c ? questTarget(this.c, q) : null
  }

  private offer(npc: Npc): QuestOffer | null {
    if (npc.role !== 'giver' || !this.c) return null
    const mine = this.quests.filter((q) => q.id.startsWith(`${npc.id}:`))
    if (mine.some((q) => q.state === 'active')) return null
    return offerFor(this.c, npc, mine.length)
  }

  /** Every frame: people near (x, z), talking, quests. `t` is seconds (any clock all pages share). */
  tick(dt: number, t: number, x: number, z: number, height: (x: number, z: number) => number,
    metres: number, biome: OwBiome | null, light: THREE.Color): void {
    if (!this.c) return
    const draws: NpcDraw[] = []
    let nearest: Npc | null = null
    let nearestD = TALK_M
    for (const m of [...this.marks.children]) this.marks.remove(m)
    for (const npc of this.npcs) {
      const home = npc.path[0]
      if (Math.abs(home[0] - x) > DRAW_M + 150 || Math.abs(home[1] - z) > DRAW_M + 150) continue
      const at = npcAt(npc, t)
      const d = Math.hypot(at.x - x, at.z - z)
      if (d > DRAW_M) continue
      const y = height(at.x, at.z)
      const frame = at.moving ? 1 + (Math.floor(t * npc.speed * 2.2 + npc.offset) % 4) : 0
      draws.push({ look: npc.look, x: at.x, y, z: at.z, heading: at.heading, frame })
      if (npc.role === 'giver' && this.offer(npc)) {
        const mark = new THREE.Sprite(this.markMaterial)
        mark.position.set(at.x, y + NPC_HEIGHT_M + 0.55 + Math.sin(t * 2.5) * 0.08, at.z)
        mark.scale.set(0.7, 0.7, 0.7)
        this.marks.add(mark)
      }
      if (d < nearestD) {
        nearest = npc
        nearestD = d
      }
    }
    this.sprites.set(draws)
    this.sprites.setLight(light)
    this.near = this.canEdit() ? nearest : null
    if (this.talking && (!this.near || this.near.id !== this.talking.npc.id)) this.closeDialog()
    this.renderPrompt()
    this.stepQuests(dt, x, z, metres, biome)
  }

  private renderPrompt(): void {
    const npc = this.near
    if (!npc || this.talking) {
      this.prompt.hidden = true
      return
    }
    const quest = this.offer(npc) ? ' (has a task for you)' : ''
    this.prompt.hidden = false
    this.prompt.innerHTML = `<b>F</b> talk to ${escapeHtml(npc.name)}, the ${escapeHtml(npc.trade)}${quest}`
  }

  /** F: talk, or take the offered quest. N: not now. J: the quest log. */
  key(code: string): boolean {
    if (code === 'KeyJ') {
      this.journal.hidden = !this.journal.hidden
      this.renderJournal()
      return true
    }
    if (!this.canEdit()) return false
    if (code === 'KeyF') {
      if (this.talking?.offer) void this.accept(this.talking.offer)
      else if (this.talking) this.closeDialog()
      else if (this.near) this.openDialog(this.near)
      return true
    }
    if (code === 'KeyN' && this.talking) {
      this.closeDialog()
      return true
    }
    return false
  }

  private openDialog(npc: Npc): void {
    const offer = this.offer(npc)
    this.talking = { npc, offer }
    const r = Math.abs(Math.sin(npc.look * 999 + this.quests.length))
    const text = offer ? offer.text : GREETINGS[Math.floor(r * GREETINGS.length)]
    this.dialog.hidden = false
    this.dialog.innerHTML = `
      <div class="ow-who">${escapeHtml(npc.name)} <span class="muted">· the ${escapeHtml(npc.trade)} of ${escapeHtml(npc.homeName)}</span></div>
      <p>“${escapeHtml(text)}”</p>
      ${offer
        ? `<div class="ow-offer">Quest: <b>${escapeHtml(offer.title)}</b> · ${offer.xp} XP</div>
           <div class="ow-choices"><button type="button" data-a="yes"><b>F</b> I'll do it</button>
           <button type="button" data-a="no"><b>N</b> Not now</button></div>`
        : '<div class="ow-choices"><button type="button" data-a="no"><b>F</b> Goodbye</button></div>'}`
    this.dialog.querySelector<HTMLButtonElement>('[data-a="yes"]')?.addEventListener('click', () => offer && void this.accept(offer))
    this.dialog.querySelector<HTMLButtonElement>('[data-a="no"]')?.addEventListener('click', () => this.closeDialog())
    this.prompt.hidden = true
  }

  private closeDialog(): void {
    this.talking = null
    this.dialog.hidden = true
  }

  private async accept(offer: QuestOffer): Promise<void> {
    if (this.worldId === null) return
    this.closeDialog()
    try {
      const q = await this.bridge.takeQuest(this.worldId, { id: offer.id, title: offer.title, kind: offer.kind, data: offer.data, xp: offer.xp })
      this.quests.push(q)
      this.tracked = q.id
      this.progress.toast(`New quest: ${q.title}`, 'achievement')
      this.renderJournal()
    } catch (err) {
      this.progress.toast(err instanceof Error ? err.message : String(err), 'land')
    }
  }

  private stepQuests(dt: number, x: number, z: number, metres: number, biome: OwBiome | null): void {
    if (!this.c || this.worldId === null || !this.canEdit()) return
    for (const q of this.active()) {
      if (this.finishing.has(q.id)) continue
      const next = questStep(this.c, q, { x, z, metres, biome })
      if (next.progress > q.progress + 0.01) {
        q.progress = next.progress
        this.dirty.add(q.id)
      }
      if (next.done) void this.finish(q)
    }
    this.syncIn -= dt
    if (this.syncIn <= 0) {
      this.syncIn = SYNC_S
      for (const id of this.dirty) {
        const q = this.quests.find((x) => x.id === id)
        if (q) void this.bridge.updateQuest(this.worldId, id, { progress: q.progress }).catch(() => {})
      }
      this.dirty.clear()
      if (!this.journal.hidden) this.renderJournal()
    }
  }

  private async finish(q: Quest): Promise<void> {
    if (this.worldId === null) return
    this.finishing.add(q.id)
    try {
      const r = await this.bridge.updateQuest(this.worldId, q.id, { progress: q.progress, state: 'done' })
      Object.assign(q, r.quest)
      this.progress.toast(`Quest done: ${q.title} · +${q.xp} XP`, 'level')
      this.progress.update(r.profile)
      if (this.tracked === q.id) this.tracked = this.active()[0]?.id ?? null
      this.renderJournal()
    } catch {
      // try again on a later frame
    } finally {
      this.finishing.delete(q.id)
    }
  }

  private async abandon(id: string): Promise<void> {
    if (this.worldId === null) return
    try {
      const r = await this.bridge.updateQuest(this.worldId, id, { state: 'abandoned' })
      const q = this.quests.find((x) => x.id === id)
      if (q) Object.assign(q, r.quest)
      if (this.tracked === id) this.tracked = this.active()[0]?.id ?? null
      this.renderJournal()
    } catch {
      /* keep it */
    }
  }

  private renderJournal(): void {
    if (this.journal.hidden) return
    const active = this.active()
    const done = this.quests.filter((q) => q.state === 'done').length
    const edit = this.canEdit()
    this.journal.innerHTML = `<div class="ow-who">Quests <span class="muted">· ${done} done · J to close</span></div>` + (active.length
      ? active.map((q) => `
        <div class="ow-quest${q.id === this.tracked ? ' tracked' : ''}" data-id="${escapeHtml(q.id)}">
          <b>${escapeHtml(q.title)}</b> <span class="muted">${q.xp} XP</span>
          <div class="ow-qbar"><i style="width:${(questFraction(q) * 100).toFixed(0)}%"></i></div>
          ${edit ? `<span class="ow-qactions"><button type="button" data-a="track">${q.id === this.tracked ? 'tracked' : 'track'}</button>
            <button type="button" data-a="drop">drop</button></span>` : ''}
        </div>`).join('')
      : '<p class="muted">No quests. Look for people with a <b style="color:#ffd34d">!</b> in villages and towns.</p>')
    this.journal.querySelectorAll<HTMLElement>('.ow-quest').forEach((el) => {
      const id = el.dataset.id!
      el.querySelector<HTMLButtonElement>('[data-a="track"]')?.addEventListener('click', () => {
        this.tracked = id
        this.renderJournal()
      })
      el.querySelector<HTMLButtonElement>('[data-a="drop"]')?.addEventListener('click', () => void this.abandon(id))
    })
  }

  dispose(): void {
    this.sprites.dispose()
    this.markTexture.dispose()
    this.markMaterial.dispose()
    this.prompt.remove()
    this.dialog.remove()
    this.journal.remove()
  }
}

function div(root: HTMLElement, className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  el.hidden = true
  root.append(el)
  return el
}
