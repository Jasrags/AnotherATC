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
- ✅ **Spawn / despawn (traffic flow)** — intent-driven: departures start at gates → RWY, arrivals appear on a 4 nm final → land → gates; deterministic spawner, goal completion despawns, dep/arr score.
- ✅ **Named destinations** — selected strip shows a clearance row: RWY 27 / RWY 9 (auto hold-short), arrival's gate, Hold, Cross RWY. Goal-append makes "taxi to RWY" stop at the hold line. _Next: pick an arbitrary gate/spot; assigned-route ("via B, C")._
- 🚧 **Aircraft separation / conflict** — following separation, runway single-occupancy, conflict alerts (red ring + HUD). Right-of-way uses a deterministic *total* order (rolling-beats-stopped, id tiebreak), so two aircraft can never both yield → no head-on/intersection deadlock. **Segment reservation (hold-at-junction):** graph-routed traffic treats each taxiway edge as a one-lane resource — the lower-priority aircraft stops *short of the junction* before entering a contested edge and waits for the other to clear, instead of driving through it. Automatic no-overlap floor. _Next: **player-instructed** give-way / reroute / sequencing (ties into Assigned taxi routes); HS1-specific incursion._
- ✅ **Parallel-taxiway diversion** (separation follow-up) — when the yielder has been reservation-held at a junction for a sustained interval (`DIVERT_AFTER_SEC`), it reroutes to its current destination *around* the contested edge, if a path avoiding it exists and the detour stays within `DIVERSION_COST_FACTOR`× the direct route; otherwise it keeps waiting (no regression on the no-parallel corridor). Graph primitive `routeAvoiding` (Dijkstra excluding blocked edges) + per-clearance diversion memory. Deterministic (fixed-timestep hold accrual). The full fix for the pass-through degrade cases.
- ⬜ **Gridlock hardening** (separation follow-up) — the two-aircraft reservation is deadlock-free; a ≥3-aircraft occupancy cycle *could* gridlock in principle. **Probed post-diversion:** a counter-rotating 3-aircraft ring (each wanting an edge the next occupies) already resolves — the total-order reservation staggers them and all three reach goals; no freeze. A genuine forced no-parallel cycle is contrived to construct and needs new reverse-motion (back-off) kinematics. **Deferred** as low-frequency until a real gridlock is observed. _If needed: build a waits-for graph each tick, detect a cycle where every member's diversion failed, lowest-rank backs off._
- 🚧 **Assigned taxi routes** — clearance as a sequence of named taxiways ("via B, C"). **Shipped:** graph edges carry designators; `routeVia` follows an ordered taxiway sequence (falls back to shortest path); `taxiVia`/`taxiViaGoal` commands; strips display "VIA A · B · C" for every route. **Scope builder:** select an aircraft → "Route ▸" → click taxiways in order (highlighted, chips in the strip) → pick a destination to issue; Esc/Cancel to abandon. Re-issuing on a taxiing aircraft = reroute. _Next: readback confirmation; feedback when a via can't reach the goal (currently silently falls back to shortest path)._
- ✅ **Player-instructed give-way / reroute** — **reroute** works (Route ▸ rebuilds a taxiing aircraft's clearance). **Give way to…** works: pick a specific aircraft from the strip menu; the selected aircraft holds while that traffic is near and ahead, then auto-continues once it passes behind / clears (or `Continue taxi` cancels). Layered over the automatic reservation floor as a manual override. _Next: pick the give-way target by clicking it on the scope (vs. the callsign submenu)._
- ✅ **Name untagged taxiway segments** (route-builder data fix) — patched 18 untagged OSM ways to their numbered connector (A1/A2/A3/A5/A6, B1/B8/B9/B10, C2/C4) in `tools/ingest/build-ksan-surface.mjs`, matched by endpoint topology and cross-referenced to the airport diagram; named taxiway coverage 73→91/129. The A/B/C spines were already fully named. Terminal-apron ways and ambiguous junction fillets deliberately left unnamed (you route to the gate, not via apron pavement). Mapping in `docs/SAN/taxiway-naming.md`.
- ✅ **Intersection departures** — every named taxiway/runway intersection is a destination
  (`buildRunwayIntersections`, ordered along the runway in use), so a departure can be taxied to
  hold short partway down the runway instead of only at a threshold. Offered in the Taxi-to
  submenu, and the route builder gains a "Hold short @ Bn" button for the last taxiway picked —
  a via-route has to *end* somewhere, and previously the only ends were the two thresholds, so
  "via B4" silently fell back to the shortest path. The takeoff-run guard already handles the
  shorter roll. _Next: show the runway remaining from the chosen intersection._
- ⬜ **Auto-route + tap-to-edit** (assigned-routes UX enhancement) — instead of building a via-sequence from scratch, show the auto shortest-path as editable "VIA" chips; tapping a taxiway in the sequence offers alternatives to swap/insert, and the rest re-derives. Lower-friction path assignment; complements the scope-click builder.
- 🚧 **Clearance Delivery** — the "Clearance" half of the position. **Shipped:** a parked departure's menu starts at **Deliver clearance**, which assigns a deterministic **squawk** (4-digit octal, shown on the strip) and unlocks **Pushback approved**. Departure flow is now clearance → pushback → taxi → hold short → contact tower. _Next: route/SID + initial altitude + departure frequency on the clearance; read-back verification; slot/EDCT time._
- ✅ **Ground servicing → pushback readiness** — parked departures run parallel ground services (fuel 45s long pole, cargo/catering/water/cabin shorter) that must all finish before pushback unlocks. Opt-in `ServicingConfig` on the sim (backwards-compatible); `pushback` refuses with "ground servicing in progress — Ns" until the long pole completes; snapshot exposes per-service progress + an aggregate `serviceSec`. Strip shows an "SVC Ns" countdown + one progress bar per service; the menu gates "Pushback approved" → "Pushback — servicing Ns" until ready. _Next: per-aircraft duration jitter (seeded); tie into turnaround (arrival services → same aircraft's next departure); gate on a handling-agent resource._
- 🚧 **Pushback from gate** — **shipped:** "Pushback approved" (menu) eases a parked gate departure off the stand onto the nearest taxilane node at creep speed (nose trailing), new `pushback` phase; ~35 s at KSAN gate 39, then it's `holding` (ready) and Taxi/Route unlock. A parked departure now must push back before it can taxi. _Next: gate by servicing readiness; adjacent-gate/alley-traffic coordination; pick a push direction/left-right when the alley has two exits._
- ✅ **Flight strip bay (ground)** — status-driven strips beside the scope, phase-gated actions, selection synced with the scope. _Next: squawk/route fields, drag-reorder/sequence._
- ✅ **Routing-graph contraction + admin overlay** — the OSM surface gave the router ~1157 vertices when the network has only ~159 real decision points (junctions, endpoints, name changes). `graph.topology()` contracts pass-through vertices into geometry-preserving edges (edges keep the full polyline + true length, so driving still follows the curve) and flags long dead-straight runs for chart review. Admin overlay (GRAPH button / `g` key) draws the graph over the surface — junctions emphasized, flagged straight edges in pink — to spot geometry issues fast. _Next (**#2**): eyeball the ~4 flagged 2-point chords (taxiway C 936ft past the North Ramp is the "drove through the terminal" one) against the airport diagram and patch missing centerline vertices in `tools/ingest`. Later: optionally migrate routing itself onto the contracted graph (needs edge-snapping so gate stubs don't regress)._
- ⬜ **HS1 hotspot** — render the KSAN hot spot; incursion-risk awareness
- ⬜ **Ground conflict / incursion alerts** — two aircraft converging, or one entering an occupied runway
- 🚧 **Handoff to/from Tower** — **Contact tower** now performs a real Ground→Tower control transfer (`controlledBy` flips; the strip moves to the TWR bay). Tower then issues **line up and wait** and an explicit **cleared for takeoff** (full-power accel to 140 kt, exempt from taxi caps/conflict; lifts off the far end, counted `departed`). Runway single-occupancy + wake separation gate the takeoff clearance. Cross runway is only for transiting traffic. **Tower→Ground on arrival** also works now: a landed aircraft flips back to Ground once it has rolled out to taxi speed and can leave the runway (Slice 2). See **Tower (Local Control)** epic + `docs/atc-tower.md`. _Next: refuse a handoff when Tower is overloaded._
- 💭 Multiple ground frequencies (N/S) — not needed at KSAN's scale
- 💭 Progressive taxi / follow-the-greens visualization

---

## ⬜ Flight-strip command menu (interaction model)

Reference: the ground-ATC command menu in an EHAM/Schiphol ATC sim — a numbered, state-dependent
list opened for the selected aircraft. Goal: replace the inline clearance-row buttons with a proper
**command menu opened from the flight strip**, showing only the actions valid for the aircraft's
current phase, with submenus for commands that need a target. This is the interaction model that the
individual command features below plug into; it generalizes across controller modes later.

### Menu framework
- ✅ **Command menu on the selected strip** — the selected strip shows a numbered, data-driven action
  list (`StripCommandMenu`); `1`–`9`/`0` keyboard shortcuts run the matching item. _Next: optional
  float/popup anchored to the strip like the reference (currently inline)._
- ✅ **State-gating** — `commandsFor(status, intent)` lists only phase-valid actions (parked → Pushback·Taxi·Route;
  taxiing → Hold·Give-way; holding → Continue; holding short → Cross). Not-yet-built commands render as
  disabled `soon` so the flow still reads.
- ✅ **Submenus (`>`) for parameterized commands** — Taxi to… opens a destination submenu (RWY 27/9, gate).
  _Next: submenus for Hold short…, Cross runway (multi), Give way to… (pick aircraft on the scope)._
- ✅ **Migrated existing clearance-row actions** — Taxi to, Hold position, Cross runway, Route via…, and
  Continue taxi now all live in the menu; the old ad-hoc clearance row is gone (route builder stays for `Route via…`).

### Commands (menu vocabulary from the reference)
- 🚧 **Taxi to…** — named-destination submenu wired; via-route builder via **Route via…**.
- 💭 **Progressive taxi** — step-by-step "turn here" guidance (see Progressive taxi above).
- ✅ **Continue taxi** — wired to `resume` (shown when holding). _Next: "continue to…" submenu._
- ⬜ **Hold short…** — hold short of a chosen runway/taxiway (generalize runway hold-short to any target).
- ✅ **Cross runway** — wired to `crossRunway` (shown when holding short). _Next: submenu to pick the runway._
- ✅ **Give way to…** — submenu of nearby traffic (by callsign); runs `giveWay`, the aircraft holds for that traffic then auto-continues. _Next: pick the target on the scope._
- ✅ **Hold position** — wired to `hold` (shown when taxiing).
- ✅ **Pushback approved** — wired: shown for a parked gate departure; runs the `pushback` phase, after which Taxi/Route unlock (see Pushback from gate).
- ⬜ **Misc. messages** — catch-all phraseology (say again, expedite, verify heading/altitude, etc.).
- ✅ **Contact other frequency** — `Contact tower` wired for a departure holding short (Ground→Tower handoff, completes the departure); stays `soon` in other states until more frequencies/modes exist.

### Supporting systems shown in the reference
- ⬜ **Communications log** — timestamped readback/clearance transcript in ATC phraseology (ties into
  Read-back verification + 💭 Voice/phraseology).
- ⬜ **Richer strip / data-block header** — GS, IAS, altitude, heading, active state on the selected aircraft.
- ⬜ **Quick-state tabs** — small summary of the aircraft's current clearance on the strip (e.g. "Pushback",
  "Taxi 24"), as fast context + shortcuts.

---

## Controller modes (epics)

The game models four positions (see `docs/atc-flight-strips.md`). Ground first, then:

### 🚧 Tower (Local Control)
Design note: `docs/atc-tower.md` (one sim, two projections; Ground and Tower own the same fleet).
- ✅ **Slice 1 — Tower owns departures.** `contactTower` is now a Ground→Tower control transfer
  (`controlledBy` flips), not an instant launch. Tower issues **line up and wait** (taxi onto the
  centerline, new `lineUpWait` status) and **cleared for takeoff** (the roll) — takeoff is legal
  directly from hold-short (fast path) or from LUAW. Runway-clear + wake-separation gates moved to
  the takeoff clearance. Web: Tower command menu (LUAW / cleared for takeoff) + **Ground | Tower
  position switch** (tabs filter strips by owner, live counts).
- ✅ **Slice 2 — Tower owns arrivals** (first airborne physics). Arrivals originate under Tower on
  a 4 nm straight-in final (`altitude` derived from range to the threshold → a ~3° descent, no
  integration drift). **Cleared to land** arms the landing; touchdown at the threshold hands the
  aircraft to surface kinematics decelerating down the runway; at taxi speed it is handed to
  **Ground** and routed to its gate (existing dwell / `arrived` counter). Uncleared at the
  threshold → automatic **go-around** back to the fix (stub — closes the state-machine hole; the
  player-issued command is Slice 3). One `blocksRunway` predicate — surface occupants plus anyone
  inside 1.5 nm final — now gates line-up, takeoff, crossing, and landing alike. Web: Tower arrival
  menu with a visible "runway busy" reason, FINAL/CLR LAND/ROLLOUT strips with range + altitude,
  hollow airborne targets on the scope. _Next: arrival sequence numbers; pick the turnoff exit._
- ✅ **Slice 3a–3c — runway exits & the real post-landing procedure.** Turnoffs are first-class
  objects derived from the ingested geometry (`runwayExits.ts`): the leg making the shallowest
  angle with the landing direction classifies a connector as a **rapid exit** (≤60°, 40 kt) or
  **standard** (~90°, 12 kt), and a connector pointing back down the runway is correctly excluded
  as the *other* direction's exit. The rollout now aims at a turnoff with a **solved** braking
  rate so it arrives at that turn's speed, making runway occupancy vary with the choice (high-speed
  vs. far end = 15+ s). Tower owns both decisions: **`assignExit`** (on final or mid-roll, refused
  as "unable B5" when it can't slow down in time) and **`contactGround`**, which replaces the
  automatic handoff — issued on the roll it is the real *"when vacated, contact ground"*. **Vacated
  now means past the turnoff's hold-short point**, so a landing holds the runway as long as it
  really would. _Next: 3d._
- ✅ **Runway geometry from the FAA survey** (branch) — `docs/SAN/runway-9-27.md`. Both KSAN
  thresholds are displaced (1,000 ft on 09, **1,810 ft** on 27), so the landing threshold is not
  the end of the pavement; declared distances (TORA 8,280/9,401, LDA 7,280/7,591) are carried
  rather than derived, because on 09 they do not reduce to two points. Per-end glide path (3.3°
  / 3.5°). EMAS 315 × 218 ft at the **west** end. Markings — pre-threshold arrows, threshold
  bars, designators, EMAS chevrons — drawn from the surveyed layout. A departure is refused when
  it has insufficient runway ahead of it in the direction in use.
- ⬜ **Slice 3d — communications log + read-back**: the arrival procedure is 4–5 transmissions and
  none are visible today. Also open: wake spacing on final, arrival sequence numbers, a
  player-issued go-around, hold-short during rollout, ATIS/weather line.
- 💭 **Ramp Control** — a third layer after Ground at large hubs (airline/airport-run, not FAA).
  Deferred: adds a frequency without adding a decision until gate conflicts + pushback contention
  exist (see Turnaround).
- ⬜ Departure releases / wheels-up windows from TRACON _(deferred — needs TRACON)_
- ⬜ **Naming debt** — the sim module is `packages/sim/src/ground/` / `createGroundSim` but now
  models Tower (airborne) state too. Revisit the name after Tower lands (likely `local/` or `atct/`,
  since one ATCT facility runs both Ground and Local Control).

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
- 🚧 **Squawk / transponder codes** — beacon code assigned at clearance delivery (deterministic 4-digit octal), shown on the strip. _Next: link the code to a radar target once airborne (feeds TRACON radar contact)._
- ⬜ **Turnaround & gate conflict** — an arrival feeds directly into the same aircraft's next departure cycle; short-turn timer; **gate conflict** when an arrival's gate is still occupied by a late departure. High-tension Ground/Ramp mechanic called out in the design docs.
- ✅ **Sim ↔ UI bridge** — `GroundController` store + `useSyncExternalStore` for strips (canvas stays on rAF; strips re-render only on phase/selection change)
- ⬜ **Time controls** — pause / 1× / 2× / 4× (fixed timestep already supports it)
- 🚧 **ATIS / airport config** — **shipped (branch `runway-config-and-declared-distances`):** one
  active runway direction, switchable in-game (`RWY 27` / `RWY 09` control). Arrivals and
  departures always share it — the game previously landed RWY 9 while departing RWY 27, head-on
  on a single runway. The configuration drives the arrival final, the departure end, the exit
  set and the glide path. **Runway-change cascade** shipped too: a change is refused while anything is
  committed to the runway in use (on it, or on short final above it); on success every arrival
  still on final goes around and re-establishes on the *new* approach at that end's glide path,
  landing clearances are voided, and departures yet to roll are retargeted to the new departure
  end. _Next: wind + altimeter, an actual ATIS letter._
- ⬜ **Weather** — wind (affects ops), precipitation shading on scopes
- ⬜ **Wake-turbulence model** — categories on strips, spacing constraints
- 🚧 **Scenario / traffic generation** — deterministic spawner (gates → RWY, RWY → gates) in place; want realistic demand curves, schedules, runway-config awareness
- 🚧 **Game loop & scoring** — dep/arr counters in place; want objectives, delays, incidents, difficulty, fail states
- 💭 **Replay / save** — determinism enables record + replay (and later multiplayer)
- 💭 **Voice / phraseology** — TTS readbacks, speech input
- 🚧 **More airports** — **the abstraction is in** (`Airport` bundle in `world/airport.ts`; KSAN is
  now just data in `world/ksanAirport.ts`). The engine holds no airport knowledge and the web
  layer reads the field off `controller.airport`; `world/airport.test.ts` builds a fictional
  north–south field from scratch and plays a full arrival and departure on it. Adding a
  **single-runway** field is now a data exercise — see `docs/adding-an-airport.md` (~1.5–2.5
  days, dominated by OSM taxiway-naming quality and whether the field has tagged gate nodes).
  _Blocked for multi-runway fields: occupancy is field-wide, `ActiveRunway` is one direction, and
  wake separation tracks a single global `lastDeparture` — see §5 of that doc._

### ⬜ Second airport (multi-runway) — candidates

Both measured from the FAA survey (NASR), not assumed. They are **not the same problem**, and the
shared prerequisite is the same for either: runways become first-class objects with their own
guard, occupancy goes per-runway, wake separation goes per-runway, and the configuration becomes a
*set* of active runways rather than one `ActiveRunway`. **≈ 1 week** before either field is
touchable.

- ⬜ **KBUR — the intersecting case** *(recommended first)*. Two runways: **08/26** 5,802 ft
  (091°/271°, ILS on 08) and **15/33** 6,886 ft (167°/347°), **crossing at 66% along 08/26 and 79%
  along 15/33**. Needs a time-and-position conflict model at the crossing, hold-short-of-the-
  intersecting-runway, and timed departures between arrivals; LAHSO optional. Because the crossing
  is past both midpoints, intersection departures before it fall out of the mechanic we already
  have. Compact field, one new rule on top of the foundation. _+3–5 days._
- ⬜ **KOAK — the parallel/dependent case**. Four runways, **zero intersections**: **10L/28R**
  (5,457 ft) and **10R/28L** (6,213 ft) are parallel and only **1,001 ft apart** — well under the
  ~2,500 ft dependent-approach threshold, so they are *not* independent and arrivals must be
  staggered; plus **12/30** (10,520 ft, ILS both ends) on the separate South Field 5,688 ft away,
  and **15/33** (3,376 ft). Needs two runways active simultaneously, separation-keyed dependency
  rules, wake between parallels, and a scope/Ground flow that copes with two physically separate
  fields. _+5–8 days, and much easier once KBUR has proven the foundation._

Both are larger fields than KSAN, so the OSM taxiway-naming risk scales. **Before committing to
either, pull the Overpass extract and count untagged ways touching the movement area** — that
number decides whether it is 1.5 weeks or 2.5. Process: `docs/adding-an-airport.md`; sourcing:
`docs/airport-data-pipeline.md`; do not skip `docs/lessons-from-ksan.md`.

---

## Polish / UX

- ✅ Ramp / terminal area labels (Terminal 1/2, North Ramp, Air Cargo Ramp, General Aviation, Coast Guard). _Missing: West/Island Ramp Parking (unnamed in OSM), Fire Station/TWR/Admin point features._
- ✅ HS1 hotspot marker (dashed orange circle near GA / taxiway H)
- ✅ Gate stands: clean gate-node markers + zoom-gated numbers (T2 20–51, T1 101–119 from OSM gate nodes, matching the researched scheme); spawn from terminal gate nodes
- ✅ Mobile: pinch-zoom / touch pan / tap-select, responsive stacked layout, LAN dev hosting
- ⬜ Label density control (show major spines when zoomed out, exits when zoomed in) + collision avoidance
- ✅ **Zoom-to-fit + off-screen traffic** — **FIT** button / `f` frames the airport *and* all traffic (`fitPoints` takes arbitrary world points, so it generalizes to climb-outs and TRACON). The final approach course is drawn as the extended centerline with 1-nm range ticks, and airborne traffic outside the viewport gets an edge chevron labelled callsign + range. _Next: scale bar / range rings._
- ⬜ Scale bar / range rings
- ⬜ Pan/zoom clamping (don't lose the airport off-screen)
- ✅ Runway turnoffs drawn along their real geometry for the selected arrival, assigned one emphasized
- ⬜ Gate docking guidance on arrival (AGNIS/PAPA-style stop/center cue), park on the painted stop mark
- ⬜ Aircraft symbology by category/phase; selected-target emphasis
- ⬜ Data-block declutter (leader-line direction, overlap avoidance)
- ⬜ Theme polish; light/dark intentional (currently dark-only, correct for a scope)
- ⬜ Reduced-motion + accessibility pass

---

## Tech debt / known limitations

- ⬜ Destinations are raw clicks snapped to nearest node (see named destinations)
- ⬜ Hold-short stops at the last taxi vertex before the runway zone, not the exact painted hold line (`holding_position`) — but a runway destination now routes to the threshold's own-side hold node (not across the runway), so it holds ~0.03–0.06 nm short of the correct departure end
- ⬜ Taxi routes are shortest-path, not operationally realistic assigned routes
- ⬜ Graph-routed head-ons hold at the junction (no overlap) and now **divert** onto a parallel taxiway when one exists within the cost cap. Residual: non-graph/hand-set paths (no edge topology → no reservation/diversion), and a contrived no-parallel ≥3-aircraft cycle (see Gridlock hardening — deferred)
- ⬜ Arrivals park at the nearest taxiway node + a straight leg to the gate point, not the real stand geometry
- ⬜ Surface redrawn every frame; consider offscreen-canvas caching if perf needs it
- ⬜ Scenario stitches arbitrary long taxiways for demo traffic — replace with real gate→runway flows
- ℹ️ Headless screenshots show T+00:00 (Chrome virtual-time doesn't drive rAF) — motion is fine live

---

## Testing / infra

- ✅ **Dev/admin sandbox** (`?dev`) — empty surface, spawner off, plus a control bar. **SPAWN**: click the surface to drop a test aircraft (snaps to the nearest routing node, auto `DEVnn`); drive it with the normal commands; **GRAPH** (the routing-graph overlay, and its `g` key) is dev-only — outside the sandbox the bar is just the two gameplay controls, RWY and FIT. **ARRIVAL** puts a test arrival on the final approach of the *active* runway (airborne — it can't be placed by clicking the surface) and switches to the Tower bay; successive spawns stagger 1.2 nm down the final. **X** removes the selected, **CLEAR** wipes all. **PROBE**: click two points to draw the shortest graph path between them with a live length + taxiway-sequence readout (no route → dashed red). Works alongside the **GRAPH** overlay. Sim gained `add`/`remove`/`clear`. _Next: param picker (type/wake/intent), exact (off-network) placement, step/pause, save/replay._
- ⬜ Playwright E2E for the interaction flows (needs dependency vetting per policy)
- ⬜ Socket.dev GitHub app on the repo (CI already runs audit + osv-scanner)
- ⬜ Coverage reporting + targets
- ⬜ Visual regression on the scope (screenshots at breakpoints)
