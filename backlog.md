# AnotherATC — Backlog

Living feature tracker. Groom freely. See `docs/` for domain design (flight cycle,
strips, KSAN charts) and `CLAUDE.md` for architecture.

**Status:** ✅ done · 🚧 in progress · ⬜ planned · 💭 idea/unscoped
**Current focus:** the **Ground / Clearance** controller position at KSAN.

---

## ✅ Shipped

- ✅ Hardened pnpm workspace: `packages/sim` (headless core) + `apps/web` (React/Vite), ESLint sim/UI boundary
- ✅ Supply-chain policy: 24h cooldown, `allowBuilds` allowlist, exact pins, CI gates (`docs/security/dependency-policy.md`)
- ✅ Deterministic sim foundation: seeded RNG, fixed-timestep loop
- ✅ KSAN surface data ingested from OpenStreetMap → local nm projection (`tools/ingest/`)
- ✅ Ground scope (ASDE-X): Canvas2D render, dark theme, taxiway network, runway, aprons, data blocks, velocity vectors, pan/zoom, HUD
- ✅ Taxi kinematics: aircraft follow routes, accelerate/hold, deterministic
- ✅ Taxiway graph + Dijkstra routing (`buildTaxiGraph`)
- ✅ Command/dispatch (reducer pattern): `taxiTo`, `hold`, `resume`
- ✅ Interaction: click-select, click-to-taxi, right-click hold, Esc deselect, route + selection display
- ✅ Map labels: taxiway designators, runway 9/27
- ✅ Hold-short of runway: taxi routes auto-stop at the hold line (amber); "cross runway" (C) clearance releases them
- ✅ Flight strip bay (ground): status-driven strips, phase-gated actions, scope↔strip selection sync
- ✅ Sim↔UI bridge: `useSyncExternalStore` store (canvas on rAF, strips re-render only on phase/selection change)
- ✅ Traffic flow: intent (departure/arrival), deterministic spawner, goal completion + despawn, dep/arr score; "Taxi ▸ RWY/Gate" from strips
- ✅ Named destinations: per-strip clearance row (RWY 27/9, gate, hold, cross); named runway taxis auto hold-short
- ✅ Map labels polish: signage-yellow taxiway IDs with halos, kept off the runway; taxiway A + A1–A7 added (OSM lacked them, patched by way-id in ingest)
- ✅ Makefile (auto-routes through fnm Node 22), watch tasks

---

## 🚧 / ⬜ Ground position (current focus)

The core ground-control loop. Ordered roughly by priority.

