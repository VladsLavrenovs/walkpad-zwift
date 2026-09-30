import { describe, expect, it } from 'vitest'
import { isRamping, keyAction, presetsFor, stepTarget } from './controls'

describe('controls logic', () => {
  it('steps the target in 0.5 km/h within [0.5, cap]', () => {
    expect(stepTarget(3, 0.5, 6)).toBe(3.5)
    expect(stepTarget(3.3, 0.5, 6)).toBe(4) // snaps to the 0.5 grid
    expect(stepTarget(5.8, 0.5, 6)).toBe(6)
    expect(stepTarget(6, 0.5, 6)).toBe(6)
    expect(stepTarget(0.5, -0.5, 6)).toBe(0.5) // never below the device minimum: use STOP
    expect(stepTarget(2, 0.5, 1.5)).toBe(1.5)
  })

  it('offers presets up to the cap', () => {
    expect(presetsFor(6)).toEqual([1, 2, 3, 4, 5, 6])
    expect(presetsFor(3.5)).toEqual([1, 2, 3])
  })

  it('shows target and belt while ramping', () => {
    expect(isRamping(3, 2.5)).toBe(true)
    expect(isRamping(3, 2.9)).toBe(false)
    expect(isRamping(null, 2)).toBe(false)
  })

  it('maps keys: Space/Esc stop, arrows adjust, modifiers ignored', () => {
    const k = (key: string, code = '', mod = false) =>
      keyAction({ key, code, altKey: false, ctrlKey: mod, metaKey: false })
    expect(k(' ', 'Space')).toBe('stop')
    expect(k('Escape')).toBe('stop')
    expect(k('ArrowUp')).toBe('up')
    expect(k('ArrowRight')).toBe('up')
    expect(k('ArrowDown')).toBe('down')
    expect(k('ArrowLeft')).toBe('down')
    expect(k('ArrowUp', '', true)).toBeNull()
    expect(k('a')).toBeNull()
  })
})
