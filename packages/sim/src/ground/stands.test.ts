import { describe, expect, it } from 'vitest'
import { buildStands } from './stands'
import { KSAN_SURFACE } from '../world/ksan'
import type { AirportSurface, Point } from '../world/types'

const M_PER_NM = 1852
const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

describe('buildStands — KSAN', () => {
  const stands = buildStands(KSAN_SURFACE)
  const byRef = new Map(stands.map((s) => [s.ref, s]))

  it('gives every gate a stand, charted where the field has a painted line', () => {
    // 51 gate nodes: Terminal 2 (20–51) and Terminal 1 (101–119).
    expect(stands).toHaveLength(51)
    const charted = stands.filter((s) => s.source === 'charted')
    // Every T2 stand has an OSM parking_position way; T1's are not mapped.
    expect(charted.map((s) => s.ref).every((r) => Number(r) < 100)).toBe(true)
    expect(charted).toHaveLength(32)
    expect(stands.filter((s) => s.source === 'derived')).toHaveLength(19)
  })

  it('orders every lead-in line taxilane-first, nose-stop-last', () => {
    for (const s of stands) {
      expect(s.lead.length).toBeGreaterThanOrEqual(2)
      expect(s.entry).toEqual(s.lead[0])
      expect(s.stop).toEqual(s.lead[s.lead.length - 1])
      // The stop end is the one at the terminal: closer to the gate node than the entry is.
      expect(dist(s.stop, s.gate)).toBeLessThan(dist(s.entry, s.gate))
    }
  })

  it('keeps the painted curve rather than reducing a lead-in to its endpoints', () => {
    // Gate 39's line is charted with 11 vertices — a real curve onto the stand.
    const g39 = byRef.get('39')!
    expect(g39.source).toBe('charted')
    expect(g39.lead.length).toBeGreaterThan(2)
  })

  it('produces stands of plausible length', () => {
    for (const s of stands) {
      const len = dist(s.entry, s.stop) * M_PER_NM
      expect(len).toBeGreaterThan(10)
      expect(len).toBeLessThan(300)
    }
  })

  it('faces the nose along the last leg of the lead-in', () => {
    for (const s of stands) {
      expect(s.headingDeg).toBeGreaterThanOrEqual(0)
      expect(s.headingDeg).toBeLessThan(360)
    }
    // Gate 21's line runs from [-0.515,-0.051] to [-0.524,-0.089]: south and slightly west.
    const g21 = byRef.get('21')!
    expect(g21.headingDeg).toBeGreaterThan(180)
    expect(g21.headingDeg).toBeLessThan(200)
  })

  // The orientation rule (nearest endpoint to the gate node wins) is only as good as the gate
  // nodes. This checks the *result* against independent geometry — the terminal buildings — so
  // a bad ingest or a re-tagged OSM way shows up here rather than as aircraft parking backwards.
  it('never parks a derived stand inside a terminal building', () => {
    // The gate node sits at the terminal, so a derived lead-in run all the way to it put five
    // of Terminal 1's stands inside the building. The setback is measured from the field's own
    // charted stands rather than guessed.
    const terminals = KSAN_SURFACE.features.filter((f) => f.kind === 'terminal')
    const inside = (p: Point, poly: readonly Point[]): boolean => {
      let hit = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i] as Point
        const b = poly[j] as Point
        if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
          hit = !hit
      }
      return hit
    }
    const parked = stands.filter((s) => terminals.some((t) => inside(s.stop, t.points as Point[])))
    expect(parked.map((s) => s.ref)).toEqual([])
  })

  it('faces every stand at a terminal, including the lines mapped back to front', () => {
    const terminals = KSAN_SURFACE.features.filter((f) => f.kind === 'terminal')
    const toTerminal = (p: Point): number =>
      Math.min(...terminals.flatMap((t) => t.points.map((q) => dist(p, q as Point))))
    const backwards = stands.filter((s) => toTerminal(s.stop) > toTerminal(s.entry))
    expect(backwards.map((s) => s.ref)).toEqual([])
  })

  it('matches lines to stands by designator, not by proximity', () => {
    // Adjacent stands sit closer together than a gate node sits from its own line, so nearest
    // -endpoint matching picks the wrong line for a third of the field. Ref matching is exact.
    const g48 = byRef.get('48')!
    const charted = KSAN_SURFACE.features.find((f) => f.kind === 'parking_position' && f.ref === '48')!
    const ends: Point[] = [charted.points[0]!, charted.points[charted.points.length - 1]!]
    expect(ends.some((p) => dist(p, g48.stop) < 1e-9)).toBe(true)
  })
})

describe('buildStands — a field with no painted lines', () => {
  // A gate set back from a taxiway, with no parking_position way — the common case for a field
  // whose stands OSM never mapped (KSAN's own Terminal 1, and probably the next airport).
  const surface: AirportSurface = {
    icao: 'T',
    name: 'T',
    ref: { lat: 0, lon: 0, elevationFt: 0 },
    units: 'nm',
    source: 'x',
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    features: [
      { kind: 'taxiway', ref: 'A', points: [[-1, 0], [1, 0]] },
      { kind: 'gate', ref: '1', points: [[0, 0.1]] },
    ],
  }

  it('derives a straight lead-in that stops short of the gate label node', () => {
    const [s] = buildStands(surface)
    expect(s).toBeDefined()
    expect(s!.source).toBe('derived')
    expect(s!.entry[1]).toBeCloseTo(0, 6) // starts on the taxiway
    expect(s!.headingDeg).toBeCloseTo(0, 3) // nose north, straight in off the taxiway
    // It stops short of the gate node rather than at it. A gate node marks the stand at the
    // terminal, so a line run all the way to it parks the aircraft on the building. With no
    // charted stands on this field to measure against, the default setback applies.
    expect(s!.stop[1]).toBeLessThan(0.1)
    expect(s!.stop[1]).toBeGreaterThan(0.08)
    expect(s!.gate).toEqual([0, 0.1]) // the label node itself is still carried
  })

  it('skips a gate with no taxi pavement to lead in from', () => {
    const orphan: AirportSurface = { ...surface, features: [{ kind: 'gate', ref: '1', points: [[0, 0.1]] }] }
    expect(buildStands(orphan)).toEqual([])
  })
})
