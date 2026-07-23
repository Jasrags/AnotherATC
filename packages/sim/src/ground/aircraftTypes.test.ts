import { describe, it, expect } from 'vitest'
import { AIRCRAFT_TYPES, DEFAULT_AIRCRAFT_TYPE, lookupAircraftType } from './aircraftTypes'

describe('aircraft type catalog', () => {
  it('resolves a known designator to its capabilities', () => {
    const b738 = lookupAircraftType('B738')

    expect(b738.wake).toBe('M')
    expect(b738.approachKt).toBe(140)
  })

  it('falls back to a Medium narrowbody for an unknown designator, without throwing', () => {
    expect(lookupAircraftType('ZZZZ')).toEqual(DEFAULT_AIRCRAFT_TYPE)
    expect(lookupAircraftType('').wake).toBe('M')
  })

  it('keeps approach speed monotonic by wake class — the property the exit model reads', () => {
    // Lights cross the threshold slower than Mediums, Mediums slower than Heavies. This spread is
    // the whole reason a Light makes an earlier turnoff than a Heavy; if it collapses, the
    // occupancy difference the catalog exists to create disappears.
    const byWake = (w: string) =>
      Object.values(AIRCRAFT_TYPES)
        .filter((t) => t.wake === w)
        .map((t) => t.approachKt)
    const maxLight = Math.max(...byWake('L'))
    const minMedium = Math.min(...byWake('M'))
    const minHeavy = Math.min(...byWake('H'))

    expect(maxLight).toBeLessThan(minMedium)
    expect(minHeavy).toBeGreaterThanOrEqual(minMedium)
  })

  it('gives every type a sane, positive capability set', () => {
    for (const [designator, spec] of Object.entries(AIRCRAFT_TYPES)) {
      expect(designator, 'ICAO designator is four characters').toHaveLength(4)
      expect(spec.approachKt, `${designator} approach speed`).toBeGreaterThan(0)
      expect(spec.taxiKt, `${designator} taxi speed`).toBeGreaterThan(0)
      expect(spec.minRwyFt, `${designator} min runway`).toBeGreaterThan(0)
      expect(['L', 'M', 'H', 'J']).toContain(spec.wake)
    }
  })
})
