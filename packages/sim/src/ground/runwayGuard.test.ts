import { describe, it, expect } from 'vitest'
import { buildRunwayGuard, splitRouteAtRunway } from './runwayGuard'
import type { AirportSurface } from '../world/types'

// Runway centerline along the x-axis from (-1,0) to (1,0).
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
  features: [{ kind: 'runway', points: [[-1, 0], [1, 0]] }],
}
const guard = buildRunwayGuard(surface)

describe('splitRouteAtRunway', () => {
  it('splits a route that crosses the runway at the hold-short vertex', () => {
    const route = [
      [0, -0.5],
      [0, -0.1],
      [0, 0.1],
      [0, 0.5],
    ] as const
    const { drive, held } = splitRouteAtRunway(route, guard)
    expect(drive).toEqual([
      [0, -0.5],
      [0, -0.1],
    ])
    expect(held).toEqual([
      [0, -0.1],
      [0, 0.1],
      [0, 0.5],
    ])
  })

  it('leaves a route that never touches the runway intact', () => {
    const route = [
      [0, -0.5],
      [0, -0.3],
      [0, -0.1],
    ] as const
    const { drive, held } = splitRouteAtRunway(route, guard)
    expect(held).toBeNull()
    expect(drive).toHaveLength(3)
  })
})
