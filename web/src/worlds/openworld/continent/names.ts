/** Seeded fantasy place names, unique within a continent. */

import { hashInts } from '../../fantasy/gen'
import type { PlaceKind } from './types'

const PREFIX = [
  'Ash', 'Bright', 'Cold', 'Elder', 'Fair', 'Glen', 'Hollow', 'Iron', 'Mist', 'Oak', 'Raven', 'Silver',
  'Stone', 'Thorn', 'Willow', 'Wolf', 'Amber', 'Dawn', 'Frost', 'Green', 'High', 'Lark', 'Moon', 'Red',
  'Rose', 'Storm', 'Sun', 'Swan', 'Wind', 'Black', 'Bram', 'Deep', 'Elm', 'Fern', 'Gold', 'Hazel',
]
const SUFFIX: Record<string, string[]> = {
  village: ['ford', 'brook', 'vale', 'wick', 'stead', 'field', 'dale', 'mere', 'ton', 'bury', 'holm', 'wood', 'by', 'well'],
  city: ['haven', 'gard', 'mouth', 'port', 'hold', 'bridge', 'minster'],
  castle: ['keep', 'spire', 'watch', 'crest', 'guard', 'hold', 'tor'],
  falls: ['fall', 'spray', 'veil', 'drop', 'cascade'],
}
const ELVEN_A = ['Ael', 'Ith', 'Lor', 'Syl', 'Vael', 'Eri', 'Nim', 'Thal', 'Cael', 'Ilu', 'Mir', 'Oro']
const ELVEN_B = ['dor', 'wen', 'ion', 'thas', 'orë', 'ian', 'iel', 'ara', 'enth', 'ys']
const PROVINCE = ['March', 'Vale', 'Reach', 'Shire', 'Downs', 'Wold', 'Marches', 'Lands']

const pick = <T>(list: readonly T[], h: number): T => list[h % list.length]
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export class Namer {
  private readonly used = new Set<string>()
  private readonly seed: number

  constructor(seed: number) {
    this.seed = seed
  }

  name(kind: PlaceKind, index: number, near?: string): string {
    for (let attempt = 0; attempt < 40; attempt++) {
      const h = hashInts(this.seed, 900 + kind.length * 31, index, attempt)
      const h2 = hashInts(h, 7)
      let name: string
      if (kind === 'ruins') name = `Ruins of ${pick(ELVEN_A, h)}${pick(ELVEN_B, h2)}`
      else if (kind === 'windmill') name = near ? `${near} Mill` : `${pick(PREFIX, h)} Mill`
      else if (kind === 'waterfall') name = `${pick(PREFIX, h)}${pick(SUFFIX.falls, h2)} Falls`
      else if (kind === 'castle') name = `Castle ${pick(PREFIX, h)}${pick(SUFFIX.castle, h2)}`
      else name = cap(`${pick(PREFIX, h)}${pick(SUFFIX[kind] ?? SUFFIX.village, h2)}`)
      if (!this.used.has(name)) {
        this.used.add(name)
        return name
      }
    }
    return `${cap(kind)} ${index}`
  }

  province(capital: string, index: number): string {
    const base = capital.replace(/^Castle /, '')
    return `${base} ${pick(PROVINCE, hashInts(this.seed, 77, index))}`
  }
}