- ✅ **Hold-short of runway / runway-crossing clearances** — routes stop at the runway; press C to clear across. _Next: snap the stop to the exact `holding_position` line; require Tower coordination._
- ✅ **Spawn / despawn (traffic flow)** — intent-driven: departures start at gates → RWY, arrivals appear off RWY → gates; deterministic spawner, goal completion despawns, dep/arr score.
- ✅ **Named destinations** — selected strip shows a clearance row: RWY 27 / RWY 9 (auto hold-short), arrival's gate, Hold, Cross RWY. Goal-append makes "taxi to RWY" stop at the hold line. _Next: pick an arbitrary gate/spot; assigned-route ("via B, C")._
- 🚧 **Aircraft separation / conflict** — following separation, runway single-occupancy, conflict alerts (red ring + HUD). Right-of-way uses a deterministic *total* order (rolling-beats-stopped, id tiebreak), so two aircraft can never both yield → no head-on/intersection deadlock. **Segment reservation (hold-at-junction):** graph-routed traffic treats each taxiway edge as a one-lane resource — the lower-priority aircraft stops *short of the junction* before entering a contested edge and waits for the other to clear, instead of driving through it. Automatic no-overlap floor. _Next: opportunistic **diversion** onto a parallel taxiway (vs. waiting) where one exists; **player-instructed** give-way / reroute / sequencing (ties into Assigned taxi routes); harden ≥3-aircraft occupancy cycles; HS1-specific incursion._
- ⬜ **Parallel-taxiway diversion** (separation follow-up) — when the yielder has a viable parallel route to its goal, reroute it instead of holding at the junction; cost-capped, deterministic. The full fix for the pass-through degrade cases.
- ⬜ **Gridlock hardening** (separation follow-up) — the two-aircraft reservation is deadlock-free, but a ≥3-aircraft occupancy cycle can still gridlock; detect the cycle and break it deterministically (lowest-rank backs off / reroutes).
- 🚧 **Assigned taxi routes** — clearance as a sequence of named taxiways ("via B, C"). **Shipped:** graph edges carry designators; `routeVia` follows an ordered taxiway sequence (falls back to shortest path); `taxiVia`/`taxiViaGoal` commands; strips display "VIA A · B · C" for every route. **Scope builder:** select an aircraft → "Route ▸" → click taxiways in order (highlighted, chips in the strip) → pick a destination to issue; Esc/Cancel to abandon. Re-issuing on a taxiing aircraft = reroute. _Next: readback confirmation; feedback when a via can't reach the goal (currently silently falls back to shortest path)._
- 🚧 **Player-instructed give-way / reroute** — **reroute** now works (Route ▸ on a taxiing aircraft rebuilds its clearance). _Remaining: "give way to traffic" instruction (hold for a specific conflicting aircraft, then continue) layered over the automatic reservation floor._
- ✅ **Name untagged taxiway segments** (route-builder data fix) — patched 18 untagged OSM ways to their numbered connector (A1/A2/A3/A5/A6, B1/B8/B9/B10, C2/C4) in `tools/ingest/build-ksan-surface.mjs`, matched by endpoint topology and cross-referenced to the airport diagram; named taxiway coverage 73→91/129. The A/B/C spines were already fully named. Terminal-apron ways and ambiguous junction fillets deliberately left unnamed (you route to the gate, not via apron pavement). Mapping in `docs/SAN/taxiway-naming.md`.
- ⬜ **Auto-route + tap-to-edit** (assigned-routes UX enhancement) — instead of building a via-sequence from scratch, show the auto shortest-path as editable "VIA" chips; tapping a taxiway in the sequence offers alternatives to swap/insert, and the rest re-derives. Lower-friction path assignment; complements the scope-click builder.
- ⬜ **Clearance Delivery** — the "Clearance" half of the position, currently unmodeled. Issue the pre-departure IFR clearance to a parked departure: route/SID, initial altitude, **squawk**, departure frequency, special instructions; pilot read-back → controller verifies → approval unlocks pushback/taxi. _Gate-phase entry point; pairs with the read-back and squawk mechanics below and slot/EDCT time later._
- ⬜ **Ground servicing → pushback readiness** — parallel-service countdown (fuel/catering/lav/water/cargo/clean/GPU, fueling as the long pole) that gates when pushback becomes available. Model as a few parallel timer bars, not per-service micromanagement (abstracts boarding/loadsheet too). Adds realistic pre-push pressure.
- ⬜ **Pushback from gate** — request → approve → push into the alley (engine start), then taxi; coordinate with adjacent-gate traffic. Gated by servicing readiness above.
- ✅ **Flight strip bay (ground)** — status-driven strips beside the scope, phase-gated actions, selection synced with the scope. _Next: squawk/route fields, drag-reorder/sequence._
- ⬜ **HS1 hotspot** — render the KSAN hot spot; incursion-risk awareness
- ⬜ **Ground conflict / incursion alerts** — two aircraft converging, or one entering an occupied runway
- ⬜ **Handoff to/from Tower** — ground ↔ tower frequency changes at the runway
- 💭 Multiple ground frequencies (N/S) — not needed at KSAN's scale
- 💭 Progressive taxi / follow-the-greens visualization

---

## Controller modes (epics)

The game models four positions (see `docs/atc-flight-strips.md`). Ground first, then:

### ⬜ Tower (Local Control)
- ⬜ Runway environment: line up and wait, takeoff clearance, landing clearance
- ⬜ Wake-turbulence spacing enforcement (Heavy/Super intervals)
- ⬜ Go-around authority (re-injects into TRACON)
- ⬜ Departure releases / wheels-up windows from TRACON
- ⬜ Runway exit assignment on rollout

### ⬜ TRACON (Approach + Departure)
- ⬜ Radar scope (airborne): targets, data blocks, history trails, range rings
- ⬜ Vectoring (heading/altitude/speed), sequencing to final, feeder-fix merges
- ⬜ SID climb-out, STAR descent, approach clearance
- ⬜ Nav fixes / SIDs / STARs authored from KSAN charts (`docs/SAN/`)
- ⬜ Wake-turbulence separation on final

### ⬜ Center (ARTCC / En-route)
- ⬜ Cruise, sector handoffs, metering into destination TRACON

---

## Cross-cutting systems

