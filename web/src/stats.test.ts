import { describe, expect, it } from 'vitest'
import type { Stats } from './bridge'
import { barsFor } from './stats'

const zero = { sessions: 0, distance_m: 0, duration_s: 0, steps: 0 }
const stats: Stats = {
  today: '2026-09-30',
  daily: [{ date: '2026-09-29', ...zero }, { date: '2026-09-30', sessions: 2, distance_m: 1500, duration_s: 1200, steps: 2000 }],
  weekly: [{ week_start: '2026-09-28', sessions: 2, distance_m: 1500, duration_s: 1200, steps: 2000 }],
  monthly: [{ month: '2026-09', sessions: 2, distance_m: 1500, duration_s: 1200, steps: 2000 }],
  streaks: { current_days: 1, longest_days: 1, walked_today: true, active_day_min_s: 60 },
  personal_bests: { longest_distance_m: null, longest_duration_s: null, most_steps: null, fastest_avg_speed_kmh: null, best_day_distance_m: null },
  all_time: { sessions: 2, distance_m: 1500, duration_s: 1200, steps: 2000 },
}

describe('barsFor', () => {
  it('maps each period to one bar per bucket', () => {
    const daily = barsFor(stats, 'daily')
    expect(daily.map((b) => b.value)).toEqual([0, 1500])
    expect(daily[1].detail).toBe('2 sessions · 20:00')
    expect(barsFor(stats, 'weekly')[0].title).toContain('Week of')
    expect(barsFor(stats, 'monthly')).toHaveLength(1)
  })
})
