import { describe, it, expect } from 'vitest'
import type { AirportSurface, Point, SurfaceFeature } from '@anotheratc/sim'
import { polylineLength, polylineMidpoint, distToSeg, nearestTaxiwayRef, prepareSurface } from './render'

/** Build a minimal surface from taxiway/taxilane polylines for hit-testing. */
function surfaceOf(features: SurfaceFeature[]): AirportSurface {
  return {
    icao: 'TEST',
    name: 'Test',
    ref: { lat: 0, lon: 0, elevationFt: 0 },
    units: 'nm',
    source: 'synthetic',
    bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
    features,
  }
}

function taxiway(ref: string, points: Point[]): SurfaceFeature {
  return { kind: 'taxiway', points, ref }
}

describe('polylineLength', () => {
  it('sums segment lengths along the polyline', () => {
    // 3-4-5 leg then a unit hop → 5 + 1
    expect(polylineLength([[0, 0], [3, 4], [3, 5]])).toBeCloseTo(6, 9)
  })

  it('is zero for a single point or empty polyline', () => {
    expect(polylineLength([[2, 2]])).toBe(0)
    expect(polylineLength([])).toBe(0)
  })
})

describe('polylineMidpoint', () => {
  it('returns the arc-length midpoint, independent of vertex spacing', () => {
    // Total length 4 along the x-axis; midpoint is x=2 regardless of where vertices fall.
    const uneven = polylineMidpoint([[0, 0], [0.5, 0], [4, 0]])
    expect(uneven).not.toBeNull()
    expect(uneven?.[0]).toBeCloseTo(2, 9)
    expect(uneven?.[1]).toBeCloseTo(0, 9)
  })

  it('interpolates within the segment that straddles the halfway mark', () => {
    // L-shape: right 2 then up 2 (total 4). Half = 2 lands exactly at the corner.
    const mid = polylineMidpoint([[0, 0], [2, 0], [2, 2]])
    expect(mid?.[0]).toBeCloseTo(2, 9)
    expect(mid?.[1]).toBeCloseTo(0, 9)
  })

  it('returns the sole point for a zero-length polyline', () => {
    expect(polylineMidpoint([[1, 7]])).toEqual([1, 7])
  })

  it('returns null when there are no points', () => {
    expect(polylineMidpoint([])).toBeNull()
  })
})

describe('distToSeg', () => {
  it('is the perpendicular distance when the foot lies on the segment', () => {
    // Point (1,2) onto the x-axis segment (0,0)-(4,0) → 2.
    expect(distToSeg(1, 2, 0, 0, 4, 0)).toBeCloseTo(2, 9)
  })

  it('clamps to the nearer endpoint when the projection falls off the segment', () => {
    // Foot would be at x=-3 (before the start), so distance is to (0,0).
    expect(distToSeg(-3, 0, 0, 0, 4, 0)).toBeCloseTo(3, 9)
    // Beyond the end → distance to (4,0).
    expect(distToSeg(9, 0, 0, 0, 4, 0)).toBeCloseTo(5, 9)
  })

  it('handles a degenerate (zero-length) segment as distance to the point', () => {
    expect(distToSeg(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 9)
  })
})

describe('nearestTaxiwayRef', () => {
  const surface = surfaceOf([
    taxiway('A', [[0, 0], [10, 0]]), // long spine along y=0
    taxiway('B', [[5, 0], [5, 4]]), // stub branching north from the spine
  ])

  it('returns the designator of the closest taxiway within range', () => {
    expect(nearestTaxiwayRef(surface, 2, 0.2, 0.5)).toBe('A')
    expect(nearestTaxiwayRef(surface, 5, 3, 0.5)).toBe('B')
  })

  it('returns null when nothing is within maxNm', () => {
    expect(nearestTaxiwayRef(surface, 2, 5, 0.5)).toBeNull()
  })

  it('breaks a near-tie in favor of the longer taxiway (through-route over stub)', () => {
    // At the junction both legs are ~equidistant; the longer spine A must win.
    expect(nearestTaxiwayRef(surface, 5, 0, 0.5)).toBe('A')
  })

  it('ignores features without a ref', () => {
    const unnamed = surfaceOf([{ kind: 'taxiway', points: [[0, 0], [10, 0]] }])
    expect(nearestTaxiwayRef(unnamed, 2, 0, 0.5)).toBeNull()
  })
})

describe('prepareSurface', () => {
  const surface = surfaceOf([
    { kind: 'runway', points: [[-1, 0], [1, 0]], ref: '9/27' },
    { kind: 'taxiway', points: [[0, -0.5], [0, -0.2]], ref: 'A' }, // off the runway, to the south
    { kind: 'apron', points: [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7]], ref: 'RAMP' },
    { kind: 'holding_position', points: [[0, -0.2]] },
    { kind: 'gate', points: [[0, -0.5]], ref: 'G1' },
  ])

  it('sorts features into static draw buckets', () => {
    const prep = prepareSurface(surface)
    expect(prep.taxiways).toHaveLength(1)
    expect(prep.runwayPavement).toHaveLength(1)
    expect(prep.runwayCenterlines).toHaveLength(1)
    expect(prep.holdShort).toEqual([[0, -0.2]])
  })

  it('derives the world-space label anchors once', () => {
    const prep = prepareSurface(surface)
    expect(prep.taxiLabels.map((l) => l.text)).toEqual(['A'])
    expect(prep.stands.map((s) => s.ref)).toContain('G1')
    expect(prep.areaLabels.map((l) => l.text)).toContain('RAMP')
    // 9 sits at the west (min-x) threshold, 27 at the east (max-x) threshold.
    const nine = prep.runwayNumbers.find((r) => r.text === '9')
    const twoSeven = prep.runwayNumbers.find((r) => r.text === '27')
    expect(nine?.at[0]).toBe(-1)
    expect(twoSeven?.at[0]).toBe(1)
  })
})
