/** Stats page: streaks and bests, distance per day/week/month, and the session history. */

import type { BridgeClient, Best, Session, Stats } from './bridge'
import { type Bar, barChart } from './charts'
import { fmtDate, fmtDistance, fmtDuration, fmtSpeed } from './format'

type Period = 'daily' | 'weekly' | 'monthly'

const PERIOD_LABEL: Record<Period, string> = { daily: 'Day', weekly: 'Week', monthly: 'Month' }

function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

function axisKm(m: number): string {
  if (m === 0) return '0'
  return m >= 1000 ? `${+(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

function shortDate(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, opts)
}

export function barsFor(stats: Stats, period: Period): Bar[] {
  const detail = (p: { sessions: number; duration_s: number }) =>
    `${p.sessions} session${p.sessions === 1 ? '' : 's'} · ${fmtDuration(p.duration_s)}`
  if (period === 'daily')
    return stats.daily.map((d) => ({
      label: shortDate(d.date, { weekday: 'short' }),
      title: shortDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' }),
      value: d.distance_m,
      detail: detail(d),
    }))
  if (period === 'weekly')
    return stats.weekly.map((w) => ({
      label: shortDate(w.week_start, { day: 'numeric', month: 'short' }),
      title: `Week of ${shortDate(w.week_start, { day: 'numeric', month: 'long' })}`,
      value: w.distance_m,
      detail: detail(w),
    }))
  return stats.monthly.map((m) => ({
    label: shortDate(`${m.month}-15`, { month: 'short' }),
    title: shortDate(`${m.month}-15`, { month: 'long', year: 'numeric' }),
    value: m.distance_m,
    detail: detail(m),
  }))
}

function bestRow(label: string, best: Best | null, fmt: (v: number) => string): string {
  const value = best ? fmt(best.value) : '—'
  const when = best ? shortDate(best.date, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  return `<tr><th>${label}</th><td>${value}</td><td class="muted">${when}</td></tr>`
}

export class StatsPage {
  readonly el: HTMLElement
  private period: Period = 'daily'
  private stats: Stats | null = null
  private readonly bridge: BridgeClient
  private chartWidth = 0
  private readonly resize = new ResizeObserver(() => {
    const slot = this.el.querySelector<HTMLElement>('.chart-slot')
    if (slot && !this.el.hidden && Math.abs(slot.clientWidth - this.chartWidth) > 4) this.renderChart()
  })

  constructor(parent: HTMLElement, bridge: BridgeClient) {
    this.bridge = bridge
    this.el = document.createElement('section')
    this.el.className = 'stats-page'
    this.el.hidden = true
    parent.append(this.el)
    this.resize.observe(this.el)
  }

  async show(): Promise<void> {
    this.el.hidden = false
    this.el.innerHTML = '<p class="muted">Loading…</p>'
    try {
      const [stats, sessions] = await Promise.all([this.bridge.stats(), this.bridge.sessions(100)])
      this.stats = stats
      this.render(stats, sessions.sessions, sessions.total)
    } catch (err) {
      this.el.innerHTML = `<p class="error">Could not load stats: ${String(err)}</p>`
    }
  }

  hide(): void {
    this.el.hidden = true
  }

  private render(stats: Stats, sessions: Session[], total: number): void {
    const s = stats.streaks
    const pb = stats.personal_bests
    const all = stats.all_time
    this.el.innerHTML = `
      <header><h1>Stats</h1><a href="#/" class="link">Back to walking</a></header>
      <div class="tiles">
        <div class="tile"><span class="label">Current streak</span><span class="big">${s.current_days}</span>
          <span class="muted">day${s.current_days === 1 ? '' : 's'}${s.walked_today ? ' · walked today' : ''}</span></div>
        <div class="tile"><span class="label">Longest streak</span><span class="big">${s.longest_days}</span>
          <span class="muted">days (≥ ${Math.round(s.active_day_min_s / 60)} min each)</span></div>
        <div class="tile"><span class="label">All time</span><span class="big">${fmtKm(all.distance_m)}</span>
          <span class="muted">${all.sessions} session${all.sessions === 1 ? '' : 's'} · ${fmtDuration(all.duration_s)}</span></div>
      </div>
      <h2>Distance</h2>
      <div class="segmented" role="tablist"></div>
      <div class="chart-slot"></div>
      <h2>Personal bests</h2>
      <table class="bests">
        ${bestRow('Longest walk', pb.longest_distance_m, fmtKm)}
        ${bestRow('Longest time', pb.longest_duration_s, fmtDuration)}
        ${bestRow('Most steps', pb.most_steps, (v) => v.toLocaleString())}
        ${bestRow('Fastest average (5+ min)', pb.fastest_avg_speed_kmh, (v) => `${fmtSpeed(v)} km/h`)}
        ${bestRow('Best day', pb.best_day_distance_m, fmtKm)}
      </table>
      <h2>History <span class="muted">(${total} session${total === 1 ? '' : 's'})</span></h2>
      <div class="history-wrap"><table class="history">
        <thead><tr><th>When</th><th>Time</th><th>Distance</th><th>Steps</th><th>Avg</th><th>Max</th></tr></thead>
        <tbody>${
          sessions.length
            ? sessions
                .map(
                  (x) => `<tr><td>${fmtDate(x.started_at)}${x.ended_at === null ? ' <em>(now)</em>' : ''}</td>
                  <td>${fmtDuration(x.duration_s)}</td><td>${fmtDistance(x.distance_m)}</td>
                  <td>${x.steps ?? '—'}</td><td>${fmtSpeed(x.avg_speed_kmh)}</td><td>${fmtSpeed(x.max_speed_kmh)}</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="6" class="muted">No sessions yet. Walk!</td></tr>'
        }</tbody></table></div>`
    const tabs = this.el.querySelector<HTMLDivElement>('.segmented')!
    for (const p of Object.keys(PERIOD_LABEL) as Period[]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.role = 'tab'
      b.textContent = PERIOD_LABEL[p]
      b.onclick = () => {
        this.period = p
        this.renderChart()
      }
      tabs.append(b)
    }
    this.renderChart()
  }

  private renderChart(): void {
    if (!this.stats) return
    this.el.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b, i) => {
      const selected = (Object.keys(PERIOD_LABEL) as Period[])[i] === this.period
      b.setAttribute('aria-selected', String(selected))
    })
    const slot = this.el.querySelector<HTMLElement>('.chart-slot')!
    this.chartWidth = slot.clientWidth
    slot.replaceChildren(barChart(barsFor(this.stats, this.period), fmtKm, axisKm, this.chartWidth || 800))
  }
}
