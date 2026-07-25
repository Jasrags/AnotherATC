import { describe, it, expect } from 'vitest'
import { KSAN } from './ksanAirport'
import { KBUR } from './kburAirport'
import { KOAK } from './koakAirport'
import type { Airport } from './airport'
import { auditAirport } from './taxiAuditReport'

/**
 * A ratchet, not a target. Each field's taxi graph currently carries the geometry findings below
 * (the "very bad geometry" that motivated the audit — docs/taxi-graph-audit.md). These are ceilings:
 * cleaning the source data can only take them down, and this test fails if a change makes any field
 * *worse*. Lower the number when you improve a graph; never raise it without a reason in the diff.
 */
const BASELINE: Record<string, { airport: Airport; maxTotal: number; maxHigh: number }> = {
  KSAN: { airport: KSAN, maxTotal: 152, maxHigh: 66 },
  KBUR: { airport: KBUR, maxTotal: 178, maxHigh: 66 },
  KOAK: { airport: KOAK, maxTotal: 172, maxHigh: 54 },
}

describe('per-airport taxi-graph audit baselines', () => {
  for (const [icao, { airport, maxTotal, maxHigh }] of Object.entries(BASELINE)) {
    it(`${icao} does not regress past its geometry baseline`, () => {
      const report = auditAirport(airport)
      expect(report.summary.total).toBeLessThanOrEqual(maxTotal)
      expect(report.summary.high).toBeLessThanOrEqual(maxHigh)
    })
  }

  it('the audit is deterministic — same field, same report', () => {
    const a = auditAirport(KBUR)
    const b = auditAirport(KBUR)
    expect(a.findings).toEqual(b.findings)
  })
})
