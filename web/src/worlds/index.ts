/** The world menu. Add a world here and it appears in the app; nothing else changes. */

import { OverlayWorld, PlaceholderWorld } from './placeholder'
import { RealWorld } from './realworld'
import { YouTubeWorld } from './youtube'
import type { World, WorldContext, WorldInfo } from './world'

/** A world whose code (and big libraries, e.g. three.js) is downloaded only when it is chosen. */
function lazyWorld(showsWalker: boolean, load: () => Promise<World>, usesRoute = true): World {
  let inner: World | null = null
  let disposed = false
  return {
    showsWalker,
    usesRoute,
    async init(container: HTMLElement, ctx: WorldContext) {
      const world = await load()
      if (disposed) return
      inner = world
      await world.init(container, ctx)
    },
    update(distanceM: number, speedKmh: number, dt: number) {
      inner?.update(distanceM, speedKmh, dt)
    },
    dispose() {
      disposed = true
      inner?.dispose()
    },
  }
}

export const WORLDS: WorldInfo[] = [
  { id: 'placeholder', name: 'Placeholder', create: () => new PlaceholderWorld() },
  {
    id: 'fantasy',
    name: 'Fantasy trail',
    create: () => lazyWorld(true, async () => new (await import('./fantasy/world')).FantasyWorld()),
  },
  {
    id: 'openworld',
    name: 'Open world',
    create: () => lazyWorld(true, async () => new (await import('./openworld/world')).OpenWorld(), false),
  },
  { id: 'youtube', name: 'YouTube walk', create: () => new YouTubeWorld() },
  { id: 'overlay', name: 'Overlay only (for OBS)', create: () => new OverlayWorld() },
  // Google Photorealistic 3D Tiles cost money per session: only offered when switched on
  // (VITE_WORLD_MODE=real in web/.env), and the bridge must grant each session.
  ...(import.meta.env.VITE_WORLD_MODE === 'real'
    ? [{ id: 'real', name: 'Real world (3D)', create: () => new RealWorld() }]
    : []),
]

export function findWorld(id: string | null): WorldInfo | undefined {
  return WORLDS.find((w) => w.id === id)
}
