import { describe, expect, it } from 'vitest'
import { KOAK_SURFACE } from './koak'

/**
 * The KOAK surface is machine-generated from OSM (tools/ingest/build-koak-surface.mjs) and
 * validated on import. This guards the ingest output itself: that the four runways survived the
 * projection with endpoints matching the NASR survey (docs/OAK/runways.md §4), and that the field
 * has the gates and stand lead-ins spawning needs. Each number here traces to a source, so a bad
 * re-fetch or a projection regression fails loudly rather than quietly playing a different field.
 */
describe('KOAK surface', () => {
  const feature = (kind: string) => KOAK_SURFACE.features.filter((f) => f.kind === kind)

  it('carries all four physical runways by designator', () => {
    const runways = feature('runway')
      .map((f) => f.ref)
      .sort()
    expect(runways).toEqual(['10L/28R', '10R/28L', '12/30', '15/33'])
  })

  it('places runway endpoints within survey tolerance of the NASR positions', () => {
    // NASR surveyed ends in local nm from the ARP (docs/OAK/runways.md §4). OSM is trusted only
    // because it agrees with the survey — 2–7 ft on every end but 28R (40 ft), all well inside a
    // runway half-width. The sim uses the NASR thresholds regardless; this checks the drawing.
    const FT_PER_NM = 6076.12
    const nasr: Record<string, [number, number]> = {
      '10L/28R': [-0.0489, 0.5525], // 10L end
      '10R/28L': [-0.2255, 0.4468], // 10R end
      '12/30': [-0.995, -0.0719], // 12 end
      '15/33': [-0.0787, 1.1419], // 15 end
    }
    for (const rwy of feature('runway')) {
      const want = nasr[rwy.ref ?? '']
      if (!want) continue
      const nearest = [rwy.points[0]!, rwy.points[rwy.points.length - 1]!].reduce((best, p) =>
        Math.hypot(p[0] - want[0], p[1] - want[1]) < Math.hypot(best[0] - want[0], best[1] - want[1]) ? p : best,
      )
      const offFt = Math.hypot(nearest[0] - want[0], nearest[1] - want[1]) * FT_PER_NM
      expect(offFt).toBeLessThan(60)
    }
  })

  it('has gate nodes and painted stand lead-ins for spawning', () => {
    expect(feature('gate').length).toBeGreaterThanOrEqual(20)
    expect(feature('parking_position').length).toBeGreaterThan(50)
  })

  it('spans the two separate fields', () => {
    // North Field (parallels + 15/33) and South Field (12/30) — a larger footprint than KSAN/KBUR.
    const { minX, maxX, minY, maxY } = KOAK_SURFACE.bounds
    expect(maxX - minX).toBeGreaterThan(1.5)
    expect(maxY - minY).toBeGreaterThan(2.0)
  })
})
