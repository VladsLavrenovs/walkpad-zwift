/** The world menu. Add a world here and it appears in the app; nothing else changes. */

import { OverlayWorld, PlaceholderWorld } from './placeholder'
import { YouTubeWorld } from './youtube'
import type { WorldInfo } from './world'

export const WORLDS: WorldInfo[] = [
  { id: 'placeholder', name: 'Placeholder', create: () => new PlaceholderWorld() },
  { id: 'youtube', name: 'YouTube walk', create: () => new YouTubeWorld() },
  { id: 'overlay', name: 'Overlay only (for OBS)', create: () => new OverlayWorld() },
]

export function findWorld(id: string | null): WorldInfo | undefined {
  return WORLDS.find((w) => w.id === id)
}
