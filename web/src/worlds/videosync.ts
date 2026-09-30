/**
 * Drives a video player from the belt: playback rate = belt speed / the video's walking pace,
 * snapped to a rate the player offers, with hysteresis; pause when the belt stops, play when
 * it moves; report the position now and then so the next session resumes there.
 *
 * Pure logic over a small player interface, so it is testable without YouTube.
 */

/** YouTube player states (YT.PlayerState). */
export const UNSTARTED = -1
export const ENDED = 0
export const PLAYING = 1
export const PAUSED = 2
export const BUFFERING = 3
export const CUED = 5

export interface VideoPlayer {
  playVideo(): void
  pauseVideo(): void
  mute(): void
  isMuted(): boolean
  getPlayerState(): number
  getCurrentTime(): number
  getDuration(): number
  getPlaybackRate(): number
  setPlaybackRate(rate: number): void
  getAvailablePlaybackRates(): number[]
}

/** Switch only when another rate is closer by this much (log scale: 0.04 = about 4 %).
 * YouTube's rates are 0.25 apart, so 8 % kept a rate far past the midpoint (seen: belt 4.0,
 * pace 4.5, stuck at 0.75x after ramping up although 1x is closer); 4 % still absorbs the
 * pad's 0.1 km/h speed wobble. */
export const RATE_HYSTERESIS = 0.04
const MOVING_KMH = 0.05
const PLAY_RETRY_S = 1.5
const SAVE_EVERY_S = 10

/** The available rate to use for `desired`, sticking with `current` unless another rate is
 * clearly (by `margin` in log space) closer. Rates are compared as ratios, so 0.5 vs 1 is as
 * far apart as 1 vs 2. */
export function pickRate(desired: number, available: number[], current: number | null, margin = RATE_HYSTERESIS): number {
  const rates = available.filter((r) => r > 0)
  if (rates.length === 0) return 1
  const dist = (r: number) => Math.abs(Math.log(desired / r))
  const nearest = rates.reduce((best, r) => (dist(r) < dist(best) ? r : best))
  if (current === null || !rates.includes(current)) return nearest
  return dist(current) - dist(nearest) > margin ? nearest : current
}

export interface VideoSyncEvents {
  /** Where playback is, for resuming next time (called every ~10 s while playing, and on pause). */
  onPosition(seconds: number): void
  /** The browser refused to autoplay with sound; the video now plays muted. */
  onMutedForAutoplay?(): void
}

export class VideoSync {
  paceKmh: number
  rate: number | null = null
  private playRequestedAt: number | null = null
  private sincePlaying = 0
  private clock = 0
  private wasPlaying = false
  private readonly player: VideoPlayer
  private readonly events: VideoSyncEvents

  constructor(player: VideoPlayer, paceKmh: number, events: VideoSyncEvents) {
    this.player = player
    this.paceKmh = paceKmh
    this.events = events
  }

  /** Call every frame with the smoothed belt speed. */
  update(speedKmh: number, dt: number): void {
    this.clock += dt
    const state = this.player.getPlayerState()
    const playing = state === PLAYING || state === BUFFERING
    const moving = speedKmh > MOVING_KMH

    if (!moving) {
      this.playRequestedAt = null
      if (playing) this.player.pauseVideo()
      if (this.wasPlaying) this.save()
      this.wasPlaying = false
      return
    }

    const rate = pickRate(speedKmh / this.paceKmh, this.player.getAvailablePlaybackRates(), this.rate)
    if (rate !== this.rate || this.player.getPlaybackRate() !== rate) {
      this.player.setPlaybackRate(rate)
      this.rate = rate
    }

    if (playing) {
      this.playRequestedAt = null
      this.wasPlaying = true
      this.sincePlaying += dt
      if (this.sincePlaying >= SAVE_EVERY_S) this.save()
      return
    }
    if (state === ENDED) return // the tour is over; the belt keeps going, the video does not loop
    if (this.playRequestedAt === null) {
      this.player.playVideo()
      this.playRequestedAt = this.clock
    } else if (this.clock - this.playRequestedAt > PLAY_RETRY_S) {
      // Still not playing: most likely autoplay with sound was blocked. Muted playback is allowed.
      if (!this.player.isMuted()) {
        this.player.mute()
        this.events.onMutedForAutoplay?.()
      }
      this.player.playVideo()
      this.playRequestedAt = this.clock
    }
  }

  /** Report the current position (also call before switching videos or leaving the world). */
  save(): void {
    this.sincePlaying = 0
    const t = this.player.getCurrentTime()
    if (Number.isFinite(t) && t >= 0) this.events.onPosition(t)
  }
}

/** Where to start: the saved position, unless it is at (or near) the end. */
export function resumeAt(position: number, duration: number): number {
  if (duration > 0 && position > duration - 10) return 0
  return Math.max(0, Math.floor(position))
}
