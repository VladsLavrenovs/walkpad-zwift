/**
 * "YouTube walk" world: a walking-tour video, full screen, first person. The video follows the
 * belt (see videosync.ts): rate = belt speed / the video's walking pace, paused while the belt
 * stands, resumed where the last session stopped. Session stats still come from the pad; the
 * video is only scenery.
 *
 * Uses the official YouTube IFrame Player API. The library (URL, title, pace, last position)
 * lives in the bridge's database; this page edits it only when it may (local page).
 */

import type { Video } from '../bridge'
import { fmtSpeed } from '../format'
import { ENDED, PLAYING, BUFFERING, type VideoPlayer, VideoSync, resumeAt } from './videosync'
import type { World, WorldContext } from './world'

interface YTPlayer extends VideoPlayer {
  cueVideoById(opts: { videoId: string; startSeconds?: number }): void
  stopVideo(): void
  unMute(): void
  destroy(): void
  getVideoData?(): { title?: string }
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string
      playerVars: Record<string, number | string>
      events: { onReady?: () => void; onStateChange?: (e: { data: number }) => void; onError?: (e: { data: number }) => void }
    },
  ) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YTNamespace> | null = null

/** Load https://www.youtube.com/iframe_api once. */
function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve(window.YT!)
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      apiPromise = null
      reject(new Error('Could not load the YouTube player (offline?)'))
    }
    document.head.append(script)
  })
  return apiPromise
}

const VIDEO_KEY = 'walkpad.yt.video'
const WALKER_KEY = 'walkpad.yt.walker'

export class YouTubeWorld implements World {
  /** First person by default; the toolbar has a toggle. */
  readonly showsWalker = false
  private ctx!: WorldContext
  private root!: HTMLDivElement
  private playerEl!: HTMLDivElement
  private note!: HTMLDivElement
  private rateEl: HTMLElement | null = null
  private muteBtn: HTMLButtonElement | null = null
  private panel: HTMLDivElement | null = null
  private videos: Video[] = []
  private current: Video | null = null
  private player: YTPlayer | null = null
  private ready = false
  private sync: VideoSync | null = null
  private shownRate = ''
  private disposed = false

  async init(container: HTMLElement, ctx: WorldContext): Promise<void> {
    this.ctx = ctx
    this.root = document.createElement('div')
    this.root.className = 'yt-world'
    this.root.innerHTML = `
      <div class="yt-stage"><div class="yt-player"></div></div>
      <div class="yt-paused">Paused · starts when you walk</div>
      <div class="yt-note" hidden></div>`
    this.playerEl = this.root.querySelector('.yt-player')!
    this.note = this.root.querySelector('.yt-note')!
    container.append(this.root)
    if (!ctx.obs) this.buildUi()
    ctx.setWalkerVisible(!ctx.obs && readFlag(WALKER_KEY))

    try {
      this.videos = await ctx.bridge.videos()
    } catch (err) {
      this.showNote(`Could not load the video library: ${String(err)}`)
      return
    }
    this.renderList()
    const saved = Number(readKey(VIDEO_KEY))
    const pick = this.videos.find((v) => v.id === saved) ?? this.videos[0]
    if (pick) await this.select(pick)
    else this.showNote(ctx.canEdit() ? 'Paste a YouTube walking tour under “Videos” to start.' : 'No videos in the library yet.')
  }

  update(_distanceM: number, speedKmh: number, dt: number): void {
    if (!this.ready || !this.sync) return
    this.sync.update(speedKmh, dt)
    const state = this.player!.getPlayerState()
    // YouTube shows its own title bar and suggestions while paused; dim them away.
    this.root.classList.toggle('paused', state !== PLAYING && state !== BUFFERING)
    const text = state === PLAYING || state === BUFFERING ? `▶ ${this.sync.rate ?? 1}×` : state === ENDED ? 'end' : '⏸'
    if (text !== this.shownRate && this.rateEl) {
      this.rateEl.textContent = text
      this.shownRate = text
    }
  }

