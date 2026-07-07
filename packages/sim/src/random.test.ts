import { describe, it, expect } from 'vitest'
import { createRng } from './random'

describe('createRng', () => {
  it('is deterministic for a given seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = Array.from({ length: 5 }, () => a.next())
    const seqB = Array.from({ length: 5 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('produces different streams for different seeds', () => {
    const a = createRng(1)
    const b = createRng(2)
    expect(a.next()).not.toEqual(b.next())
  })

  it('returns floats within [0, 1)', () => {
    const rng = createRng(99)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('int stays within the inclusive range', () => {
    const rng = createRng(7)
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(3, 9)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(9)
      seen.add(v)
    }
    // Sanity: the full inclusive range is reachable.
    expect([...seen].sort((x, y) => x - y)).toEqual([3, 4, 5, 6, 7, 8, 9])
  })
})
