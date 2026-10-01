/** The world menu. Add a world here and it appears in the app; nothing else changes. */

import { OverlayWorld, PlaceholderWorld } from './placeholder'
import { RealWorld } from './realworld'
import { YouTubeWorld } from './youtube'
import type { WorldInfo } from './world'

export const WORLDS: WorldInfo[] = [
  { id: 'placeholder', name: 'Placeholder', create: () => new PlaceholderWorld() },
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
