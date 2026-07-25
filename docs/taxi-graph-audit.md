# Taxi-graph geometry audit

**Status:** built. A deterministic linter over a field's contracted taxi graph, plus a `make`
target and a thin skill. Replaces eyeballing intersections one at a time with one ranked report.

The taxi graph is built from OSM surface data (`docs/airport-data-pipeline.md`), and OSM
digitization is uneven: the same taxiway centreline gets drawn twice under two names, a junction
lands a few feet off its neighbour, a corner is cut with a single hard vertex. On the scope those
read as the spiky "stars" at intersections and the doubled paint. This audit finds every rough spot
at once so the worst can be worked down first, instead of discovering them one intersection at a
time in play.

## What it checks

The audit reads the contracted `TaxiTopology` (decision nodes + geometry-preserving edges) and
returns findings ranked worst-first, each with a **world coordinate to jump to** and a **suggested
smoothing** (a suggestion — nothing is auto-applied; relocating a node is a data decision).

| Kind | Severity | What it means | Suggested fix |
|---|---|---|---|
| `cusp` | HIGH | two edges leave a node < 30° apart — a spike / the star artifact | relocate or merge the node so edges leave along the real pavement |
| `near-duplicate-nodes` | HIGH | two nodes < 15 ft apart — a routing ambiguity | merge to the midpoint |
| `disconnected` | HIGH | an island unreachable from the main network (one finding per island) | connect it, or drop the orphaned pavement |
| `tight-turn` | MED | 30–60° between edges at a node — sharper than an aircraft taxis | round the corner toward ≥ 60° |
| `stub-edge` | MED | a contracted edge < 25 ft long | collapse the stub — merge its endpoints |
| `duplicate-edge` | MED | more than one edge between the same node pair | keep one; drop the redundant paint |
| `kink` | MED/LOW | a sharp bend (> 40°) inside one edge's polyline | resample smooth, or split at a real junction |
| `dangling-node` | LOW | a dead-end far (> 120 ft) from any runway end or stand | connect or remove — anything routed to it strands |

Only the **sharpest** angle-finding is reported per node, and only **one** finding per disconnected
island: a human fixes an intersection (or a component) as a unit, so that is the unit of the finding.

The thresholds are geometry-quality constants (feet / degrees), not airport data — a 20° cusp is a
cusp at every field — so they live in the engine (`packages/sim/src/ground/taxiAudit.ts`), consistent
with the airport/engine split in `CLAUDE.md`.

## Running it

```bash
make audit-taxi                # all fields
make audit-taxi AIRPORT=KBUR   # one field (KSAN | KBUR | KOAK)
```

Or from the skill: **`/audit-taxi KBUR`** — it runs the target, summarizes the counts, and offers to
open the worst spots.

Programmatically:

```ts
import { auditAirport, formatReport, auditTaxiGraph } from '@anotheratc/sim'
const report = auditAirport(KBUR)          // build graph + endpoints + audit, in one call
console.log(formatReport('KBUR', report))
// or audit any topology directly:
auditTaxiGraph(graph.topology(), { endpoints })
```

## Baselines (a ratchet, not a target)

`packages/sim/src/world/taxiAudit.airports.test.ts` locks each field's current finding counts as a
**ceiling**. Cleaning a graph can only take them down; the test fails if a change makes a field
worse. Lower the number when you improve a graph. Current baselines:

| Field | total | high |
|---|---|---|
| KSAN | 123 | 67 |
| KBUR | 167 | 77 |
| KOAK | 174 | 70 |

These are large because the graphs really are rough — that is the point. The audit does not fix the
data; it tells you where to look and in what order.

## Automatic smoothing that *is* applied

Two graph-construction passes in `buildTaxiGraph` clean up the most mechanical OSM artifacts before
anything routes on the graph, so they never reach the audit or the scope:

- **Near-coincident node merge** (~30 ft) — folds two vertices OSM digitized a few dozen feet apart
  at one junction into a single node, so a junction routes as one node rather than a severed pair.
- **Collinear-detour collapse** (~15 ft) — where the same run of pavement is drawn twice (a named
  taxiway A→B and an unnamed way shadowing it through an extra vertex M that sits right on segment
  A–B), the shadow midpoint is dropped and the direct edge kept. This removes the doubled-paint
  "spike" cusps at A and B. A detour that genuinely bows away from the line (a real bypass or a
  curve) is **left alone** — only a near-collinear shadow collapses, so no real geometry is lost.

Both are conditional and self-limiting; they fire only on the artifact, never on distinct pavement.

## What it does not do (yet)

- **No auto-smoothing.** By design — the fix (merge these nodes, drop this paint, re-digitize this
  corner) is a data edit a human makes, verified by re-running the audit and watching the baseline
  drop.
- **Overlap detection is shallow.** `duplicate-edge` only catches edges between the *same* node
  keys. The collinear-detour collapse above removes the most common overlap (a shadow that shares
  both endpoints), but the same centreline drawn twice with *slightly different* endpoints still
  surfaces as a cluster of `cusp`s rather than one "overlap" finding. A geometry-level overlap check
  is the natural next increment. The remaining cusps are largely **real** shallow junctions —
  bypass aprons and connectors rejoining a parallel — which are geometry to leave alone, not defects.
