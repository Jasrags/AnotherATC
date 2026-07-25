import type { Airport } from './airport'
import type { Point } from './types'
import { buildTaxiGraph } from '../ground/taxiGraph'
import { buildStands } from '../ground/stands'
import {
  auditTaxiGraph,
  CATEGORY_OF,
  TAXI_CATEGORIES,
  type TaxiAuditReport,
  type TaxiCategory,
  type TaxiFinding,
} from '../ground/taxiAudit'

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
const CATEGORY_TITLE: Record<TaxiCategory, string> = {
  connectivity: 'CONNECTIVITY — is every bit of pavement reachable',
  redundancy: 'REDUNDANCY — is any run drawn twice',
  intersections: 'INTERSECTIONS — are the crossings clean',
  smoothness: 'SMOOTHNESS — do the runs curve without kinks',
}

/** How the finding kinds within a category count up, for the one-line-per-category rollup. */
function categoryTally(findings: TaxiFinding[], category: TaxiCategory): string {
  const counts = new Map<string, number>()
  for (const f of findings) if (f.category === category) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
  if (counts.size === 0) return '✓ clean'
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${n} ${k}`).join(', ')
}

/**
 * A holistic, whole-graph health report: the graph's shape, a per-category rollup (connectivity →
 * redundancy → intersections → smoothness), then every finding ranked worst-first under its
 * category heading, each with a world coordinate to jump to and a suggested fix. One airport, one
 * pass — see docs/taxi-graph-audit.md.
 */
export function formatReport(icao: string, report: TaxiAuditReport): string {
  const { summary, findings, graph } = report
  const conn = graph.components === 1 ? '1 component ✓' : `${graph.components} components ✗`
  const head =
    `${icao} taxi graph — health report\n` +
    `  graph:    ${graph.nodes} nodes · ${graph.edges} edges · ${conn}\n` +
    `  findings: ${summary.total} — ${summary.high} high · ${summary.medium} med · ${summary.low} low`
  const rollup = TAXI_CATEGORIES.map((c) => `  · ${c.padEnd(14)} ${categoryTally(findings, c)}`).join('\n')
  if (findings.length === 0) return `${head}\n${rollup}\n  ✓ clean — no rough geometry`

  const blocks = TAXI_CATEGORIES.filter((c) => findings.some((f) => f.category === c)).map((c) => {
    const rows = findings
      .filter((f) => f.category === c)
      .map((f) => {
        const at = `(${f.at[0].toFixed(4)}, ${f.at[1].toFixed(4)})`
        const ref = f.ref ? ` [${f.ref}]` : ''
        return `  ${badge[f.severity]} ${f.kind.padEnd(21)} ${at}${ref}\n        ${f.detail}\n        → ${f.suggestion}`
      })
    return `\n${CATEGORY_TITLE[c]}\n${rows.join('\n')}`
  })
  return `${head}\n${rollup}\n${blocks.join('\n')}`
}

// Re-exported so callers formatting their own views share the category taxonomy.
export { CATEGORY_OF, TAXI_CATEGORIES }
