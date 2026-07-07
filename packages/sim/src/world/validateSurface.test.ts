import { describe, it, expect } from 'vitest'
import { validateSurface } from './validateSurface'
import { KSAN_SURFACE } from './ksan'

function validSurface(): unknown {
  return {
    icao: 'T',
    name: 'Test',
    ref: { lat: 0, lon: 0, elevationFt: 0 },
    units: 'nm',
    source: 'synthetic',
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    features: [{ kind: 'runway', points: [[-1, 0], [1, 0]] }],
    hotspots: [{ id: 'HS1', label: 'HS 1', point: [0, 0], radiusNm: 0.05 }],
  }
}

describe('validateSurface', () => {
  it('accepts a well-formed surface and returns it', () => {
    const input = validSurface()
    expect(validateSurface(input)).toBe(input)
  })

  it('accepts the generated KSAN surface (guards against ingest regressions)', () => {
    expect(() => validateSurface(KSAN_SURFACE)).not.toThrow()
  })

  it('rejects a non-object', () => {
    expect(() => validateSurface(null)).toThrow(/surface/i)
    expect(() => validateSurface('nope')).toThrow(/surface/i)
  })

  it('rejects missing or empty features', () => {
    const noFeatures = validSurface() as Record<string, unknown>
    delete noFeatures.features
    expect(() => validateSurface(noFeatures)).toThrow(/features/i)

    const empty = { ...(validSurface() as object), features: [] }
    expect(() => validateSurface(empty)).toThrow(/features/i)
  })

  it('rejects a feature with an unknown kind', () => {
    const bad = validSurface() as { features: { kind: string }[] }
    bad.features[0]!.kind = 'spaceport'
    expect(() => validateSurface(bad)).toThrow(/kind/i)
  })

  it('rejects a feature with empty points', () => {
    const bad = validSurface() as { features: { points: unknown[] }[] }
    bad.features[0]!.points = []
    expect(() => validateSurface(bad)).toThrow(/point/i)
  })

  it('rejects a non-finite coordinate (NaN from JSON null)', () => {
    const bad = validSurface() as { features: { points: number[][] }[] }
    bad.features[0]!.points = [[0, 0], [NaN, 1]]
    expect(() => validateSurface(bad)).toThrow(/finite/i)
  })

  it('rejects non-finite bounds', () => {
    const bad = validSurface() as { bounds: Record<string, number> }
    bad.bounds.maxX = Infinity
    expect(() => validateSurface(bad)).toThrow(/bounds/i)
  })
})
