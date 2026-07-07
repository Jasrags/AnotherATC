/**
 * Deterministic pseudo-random number generator (mulberry32).
 *
 * The simulation must be fully reproducible: the same seed plus the same
 * command sequence must always produce identical state (for tests, replays,
 * and eventually networked play). Never call `Math.random()` inside the sim —
 * thread an {@link Rng} through instead.
 */
export interface Rng {
  /** Next float in [0, 1). */
  next(): number
  /** Next integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
  }
}
