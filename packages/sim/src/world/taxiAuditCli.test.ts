import { it } from 'vitest'
import { KSAN } from './ksanAirport'
import { KBUR } from './kburAirport'
import { KOAK } from './koakAirport'
import type { Airport } from './airport'
import { auditAirport, formatReport } from './taxiAuditReport'

/**
 * The `make audit-taxi` entry point. This is a Vitest file only because the sim is consumed as TS
 * source (no standalone TS runner in the toolchain, and adding one is a supply-chain decision) — its
 * job is the printout, not an assertion. Run it with console interception off so the report reaches
 * the terminal:
 *
 *   make audit-taxi              # all fields
 *   make audit-taxi AIRPORT=KBUR # one field
 *
 * See docs/taxi-graph-audit.md.
 *
 * The sim package is headless — its tsconfig carries no Node types on purpose — so the process
 * handle is reached through a typed globalThis cast rather than the Node global, keeping the
 * boundary intact. It only ever runs under Vitest/Node, where process is present.
 */
const proc = (globalThis as { process?: { env: Record<string, string | undefined>; stdout: { write(s: string): void } } })
  .process

const FIELDS: Record<string, Airport> = { KSAN, KBUR, KOAK }

it('taxi-graph audit report', () => {
  // Silent in a normal `make test` run — only prints when the CLI target sets the env var, so the
  // report never clutters the suite output.
  const want = proc?.env.AUDIT_AIRPORT
  if (!want || !proc) return
  const key = want.toUpperCase()
  const fields = key === 'ALL' ? Object.values(FIELDS) : [FIELDS[key]].filter((a): a is Airport => !!a)
  if (fields.length === 0) {
    proc.stdout.write(`\nUnknown AIRPORT="${key}". Known: ${Object.keys(FIELDS).join(', ')}, or ALL.\n`)
    return
  }
  const blocks = fields.map((ap) => formatReport(ap.icao, auditAirport(ap)))
  proc.stdout.write('\n' + blocks.join('\n\n') + '\n')
})
