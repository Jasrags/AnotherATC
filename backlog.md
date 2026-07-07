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
- ⬜ **Aircraft separation / conflict** — aircraft currently pass through each other; add spacing, give-way, and incursion alerts
- ⬜ **Assigned taxi routes** — clearance as a sequence of taxiways ("via B, C") with readback, not just shortest path
- ⬜ **Pushback from gate** — request → approve → push into the alley, then taxi
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
- ✅ Visible gate stands + zoom-gated gate numbers
- ✅ Mobile: pinch-zoom / touch pan / tap-select, responsive stacked layout, LAN dev hosting
- ⬜ Label density control (show major spines when zoomed out, exits when zoomed in) + collision avoidance
- ⬜ Scale bar / range rings; recenter + zoom-to-fit control
- ⬜ Pan/zoom clamping (don't lose the airport off-screen)
- ⬜ Aircraft symbology by category/phase; selected-target emphasis
- ⬜ Data-block declutter (leader-line direction, overlap avoidance)
- ⬜ Theme polish; light/dark intentional (currently dark-only, correct for a scope)
- ⬜ Reduced-motion + accessibility pass

---

## Tech debt / known limitations

- ⬜ Destinations are raw clicks snapped to nearest node (see named destinations)
- ⬜ Hold-short stops at the last taxi vertex before the runway zone, not the exact painted hold line (`holding_position`)
- ⬜ Taxi routes are shortest-path, not operationally realistic assigned routes
- ⬜ Aircraft ignore each other (no separation/collision); arrivals spawn stationary rather than rolling off the runway
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
