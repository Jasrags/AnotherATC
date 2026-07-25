import type { Airport } from './airport'
import type { Point } from './types'
import { buildTaxiGraph } from '../ground/taxiGraph'
import { buildStands } from '../ground/stands'
import { auditTaxiGraph, type TaxiAuditReport, type TaxiFinding } from '../ground/taxiAudit'

/**
 * Audit one airport's taxi graph end-to-end: build the graph from its surface, gather the
 * legitimate dead-ends (runway ends + stand stop marks) so the dangling-node check has context,
 * and run the geometry audit. This is the bridge the CLI and the per-airport regression test both
 * call — see docs/taxi-graph-audit.md.
 */
export function auditAirport(airport: Airport): TaxiAuditReport {
  const graph = buildTaxiGraph(airport.surface)
  const runwayEnds: Point[] = airport.runways.flatMap((r) => [r.departureStart, r.farEnd, r.threshold])
  const standStops: Point[] = buildStands(airport.surface).map((s) => s.stop)
  return auditTaxiGraph(graph.topology(), { endpoints: [...runwayEnds, ...standStops] })
}

const badge: Record<TaxiFinding['severity'], string> = { high: 'HIGH', medium: 'MED ', low: 'LOW ' }

/** A fixed-width, one-line-per-finding report with a world coordinate to jump to, worst first. */
export function formatReport(icao: string, report: TaxiAuditReport): string {
  const { summary, findings } = report
  const head = `${icao} taxi graph — ${summary.total} finding(s): ${summary.high} high · ${summary.medium} med · ${summary.low} low`
  if (findings.length === 0) return `${head}\n  ✓ clean — no rough geometry`
  const lines = findings.map((f) => {
    const at = `(${f.at[0].toFixed(4)}, ${f.at[1].toFixed(4)})`
    const ref = f.ref ? ` [${f.ref}]` : ''
    return `  ${badge[f.severity]} ${f.kind.padEnd(20)} ${at}${ref}\n        ${f.detail}\n        → ${f.suggestion}`
  })
  return `${head}\n${lines.join('\n')}`
}