  dispose(): void {
    this.disposed = true
    this.sync?.save()
    this.player?.destroy()
    this.root.remove()
    this.ctx.setWalkerVisible(true)
  }

  // --- playback ---------------------------------------------------------------------------

  private async select(video: Video): Promise<void> {
    this.sync?.save() // remember where the previous video was
    this.current = video
    writeKey(VIDEO_KEY, String(video.id))
    this.renderList()
    this.showNote(null)
    const start = resumeAt(video.position_s, 0)
    if (this.player && this.ready) {
      this.player.cueVideoById({ videoId: video.video_id, startSeconds: start })
      this.sync = this.makeSync(this.player, video)
      return
    }
    let YT: YTNamespace
    try {
      YT = await loadYouTubeApi()
    } catch (err) {
      this.showNote(String(err instanceof Error ? err.message : err))
      return
    }
    if (this.disposed) return
    const player = new YT.Player(this.playerEl, {
      videoId: video.video_id,
      playerVars: {
        start, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          this.ready = true
          this.sync = this.makeSync(player, this.current!)
          this.renderMute()
        },
        onStateChange: () => this.fillTitle(),
        onError: (e) => this.showNote(`YouTube cannot play this video here (error ${e.data}): it may not allow embedding.`),
      },
    })
    this.player = player
  }

  private makeSync(player: YTPlayer, video: Video): VideoSync {
    return new VideoSync(player, video.pace_kmh, {
      onPosition: (t) => {
        const position = resumeAt(t, player.getDuration())
        video.position_s = position
        if (this.ctx.canEdit()) void this.ctx.bridge.updateVideo(video.id, { position_s: position }, true).catch(() => {})
      },
      onMutedForAutoplay: () => {
        this.renderMute()
        this.showNote('The browser blocked sound: playing muted. Use 🔇 to unmute.', 6000)
      },
    })
  }

  /** YouTube knows the title; store it the first time we see it. */
  private fillTitle(): void {
    const video = this.current
    const title = this.player?.getVideoData?.()?.title
    if (!video || video.title || !title || !this.ctx.canEdit()) return
    video.title = title
    this.renderList()
    void this.ctx.bridge.updateVideo(video.id, { title }).catch(() => {})
  }

  // --- UI ---------------------------------------------------------------------------------

  private buildUi(): void {
    const bar = document.createElement('div')
    bar.className = 'yt-toolbar'
    bar.innerHTML = `
      <button type="button" class="yt-videos">Videos</button>
      <span class="yt-rate" title="Playback rate = belt speed / video pace">⏸</span>
      <button type="button" class="yt-mute" title="Sound">🔊</button>
      <label class="yt-walker"><input type="checkbox"> walker</label>`
    this.rateEl = bar.querySelector('.yt-rate')
    this.muteBtn = bar.querySelector('.yt-mute')
    const walker = bar.querySelector<HTMLInputElement>('.yt-walker input')!
    walker.checked = readFlag(WALKER_KEY)
    walker.onchange = () => {
      writeKey(WALKER_KEY, walker.checked ? '1' : '0')
      this.ctx.setWalkerVisible(walker.checked)
    }
    this.muteBtn!.onclick = () => {
      if (!this.player || !this.ready) return
      if (this.player.isMuted()) this.player.unMute()
      else this.player.mute()
      // isMuted() lags a moment behind mute()/unMute()
      setTimeout(() => this.renderMute(), 150)
    }

    const panel = document.createElement('div')
    panel.className = 'yt-panel'
    panel.hidden = true
    panel.innerHTML = `
      <form class="yt-add">
        <input name="url" type="url" required placeholder="Paste a YouTube walking-tour link" autocomplete="off">
        <label>pace <input name="pace" type="number" min="1" max="10" step="0.1" value="4.5"> km/h</label>
        <button type="submit">Add</button>
      </form>
      <p class="yt-hint">Pace = how fast the person filming walks. The video plays at belt speed ÷ pace.</p>
      <ul class="yt-list"></ul>`
    this.panel = panel
    bar.querySelector<HTMLButtonElement>('.yt-videos')!.onclick = () => {
      panel.hidden = !panel.hidden
      this.renderList()
    }
    const form = panel.querySelector<HTMLFormElement>('.yt-add')!
    form.onsubmit = (e) => {
      e.preventDefault()
      void this.add(form)
    }
    this.root.append(bar, panel)
  }

  private async add(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form)
    try {
      const video = await this.ctx.bridge.addVideo(String(data.get('url')), Number(data.get('pace')) || undefined)
      this.videos = [video, ...this.videos.filter((v) => v.id !== video.id)]
      form.reset()
      await this.select(video)
    } catch (err) {
      this.showNote(`Could not add the video: ${err instanceof Error ? err.message : String(err)}`, 6000)
    }
  }

  private renderList(): void {
    const panel = this.panel
    if (!panel) return
    const editable = this.ctx.canEdit()
    panel.querySelector<HTMLFormElement>('.yt-add')!.hidden = !editable
    panel.querySelector<HTMLElement>('.yt-hint')!.hidden = !editable
    const list = panel.querySelector('.yt-list')!
    list.replaceChildren(
      ...this.videos.map((v) => {
        const li = document.createElement('li')
        li.classList.toggle('current', v.id === this.current?.id)
        const pick = document.createElement('button')
        pick.type = 'button'
        pick.className = 'yt-pick'
        pick.textContent = v.title || `YouTube ${v.video_id}`
        pick.title = `${v.url} · resume at ${Math.floor(v.position_s / 60)} min`
        pick.onclick = () => void this.select(v)
        const pace = document.createElement('input')
        pace.type = 'number'
        pace.min = '1'
        pace.max = '10'
        pace.step = '0.1'
        pace.value = fmtSpeed(v.pace_kmh)
        pace.disabled = !editable
        pace.title = 'Walking pace of the video, km/h'
        pace.onchange = () => void this.setPace(v, Number(pace.value))
        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'yt-del'
        del.textContent = '×'
        del.title = 'Remove from the library'
        del.hidden = !editable
        del.onclick = () => void this.remove(v)
        li.append(pick, pace, document.createTextNode('km/h'), del)
        return li
      }),
    )
  }

  private async setPace(video: Video, kmh: number): Promise<void> {
    if (!(kmh >= 1 && kmh <= 10)) return this.renderList()
    try {
      const updated = await this.ctx.bridge.updateVideo(video.id, { pace_kmh: kmh })
      video.pace_kmh = updated.pace_kmh
      if (this.current?.id === video.id && this.sync) this.sync.paceKmh = updated.pace_kmh
    } catch (err) {
      this.showNote(`Could not save the pace: ${String(err)}`, 5000)
    }
    this.renderList()
  }

  private async remove(video: Video): Promise<void> {
    if (!confirm(`Remove “${video.title || video.video_id}” from the library?`)) return
    try {
      await this.ctx.bridge.deleteVideo(video.id)
    } catch (err) {
      this.showNote(`Could not remove it: ${String(err)}`, 5000)
      return
    }
    this.videos = this.videos.filter((v) => v.id !== video.id)
    if (this.current?.id === video.id) {
      this.current = null
      this.sync = null
      this.player?.stopVideo()
      if (this.videos[0]) await this.select(this.videos[0])
      else this.showNote('Paste a YouTube walking tour under “Videos” to start.')
    }
    this.renderList()
  }

  private renderMute(): void {
    if (this.muteBtn && this.player && this.ready) this.muteBtn.textContent = this.player.isMuted() ? '🔇' : '🔊'
  }

  private noteTimer: ReturnType<typeof setTimeout> | null = null

  private showNote(text: string | null, ms = 0): void {
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.note.hidden = text === null
    this.note.textContent = text ?? ''
    if (text !== null && ms > 0) this.noteTimer = setTimeout(() => (this.note.hidden = true), ms)
  }
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function readFlag(key: string): boolean {
  return readKey(key) === '1'
}
