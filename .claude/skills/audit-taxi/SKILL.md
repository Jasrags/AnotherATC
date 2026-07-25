---
name: audit-taxi
description: Audit a field's taxi-graph geometry for rough spots (cusps/spikes, near-duplicate nodes, disconnected islands, tight turns, stubs, kinks, dangling dead-ends). Use when a taxi graph looks messy on the scope, when adding or cleaning an airport, or when asked to "audit"/"review the taxiways" for a field. Wraps `make audit-taxi`.
argument-hint: [KSAN|KBUR|KOAK]  (omit for all fields)
---

# Taxi-graph geometry audit

A thin wrapper over the deterministic audit in `packages/sim` — full reference in
`docs/taxi-graph-audit.md`. Detection logic lives in code (`auditTaxiGraph`), so this skill only
runs it, reads the ranked report, and helps the user act on it. Do not re-derive the geometry checks
by hand — run the tool.

## Steps

1. **Run the audit** for the requested field (argument), or all fields if none given. Node ≥ 22.13,
   so route through fnm as the repo does:

   ```bash
   make audit-taxi AIRPORT=<ICAO>     # e.g. AIRPORT=KBUR; omit AIRPORT for all fields
   ```

   (Equivalently: `AUDIT_AIRPORT=<ICAO> fnm exec --using=22 -- pnpm --filter @anotheratc/sim exec
   vitest run src/world/taxiAuditCli.test.ts --disable-console-intercept`.)

2. **Summarize** the header line for each field — `N findings: H high · M med · L low` — and the
   spread by kind. Lead with what dominates (usually `cusp` spikes and `disconnected` islands).

3. **Surface the worst spots.** The report is ranked worst-first with a world coordinate on each
   finding. Offer to walk the top HIGH findings — cusps (spikes), near-duplicate nodes, and any
   disconnected island (which strands whatever routes into it). Each finding carries a concrete
   suggested smoothing.

4. **Fixing is a data edit, not automatic.** Findings point at the OSM-derived surface data. A fix
   (merge two nodes, drop doubled paint, re-digitize a corner) is applied to the field's surface /
   ingest, then **re-run the audit** to confirm the finding is gone and the baseline dropped. Never
   auto-mutate the graph.

5. **Guard the baseline.** `packages/sim/src/world/taxiAudit.airports.test.ts` holds each field's
   finding-count ceiling. After improving a graph, lower that field's numbers so the gain is locked
   in; `make check` fails if a change makes a field worse.

## When to reach for it

- A taxi graph renders spiky / doubled on the scope (the "star" intersections).
- Adding a new airport (`docs/adding-an-airport.md`) — audit before wiring gameplay.
- Any request to "review / audit / clean up the taxiways" for a field.

## Scope notes

- Thresholds are geometry-quality constants in `packages/sim/src/ground/taxiAudit.ts` (a cusp is a
  cusp at every field), consistent with the airport/engine split.
- Known gap: overlapping-but-not-identical edges surface as a cluster of cusps rather than one
  overlap finding — see `docs/taxi-graph-audit.md` "What it does not do (yet)".
