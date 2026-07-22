import { describe, it, expect } from 'vitest'
import { loadTrafficRate, saveTrafficRate } from './prefs'

/** A minimal in-memory Storage, so these tests don't depend on a DOM. */
function memoryStore(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

const throwingStore = (): Storage =>
  new Proxy(memoryStore(), {
    get() {
      throw new Error('storage disabled')
    },
  })

describe('traffic-rate preference', () => {
  it('round-trips a saved rate', () => {
    const store = memoryStore()
    saveTrafficRate(0.35, store)
    expect(loadTrafficRate(store)).toBe(0.35)
  })

  it('has no opinion when nothing was saved', () => {
    expect(loadTrafficRate(memoryStore())).toBeUndefined()
  })

  it('ignores a stored value that is not a usable rate', () => {
    expect(loadTrafficRate(memoryStore({ 'atc.trafficRate': 'lots' }))).toBeUndefined()
    expect(loadTrafficRate(memoryStore({ 'atc.trafficRate': '-2' }))).toBeUndefined()
  })

  it('survives storage being unavailable, in both directions', () => {
    expect(loadTrafficRate(throwingStore())).toBeUndefined()
    expect(() => saveTrafficRate(1, throwingStore())).not.toThrow()
    expect(loadTrafficRate(undefined as unknown as Storage)).toBeUndefined()
  })

  it('survives the ambient localStorage accessor itself throwing', () => {
    // A sandboxed frame throws on `globalThis.localStorage`, not on getItem — which is why the
    // access sits inside the try rather than in a parameter default. Called with no store, the
    // way the app calls it, on the render path.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      expect(loadTrafficRate()).toBeUndefined()
      expect(() => saveTrafficRate(1)).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: Storage }).localStorage
    }
  })
})
