import { describe, expect, it } from 'vitest'
import { ENDED, PAUSED, PLAYING, UNSTARTED, type VideoPlayer, VideoSync, pickRate, resumeAt } from './videosync'

const YT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

describe('pickRate', () => {
  it('picks the nearest rate as a ratio', () => {
    expect(pickRate(4.5 / 4.5, YT_RATES, null)).toBe(1)
    expect(pickRate(3 / 4.5, YT_RATES, null)).toBe(0.75) // 0.67
    expect(pickRate(6 / 4.5, YT_RATES, null)).toBe(1.25) // 1.33
    expect(pickRate(0.1, YT_RATES, null)).toBe(0.25)
    expect(pickRate(5, YT_RATES, null)).toBe(2)
    expect(pickRate(1, [], null)).toBe(1)
  })

  it('does not flip between two rates around the midpoint', () => {
    // Geometric midpoint of 0.75 and 1 is 0.866.
    let rate: number | null = null
    const seen: number[] = []
    for (const desired of [0.85, 0.87, 0.86, 0.88, 0.855, 0.875]) {
      rate = pickRate(desired, YT_RATES, rate)
      seen.push(rate)
    }
    expect(new Set(seen).size).toBe(1)
    // A clear move does switch.
    expect(pickRate(0.97, YT_RATES, 0.75)).toBe(1)
    expect(pickRate(0.76, YT_RATES, 1)).toBe(0.75)
  })

  it('settles on the nearest rate after a ramp-up (belt 4.0, pace 4.5)', () => {
    let rate: number | null = null
    for (let kmh = 1; kmh <= 4.0 + 1e-9; kmh += 0.1) rate = pickRate(kmh / 4.5, YT_RATES, rate)
    expect(rate).toBe(1)
  })

  it('drops a current rate that is no longer offered', () => {
    expect(pickRate(1, [0.5, 1, 2], 1.25)).toBe(1)
  })
})

describe('resumeAt', () => {
  it('resumes where it stopped, unless at the end', () => {
    expect(resumeAt(123.7, 3600)).toBe(123)
    expect(resumeAt(3595, 3600)).toBe(0)
    expect(resumeAt(50, 0)).toBe(50) // duration not known yet
  })
})

class FakePlayer implements VideoPlayer {
  state = UNSTARTED
  time = 0
  rate = 1
  muted = false
  blockUnmuted = false
  log: string[] = []
  playVideo() {
    this.log.push('play')
    if (!(this.blockUnmuted && !this.muted)) this.state = PLAYING
  }
  pauseVideo() {
    this.log.push('pause')
    this.state = PAUSED
  }
  mute() {
    this.muted = true
  }
  isMuted() {
    return this.muted
  }
  getPlayerState() {
    return this.state
  }
  getCurrentTime() {
    return this.time
  }
  getDuration() {
    return 3600
  }
  getPlaybackRate() {
    return this.rate
  }
  setPlaybackRate(r: number) {
    this.log.push(`rate ${r}`)
    this.rate = r
  }
  getAvailablePlaybackRates() {
    return YT_RATES
  }
}

function run(sync: VideoSync, p: FakePlayer, kmh: number, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) {
    sync.update(kmh, 1 / 60)
    if (p.state === PLAYING) p.time += (1 / 60) * p.rate
  }
}

describe('VideoSync', () => {
  it('plays at belt speed / pace and pauses when the belt stops', () => {
    const p = new FakePlayer()
    const saved: number[] = []
    const sync = new VideoSync(p, 4.5, { onPosition: (t) => saved.push(t) })
    run(sync, p, 0, 1)
    expect(p.log).toEqual([]) // belt stopped: nothing happens
    run(sync, p, 3.4, 12) // 3.4 / 4.5 = 0.76
    expect(p.state).toBe(PLAYING)
    expect(p.rate).toBe(0.75)
    expect(saved.length).toBe(1) // saved once after 10 s of playing
    run(sync, p, 0, 1)
    expect(p.state).toBe(PAUSED)
    expect(saved.at(-1)).toBeCloseTo(12 * 0.75, 0) // position saved on pause
    run(sync, p, 4.5, 1)
    expect(p.state).toBe(PLAYING)
    expect(p.rate).toBe(1)
  })

  it('does not keep re-setting the rate while speed wobbles', () => {
    const p = new FakePlayer()
    const sync = new VideoSync(p, 4.5, { onPosition: () => {} })
    for (const kmh of [3.85, 3.92, 3.88, 3.95, 3.86, 3.93]) run(sync, p, kmh, 1)
    expect(p.log.filter((l) => l.startsWith('rate'))).toHaveLength(1)
  })

  it('falls back to muted playback when autoplay with sound is blocked', () => {
    const p = new FakePlayer()
    p.blockUnmuted = true
    let muted = 0
    const sync = new VideoSync(p, 4.5, { onPosition: () => {}, onMutedForAutoplay: () => muted++ })
    run(sync, p, 4, 3)
    expect(p.muted).toBe(true)
    expect(p.state).toBe(PLAYING)
    expect(muted).toBe(1)
  })

  it('leaves an ended video alone', () => {
    const p = new FakePlayer()
    p.state = ENDED
    const sync = new VideoSync(p, 4.5, { onPosition: () => {} })
    run(sync, p, 4, 3)
    expect(p.log.filter((l) => l === 'play')).toHaveLength(0)
  })

  it('follows a pace change', () => {
    const p = new FakePlayer()
    const sync = new VideoSync(p, 4.5, { onPosition: () => {} })
    run(sync, p, 4.5, 1)
    expect(p.rate).toBe(1)
    sync.paceKmh = 3 // this tour was filmed slowly
    run(sync, p, 4.5, 1)
    expect(p.rate).toBe(1.5)
  })
})
