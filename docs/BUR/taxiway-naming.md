# KBUR — unnamed taxiway mapping (for ingest ref-patching)

Cross-referenced against the FAA airport diagram (`docs/BUR/00067AD.PDF`).
OSM already tags the spine and main connectors: **A, B, C, D, G, A1–A3, B1–B3, BB, C6–C8,
D1–D2, D7–D8, G1**. Everything patched below is an untagged *segment* of one of those (it shares a
node with the named way and reaches the runway edge), or ramp/apron pavement left unnamed.

## Method

Same as KSAN (`docs/SAN/taxiway-naming.md`): match by **endpoint topology**, not proximity. For
each unnamed taxiway touching a runway, take the named taxiway it shares a node with and the point
where it meets the runway. A segment that continues a named connector to the hold line inherits
that connector's designator; a fillet between two connectors, or apron pavement, is left unnamed —
ATC routes *to* the gate, not *via* apron pavement.

**Layout confirmed from the OSM geometry (spans in local nm, x=E/y=N from the ARP):**

- **A** `[-0.076,0.641] → [0.176,-0.179]` — the NE parallel of runway 15/33, running down to meet
  08/26 **east** of the crossing.
- **B** `[-0.087,0.689] → [0.034,-0.176]` — the SW parallel of 15/33, meeting 08/26 **west** of the
  crossing.
- **C** `[0.123,-0.232] → [-0.514,-0.167]` and **D** `[-0.514,-0.167] → [0.425,-0.183]` — the two
  parallels flanking runway 08/26; C6/C7/C8 and D7/D8 are their runway connectors. C's east end
  also reaches 15/33 just past the crossing.
- **G / G1** — the SE apron taxiways by the passenger terminal.

## Applied (2026-07-23)

**19 untagged OSM ways patched** to their connector via `REF_PATCH` in
`tools/ingest/build-kbur-surface.mjs`; named taxiway coverage rose **20 → 39 / 115**. No new
designators were introduced — every patch extends an existing one — and the ingest throws if any
patched way-id is absent on a re-fetch.

| OSM way | touches | at | inherits | rationale |
|---|---|---|---|---|
| 99871903 | 15/33 | 35% | **A2** | continues connector A2 to the runway |
| 221228113 | 15/33 | 53% | **A3** | continues A3 |
| 221228199 | 15/33 | 49% | **A3** | continues A3 |
| 99872086 | 15/33 | 35% | **B2** | continues B2 |
| 221227905 | 15/33 | 53% | **B3** | continues B3 |
| 221228208 | 15/33 | 49% | **B3** | continues B3 |
| 99872054 | 15/33 | 81% | **C** | C's east end reaching 15/33 just past the crossing |
| 99872003 | 08/26 | 56% | **C6** | continues connector C6 |
| 99872004 | 08/26 | 61% | **C6** | continues C6 |
| 99872034 | 08/26 | 50% | **C7** | continues C7 |
| 99872002 | 08/26 | 20% | **C8** | continues C8 |
| 558772698 | 08/26 | 50% | **D7** | continues D7 |
| 558772691 | 08/26 | 21% | **D8** | continues D8 |
| 99872009 | 08/26 | 5% | **C** | C's west end reaching the 08 threshold |
| 99872011 | 08/26 | 5% | **D** | D's west end reaching the 08 threshold |
| 99871973 | 08/26 | 61% | **B** | B reaching 08/26 just west of the crossing |
| 99871976 | 08/26 | 56% | **B** | B reaching 08/26 |
| 221231878 | 08/26 | 70% | **A** | A reaching 08/26 just east of the crossing |
| 221231956 | 08/26 | 75% | **A** | A reaching 08/26 |

## Left unnamed on purpose (10)

| OSM way | touches | at | why unnamed |
|---|---|---|---|
| 99871887 | 15/33 | 18% | run-up / by-pass apron fillet at the 15 threshold (the charted *Aircraft Holding Area and By-Pass Apron*), neighbours both A1 and B1 |
| 99871894 | 15/33 | 12% | same holding-area fillet (A1/B1) |
| 558772692 | 08/26 | 26% | the C8↔D8 crossing throat — ambiguous which connector owns it |
| 558772697 | 08/26 | 43% | the C7↔D7 crossing throat — ambiguous |
| 99871959 | 15/33 | 76% | SE terminal-apron cluster — **dropped 2026-07-24** (see below) |
| 99871960 | 15/33 | 70% | SE terminal-apron cluster — **dropped** |
| 99871982 | 15/33 | 70% | SE terminal-apron cluster — **dropped** |
| 99871991 | 15/33 | 76% | SE terminal-apron cluster — **dropped** |
| 1052138834 | 08/26 | 99% | 2-pt stub at the 26 (east) threshold — runway-end pavement, no connector identity |
| 1066844999 | 15/33 | 4% | stub at the 15 (NW) threshold — runway-end pavement |

## Dropped as orphaned pavement (2026-07-24)

The four **SE terminal-apron cluster** ways above (99871959/60/82/91) form a self-contained loop of
unnamed taxiway NE of the crossing that shares no node with the movement area — the taxi-graph audit
(`docs/taxi-graph-audit.md`) flagged them as an 8-node **disconnected island**. No stand attaches to
it (all 14 gates reach the network elsewhere): it is BUR's GA / remote-parking apron, not yet
modelled as gates (`kburAirport.ts`). Per the "route to the gate, not via apron pavement" discipline
they are removed via a `DROP` set in `build-kbur-surface.mjs` (with the same matched-or-throw guard
as `REF_PATCH`), together with the two `holding_position` markers sitting on them (nodes 1154611488,
8028996387; the third nearby marker 8028996414 is on taxiway C and stays). When GA/charter traffic is
modelled, this apron returns **with** a real connection to the network and its own stands.

## Lower-confidence assignments to re-check on the chart / in play

The **spine-reaches-runway** patches (A, B, C, D applied to 99871973/76, 221231878/1956,
99872009/11/54) label the segment by the spine letter it is physically continuous with. That is
correct pavement identity and safe for routing (graph connectivity is geometric, not name-based),
but if `00067AD.PDF` gives those runway throats their own connector numbers, tighten them then.
Everything else inherits an already-verified numbered connector and is high-confidence.
