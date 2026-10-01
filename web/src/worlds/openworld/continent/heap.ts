/** A binary min-heap of grid cells keyed by a number (flood fill, A*). */
export class MinHeap {
  private keys: Float64Array
  private vals: Int32Array
  private n = 0

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity)
    this.vals = new Int32Array(capacity)
  }

  get size(): number {
    return this.n
  }

  push(key: number, value: number): void {
    if (this.n === this.keys.length) {
      const k = new Float64Array(this.n * 2)
      const v = new Int32Array(this.n * 2)
      k.set(this.keys)
      v.set(this.vals)
      this.keys = k
      this.vals = v
    }
    let i = this.n++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= key) break
      this.keys[i] = this.keys[p]
      this.vals[i] = this.vals[p]
      i = p
    }
    this.keys[i] = key
    this.vals[i] = value
  }

  /** Key of the smallest entry (call before pop). */
  peekKey(): number {
    return this.keys[0]
  }

  pop(): number {
    const top = this.vals[0]
    const lastKey = this.keys[--this.n]
    const lastVal = this.vals[this.n]
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      if (l >= this.n) break
      const r = l + 1
      const c = r < this.n && this.keys[r] < this.keys[l] ? r : l
      if (this.keys[c] >= lastKey) break
      this.keys[i] = this.keys[c]
      this.vals[i] = this.vals[c]
      i = c
    }
    this.keys[i] = lastKey
    this.vals[i] = lastVal
    return top
  }
}
