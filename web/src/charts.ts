/**
 * Minimal SVG bar chart for one series (distance per period): no legend (the title names it),
 * one hue, 4 px rounded tops anchored to the baseline, 2 px gaps, recessive grid, a hover/focus
 * tooltip per bar, and a table view.
 */

export interface Bar {
  label: string // axis label, short
  title: string // tooltip heading, long
  value: number
  detail?: string // extra tooltip line
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const H = 220
const PAD = { top: 12, right: 8, bottom: 26, left: 44 }
const GAP = 2
const RADIUS = 4

/** A "nice" axis maximum and step (1, 2, 2.5, 5 x 10^n) for 3-5 gridlines. */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.25 }
  const rough = max / 4
  const mag = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag
  return { top: Math.ceil(max / step) * step, step }
}

/** Rounded top corners only; square at the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** `width`: the container's width in CSS px, so text and marks are drawn at 1:1 scale. */
export function barChart(
  bars: Bar[],
  fmtValue: (v: number) => string,
  axisValue: (v: number) => string,
  width: number,
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'chart'
  const W = Math.max(280, Math.round(width))
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const { top, step } = niceScale(Math.max(0, ...bars.map((b) => b.value)))
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' })
  svg.setAttribute('aria-label', 'Bar chart; use the table view for exact values')
  const yOf = (v: number) => PAD.top + innerH - (v / top) * innerH

  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = yOf(v)
    svg.append(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, class: v === 0 ? 'axis' : 'grid' }))
    const t = el('text', { x: PAD.left - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' })
    t.textContent = axisValue(v)
    svg.append(t)
  }

  const band = innerW / Math.max(1, bars.length)
  const labelEvery = Math.ceil(bars.length / Math.max(1, Math.floor(innerW / 44)))
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.hidden = true

  bars.forEach((b, i) => {
    const x = PAD.left + i * band + GAP / 2
    const w = Math.max(1, band - GAP)
    const y = yOf(b.value)
    const h = PAD.top + innerH - y
    if (b.value > 0) svg.append(el('path', { d: barPath(x, y, w, h), class: 'bar' }))
    if (i % labelEvery === 0) {
      const t = el('text', { x: x + w / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' })
      t.textContent = b.label
      svg.append(t)
    }
    // Hit target: the whole band, taller than the bar.
    const hit = el('rect', { x: x - GAP / 2, y: PAD.top, width: band, height: innerH, class: 'hit', tabindex: 0 })
    hit.setAttribute('aria-label', `${b.title}: ${fmtValue(b.value)}`)
    const show = () => {
      tip.innerHTML = `<b>${b.title}</b><span>${fmtValue(b.value)}</span>${b.detail ? `<span>${b.detail}</span>` : ''}`
      tip.hidden = false
      const rootBox = root.getBoundingClientRect()
      const box = hit.getBoundingClientRect()
      tip.style.left = `${box.left - rootBox.left + box.width / 2}px`
      tip.style.top = `${box.top - rootBox.top}px`
      hit.classList.add('hover')
    }
    const hide = () => {
      tip.hidden = true
      hit.classList.remove('hover')
    }
    hit.addEventListener('pointerenter', show)
    hit.addEventListener('pointerleave', hide)
    hit.addEventListener('focus', show)
    hit.addEventListener('blur', hide)
    svg.append(hit)
  })

  const table = document.createElement('table')
  table.className = 'chart-table'
  table.hidden = true
  table.innerHTML =
    '<thead><tr><th>Period</th><th>Distance</th><th>Details</th></tr></thead><tbody>' +
    bars.map((b) => `<tr><td>${b.title}</td><td>${fmtValue(b.value)}</td><td>${b.detail ?? ''}</td></tr>`).join('') +
    '</tbody>'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'link'
  toggle.textContent = 'Table view'
  toggle.onclick = () => {
    table.hidden = !table.hidden
    svg.style.display = table.hidden ? '' : 'none'
    toggle.textContent = table.hidden ? 'Table view' : 'Chart view'
  }

  root.append(svg, tip, table, toggle)
  return root
}
