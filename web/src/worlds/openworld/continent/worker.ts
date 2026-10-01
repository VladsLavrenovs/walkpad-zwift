/// <reference lib="webworker" />
/** Generates a continent off the main thread; the typed arrays are transferred, not copied. */

import { generateContinent } from './index'

self.onmessage = (event: MessageEvent<{ seed: number }>) => {
  const c = generateContinent(event.data.seed)
  const buffers = [c.height, c.surface, c.water, c.flow, c.down, c.moisture, c.slope, c.lore, c.biome, c.province]
    .map((a) => a.buffer as ArrayBuffer)
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(c, buffers)
}
