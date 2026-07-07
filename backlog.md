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
- ✅ Makefile (auto-routes through fnm Node 22), watch tasks

---

## 🚧 / ⬜ Ground position (current focus)

The core ground-control loop. Ordered roughly by priority.

- ⬜ **Hold-short of runway / runway-crossing clearances** — aircraft must stop at hold lines (OSM `holding_position`); crossing requires explicit clearance. Highest-value safety mechanic.
- ⬜ **Named destinations** — "taxi to RWY 27", "to gate 32", "to spot" instead of raw map clicks; resolve names → graph nodes
- ⬜ **Assigned taxi routes** — clearance as a sequence of taxiways ("via B, C") with readback, not just shortest path
- ⬜ **Pushback from gate** — request → approve → push into the alley, then taxi
- ⬜ **Flight strip bay (ground)** — the strip UI beside the scope; actions gated by phase (state machine from `docs/atc-flight-strips.md`)
- ⬜ **Spawn / despawn** — departures appear at gates, arrivals roll off the runway; departures exit to the runway, arrivals park
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
- ⬜ **Sim ↔ UI bridge** — external store + `useSyncExternalStore` for strip/HUD state (canvas stays on rAF)
- ⬜ **Time controls** — pause / 1× / 2× / 4× (fixed timestep already supports it)
- ⬜ **ATIS / airport config** — active runway, wind, altimeter; runway-change cascade
- ⬜ **Weather** — wind (affects ops), precipitation shading on scopes
- ⬜ **Wake-turbulence model** — categories on strips, spacing constraints
- ⬜ **Scenario / traffic generation** — realistic arrival/departure demand, airline/type mix, schedules
- ⬜ **Game loop & scoring** — objectives, delays, incidents, difficulty
- 💭 **Replay / save** — determinism enables record + replay (and later multiplayer)
- 💭 **Voice / phraseology** — TTS readbacks, speech input
- ⬜ **More airports** — data pipeline generalizes beyond KSAN

---

## Polish / UX

- ⬜ Ramp / terminal / gate labels; apron names
- ⬜ Scale bar / range rings; recenter + zoom-to-fit control
- ⬜ Pan/zoom clamping (don't lose the airport off-screen)
- ⬜ Aircraft symbology by category/phase; selected-target emphasis
- ⬜ Data-block declutter (leader-line direction, overlap avoidance)
- ⬜ Theme polish; light/dark intentional (currently dark-only, correct for a scope)
- ⬜ Reduced-motion + accessibility pass

---

## Tech debt / known limitations

- ⬜ Destinations are raw clicks snapped to nearest node (see named destinations)
- ⬜ No hold-short logic — aircraft route across the runway freely
- ⬜ Taxi routes are shortest-path, not operationally realistic assigned routes
- ⬜ Surface redrawn every frame; consider offscreen-canvas caching if perf needs it
- ⬜ Scenario stitches arbitrary long taxiways for demo traffic — replace with real gate→runway flows
- ℹ️ Headless screenshots show T+00:00 (Chrome virtual-time doesn't drive rAF) — motion is fine live

---

## Testing / infra

- ⬜ Playwright E2E for the interaction flows (needs dependency vetting per policy)
- ⬜ Socket.dev GitHub app on the repo (CI already runs audit + osv-scanner)
- ⬜ Coverage reporting + targets
- ⬜ Visual regression on the scope (screenshots at breakpoints)
