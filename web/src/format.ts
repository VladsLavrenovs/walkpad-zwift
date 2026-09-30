/** Display formatting. */

export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.floor(m)} m`
  return `${(m / 1000).toFixed(2)} km`
}

export function fmtDuration(s: number): string {
  const total = Math.max(0, Math.floor(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const mm = String(m).padStart(h ? 2 : 1, '0')
  const ss = String(sec).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function fmtSpeed(kmh: number): string {
  return kmh.toFixed(1)
}

export function fmtDate(unixS: number): string {
  return new Date(unixS * 1000).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}
