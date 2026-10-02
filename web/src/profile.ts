/** Profile page (#/profile): the walker's level, where the XP came from, and the achievements. */

import type { Achievement, BridgeClient, GameProfile } from './bridge'
import { fmtDate } from './format'

const METRIC_UNIT: Record<string, string> = {
  distance_km: 'km', longest_session_km: 'km', longest_streak_days: 'days',
}

/** "3.4 / 10 km", "2 / 5". */
export function progressText(a: Achievement): string {
  const unit = METRIC_UNIT[a.metric]
  const fmt = (v: number) => (unit === 'km' ? (Math.round(v * 10) / 10).toString() : Math.floor(v).toString())
  return `${fmt(a.progress)} / ${fmt(a.target)}${unit ? ` ${unit}` : ''}`
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

export class ProfilePage {
  readonly el: HTMLElement
  private readonly bridge: BridgeClient

  constructor(parent: HTMLElement, bridge: BridgeClient) {
    this.bridge = bridge
    this.el = document.createElement('section')
    this.el.className = 'stats-page profile-page'
    this.el.hidden = true
    parent.append(this.el)
  }

  async show(): Promise<void> {
    this.el.hidden = false
    this.el.innerHTML = '<p class="muted">Loading…</p>'
    try {
      this.render(await this.bridge.gameProfile())
    } catch (err) {
      this.el.innerHTML = `<header><h1>Profile</h1><a href="#/" class="link">Back to walking</a></header>
        <p class="error">Could not load the profile: ${escapeHtml(String(err))}</p>`
    }
  }

  hide(): void {
    this.el.hidden = true
  }

  private render(p: GameProfile): void {
    const span = Math.max(1, p.next_level_xp - p.level_start_xp)
    const into = p.xp - p.level_start_xp
    const done = p.achievements.filter((a) => a.unlocked_at !== null)
    const sorted = [...p.achievements].sort((a, b) =>
      Number(b.unlocked_at !== null) - Number(a.unlocked_at !== null) || (b.unlocked_at ?? 0) - (a.unlocked_at ?? 0)
      || b.progress / b.target - a.progress / a.target)
    const m = p.metrics
    this.el.innerHTML = `
      <header><h1>Profile</h1><a href="#/" class="link">Back to walking</a></header>
      <div class="pf-level">
        <span class="pf-lv">Level ${p.level}</span>
        <div class="bar pf-bar"><div style="width:${Math.min(100, (100 * into) / span).toFixed(1)}%"></div></div>
        <span class="muted">${into} / ${span} XP to level ${p.level + 1} · ${p.xp} XP in total</span>
      </div>
      <div class="tiles">
        <div class="tile"><span class="label">From walking</span><span class="big">${p.breakdown.walking}</span>
          <span class="muted">1 XP per 10 m, every walk</span></div>
        <div class="tile"><span class="label">From discoveries</span><span class="big">${p.breakdown.discoveries}</span>
          <span class="muted">${plural(m.places, 'place')} · ${plural(m.provinces, 'province')} · ${plural(m.biomes, 'kind')} of land</span></div>
        <div class="tile"><span class="label">From quests</span><span class="big">${p.breakdown.quests ?? 0}</span>
          <span class="muted">${plural(m.quests ?? 0, 'quest')} done for the people of the Open world</span></div>
        <div class="tile"><span class="label">From achievements</span><span class="big">${p.breakdown.achievements}</span>
          <span class="muted">${done.length} of ${p.achievements.length} unlocked</span></div>
      </div>
      <h2>Achievements</h2>
      <div class="pf-achievements">
        ${sorted.map((a) => `
          <div class="pf-ach${a.unlocked_at !== null ? ' done' : ''}">
            <b>${a.unlocked_at !== null ? '★' : '☆'} ${escapeHtml(a.title)}</b>
            <span class="muted">${escapeHtml(a.description)} · ${a.xp} XP</span>
            ${a.unlocked_at !== null
              ? `<span class="muted">unlocked ${fmtDate(a.unlocked_at)}</span>`
              : `<div class="bar"><div style="width:${((100 * a.progress) / a.target).toFixed(1)}%"></div></div>
                 <span class="muted">${progressText(a)}</span>`}
          </div>`).join('')}
      </div>
      <p class="muted">XP and achievements belong to you, not to a world: they carry over to every world you walk in,
        and deleting a world keeps them. Discoveries count in the Open world.</p>`
  }
}