- ⬜ **Flight data model** — one canonical flight object, mode-specific strip projections (per design docs)
- ⬜ **Flight strip state machine** — shared across modes; phase gates available actions
- ⬜ **Handoff mechanics** — initiate/accept, frequency change, refusal when overloaded
- ⬜ **Read-back verification** — clearance & taxi read-backs the controller must confirm (or catch an error) before the clearance takes effect; the accuracy check is the gameplay, distinct from TTS voice (see 💭 Voice/phraseology). Used by Clearance Delivery and Assigned taxi routes.
- ⬜ **Squawk / transponder codes** — assign a beacon code at clearance delivery; links the strip to a radar target once airborne (feeds TRACON radar contact). Surfaces on the strip.
- ⬜ **Turnaround & gate conflict** — an arrival feeds directly into the same aircraft's next departure cycle; short-turn timer; **gate conflict** when an arrival's gate is still occupied by a late departure. High-tension Ground/Ramp mechanic called out in the design docs.
- ✅ **Sim ↔ UI bridge** — `GroundController` store + `useSyncExternalStore` for strips (canvas stays on rAF; strips re-render only on phase/selection change)
- ⬜ **Time controls** — pause / 1× / 2× / 4× (fixed timestep already supports it)
- ⬜ **ATIS / airport config** — active runway, wind, altimeter; runway-change cascade
- ⬜ **Weather** — wind (affects ops), precipitation shading on scopes
- ⬜ **Wake-turbulence model** — categories on strips, spacing constraints
- 🚧 **Scenario / traffic generation** — deterministic spawner (gates → RWY, RWY → gates) in place; want realistic demand curves, schedules, runway-config awareness
- 🚧 **Game loop & scoring** — dep/arr counters in place; want objectives, delays, incidents, difficulty, fail states
- 💭 **Replay / save** — determinism enables record + replay (and later multiplayer)
- 💭 **Voice / phraseology** — TTS readbacks, speech input
- ⬜ **More airports** — data pipeline generalizes beyond KSAN

---

## Polish / UX

- ✅ Ramp / terminal area labels (Terminal 1/2, North Ramp, Air Cargo Ramp, General Aviation, Coast Guard). _Missing: West/Island Ramp Parking (unnamed in OSM), Fire Station/TWR/Admin point features._
- ✅ HS1 hotspot marker (dashed orange circle near GA / taxiway H)
- ✅ Gate stands: clean gate-node markers + zoom-gated numbers (T2 20–51, T1 101–119 from OSM gate nodes, matching the researched scheme); spawn from terminal gate nodes
- ✅ Mobile: pinch-zoom / touch pan / tap-select, responsive stacked layout, LAN dev hosting
- ⬜ Label density control (show major spines when zoomed out, exits when zoomed in) + collision avoidance
- ⬜ Scale bar / range rings; recenter + zoom-to-fit control
- ⬜ Pan/zoom clamping (don't lose the airport off-screen)
- ⬜ Gate docking guidance on arrival (AGNIS/PAPA-style stop/center cue), park on the painted stop mark
- ⬜ Aircraft symbology by category/phase; selected-target emphasis
- ⬜ Data-block declutter (leader-line direction, overlap avoidance)
- ⬜ Theme polish; light/dark intentional (currently dark-only, correct for a scope)
- ⬜ Reduced-motion + accessibility pass

---

## Tech debt / known limitations

- ⬜ Destinations are raw clicks snapped to nearest node (see named destinations)
- ⬜ Hold-short stops at the last taxi vertex before the runway zone, not the exact painted hold line (`holding_position`)
- ⬜ Taxi routes are shortest-path, not operationally realistic assigned routes
- ⬜ Graph-routed head-ons now hold at the junction (no overlap), but the degrade cases still pass *through*: a shared corridor that extends into the loser's own approach edge, a ≥3-aircraft occupancy cycle, or non-graph/hand-set paths. Full fix needs parallel-taxiway diversion. Arrivals still spawn stationary rather than rolling off the runway
- ⬜ Arrivals park at the nearest taxiway node + a straight leg to the gate point, not the real stand geometry
- ⬜ Surface redrawn every frame; consider offscreen-canvas caching if perf needs it
- ⬜ Scenario stitches arbitrary long taxiways for demo traffic — replace with real gate→runway flows
- ℹ️ Headless screenshots show T+00:00 (Chrome virtual-time doesn't drive rAF) — motion is fine live

---

## Testing / infra

- ⬜ Playwright E2E for the interaction flows (needs dependency vetting per policy)
- ⬜ Socket.dev GitHub app on the repo (CI already runs audit + osv-scanner)
- ⬜ Coverage reporting + targets
- ⬜ Visual regression on the scope (screenshots at breakpoints)
