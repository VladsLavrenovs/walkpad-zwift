import { describe, expect, it } from 'vitest'
import credits from '../../../../docs/art/CREDITS.md?raw'
import { BUILDING_MODELS, MODEL_FOR, TEXTURES, matKey } from './assets'
import { biomePlan, house, rng, structures, tower } from './gen'

// Vite's own file imports (no Node types needed): every file in the fantasy folder, as text.
const files = import.meta.glob('/public/worlds/fantasy/**/*', { query: '?raw', import: 'default', eager: true })
const names = new Set(Object.keys(files).map((p) => p.split('/').pop()!))
const PROCEDURAL = /^(found_|corner_stone|wallcap|merlon|gatebeam|lantern|mill|stone_arch)/

describe('fantasy world assets', () => {
  it('every model is present, references no kit textures, and is credited', () => {
    for (const file of new Set([...BUILDING_MODELS, ...Object.values(MODEL_FOR)])) {
      const gltf = JSON.parse(files[`/public/worlds/fantasy/models/${file}.gltf`] as string)
      expect(gltf.images, file).toBeUndefined() // no requests for the kit's full-size PNGs
      for (const buffer of gltf.buffers) expect(names.has(buffer.uri), buffer.uri).toBe(true)
      expect(credits, `${file} missing from docs/art/CREDITS.md`).toContain(file.replace(/\d$/, ''))
    }
    expect(names.has('LICENSE-Quaternius-MedievalVillageMegaKit.txt')).toBe(true)
  })

  it('every texture is present and credited', () => {
    for (const pair of Object.values(TEXTURES)) {
      for (const file of pair!) {
        expect(names.has(file), file).toBe(true)
        expect(credits, `${file} missing from docs/art/CREDITS.md`).toContain(file.split('_')[1])
      }
    }
    expect(names.has('T_VineLeaf.png')).toBe(true)
  })

  it('maps the kit materials', () => {
    expect(matKey('MI_UnevenBrick')).toBe('uneven')
    expect(matKey('MI_WoodTrim_Wear')).toBe('wood')
    expect(matKey('MI_WindowGlass')).toBe('glass')
    expect(matKey(undefined)).toBe('rock')
  })

  it('buildings only use models that exist (kit or procedural)', () => {
    const plan = biomePlan(8, 60_000, 60_000)
    const used = new Set<string>()
    for (const st of structures(8, plan, 0, 60_000)) for (const p of st.pieces) used.add(p.model.split('#')[0])
    for (const p of [...house(rng(1), { W: 6, D: 8, floors: 3, stone: 'all' }), ...tower(rng(2), 5)]) used.add(p.model.split('#')[0])
    for (const model of used) {
      if (PROCEDURAL.test(model)) continue
      expect(BUILDING_MODELS, model).toContain(model)
    }
  })
})
