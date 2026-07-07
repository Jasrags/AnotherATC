# KSAN — unnamed taxiway mapping (for ingest ref-patching)

Cross-referenced against the FAA airport diagram (docs/SAN/00373AD.PDF).
Designator set on the chart == OSM: A, A1–A7, B, B1–B10, C, C1–C6, D, F, H, J, P, X — **no missing taxiways**.
Every unnamed feature is an untagged segment of an existing taxiway OR ramp/apron pavement (leave unnamed).

## Resolution

Runway runs SE→NW: `[0.261,-0.077]` (RWY 27) → `[-0.632,0.180]` (RWY 9).

- **~31 features → patch to an existing designator.** Untagged gaps in the A/B/C spines
  and their connectors (A1–A7, B1–B10, C1–C6) where OSM split a way and only tagged part.
  These are the actionable ones — patching fixes route-click, `routeVia`, and labels.
- **~10 "standalone" (no named endpoint) → LEAVE UNNAMED.** All confirmed to sit in terminal
  aprons — idx 294→Terminal 1, idx 149→Terminal 2 West, idx 156 & the west cluster→Terminal 2
  East. These are ramp taxilanes; ATC routes *to* the gate/ramp, not "via" them. Correct as-is.
- **~9 "links" between two mains (C–F, H–C, H–J, J–C, B–A) → low priority.** Short junction
  fillets; assign to the more-connector-like leg or leave. Cosmetic for routing.

Patch these in `tools/ingest/build-ksan-surface.mjs` (same by-way-id mechanism already used
to add taxiway A / A1–A7), then re-run the ingest.

## Applied (2026-07-07)

18 untagged OSM ways patched to their numbered connector (A1/A2/A3/A5/A6, B1/B8/B9/B10, C2/C4)
via `REF_PATCH`, selected conservatively: a segment is named only when an endpoint identifies a
specific numbered connector, or it is collinear with the runway (a spine gap — none turned out to
exist). Named taxiway coverage rose 73→91/129. Terminal-apron ways (Terminal 1, T2 East/West) and
the ~9 junction fillets between two mains (C–F, H–C, H–J, J–C, B–A) were left unnamed on purpose.

| idx | kind | len nm | proposed ref | rationale |
|---|---|---|---|---|
| 294 | taxiway | 0.158 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 149 | taxiway | 0.117 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 156 | taxiway | 0.077 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 291 | taxiway | 0.074 | A2 | connector A2 (ends [["A2"],[]]) |
| 290 | taxiway | 0.073 | A3 | connector A3 (ends [["A3"],[]]) |
| 96 | taxiway | 0.072 | B1 | connector B1 (ends [["B"],["B1"]]) |
| 269 | taxiway | 0.051 | — | LINK B–A — verify (may be unnamed apron lane) |
| 292 | taxiway | 0.044 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 157 | taxiway | 0.043 | B8 | connector B8 (ends [[],["B8"]]) |
| 168 | taxiway | 0.042 | C2 | connector C2 (ends [["J"],["C2"]]) |
| 166 | taxiway | 0.041 | — | LINK J–C — verify (may be unnamed apron lane) |
| 150 | taxiway | 0.037 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 158 | taxiway | 0.035 | B | continuation of B |
| 152 | taxiway | 0.034 | B9 | connector B9 (ends [[],["B9","B"]]) |
| 159 | taxiway | 0.034 | B | continuation of B |
| 154 | taxiway | 0.034 | P | continuation of P |
| 236 | taxiway | 0.034 | C4 | connector C4 (ends [["C4"],["C"]]) |
| 238 | taxiway | 0.034 | — | LINK C–F — verify (may be unnamed apron lane) |
| 237 | taxiway | 0.033 | — | LINK F–C — verify (may be unnamed apron lane) |
| 239 | taxiway | 0.032 | C4 | connector C4 (ends [["C"],["C4"]]) |
| 179 | taxiway | 0.032 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 162 | taxiway | 0.032 | — | LINK H–C — verify (may be unnamed apron lane) |
| 146 | taxiway | 0.031 | X | continuation of X |
| 161 | taxiway | 0.031 | — | LINK H–C — verify (may be unnamed apron lane) |
| 163 | taxiway | 0.030 | — | LINK H–J — verify (may be unnamed apron lane) |
| 164 | taxiway | 0.030 | — | LINK H–J — verify (may be unnamed apron lane) |
| 144 | taxiway | 0.030 | B10 | connector B10 (ends [["X"],["B10"]]) |
| 151 | taxiway | 0.030 | B9 | connector B9 (ends [["B","B9"],[]]) |
| 155 | taxiway | 0.028 | P | continuation of P |
| 167 | taxiway | 0.028 | — | LINK J–C — verify (may be unnamed apron lane) |
| 187 | taxiway | 0.027 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 293 | taxiway | 0.026 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 180 | taxiway | 0.025 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 284 | taxiway | 0.023 | A1 | connector A1 (ends [["A1"],["A"]]) |
| 185 | taxiway | 0.022 | — | STANDALONE (no named endpoint) — likely ramp/apron lane, VERIFY on chart |
| 271 | taxiway | 0.022 | A | continuation of A |
| 148 | taxiway | 0.022 | B | continuation of B |
| 283 | taxiway | 0.022 | A1 | connector A1 (ends [["A"],["A1"]]) |
| 276 | taxiway | 0.021 | A | continuation of A |
| 273 | taxiway | 0.021 | A5 | connector A5 (ends [["B"],["A5"]]) |
| 282 | taxiway | 0.020 | A | continuation of A |
| 281 | taxiway | 0.020 | A | continuation of A |
| 142 | taxiway | 0.020 | B10 | connector B10 (ends [[],["B10"]]) |
| 277 | taxiway | 0.020 | A | continuation of A |
| 289 | taxiway | 0.020 | A3 | connector A3 (ends [["A3"],["A"]]) |
| 279 | taxiway | 0.019 | A6 | connector A6 (ends [["A6"],["B"]]) |
| 147 | taxiway | 0.019 | B9 | connector B9 (ends [["B9"],["B"]]) |
| 145 | taxiway | 0.018 | B10 | connector B10 (ends [["B10"],[]]) |
| 287 | taxiway | 0.018 | A2 | connector? A2/A3 — VERIFY |
| 143 | taxiway | 0.017 | X | continuation of X |

Summary: ~31 inherit an existing designator · ~9 links to verify · ~10 standalone (likely ramp).
