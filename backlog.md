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
- 🚧 **Aircraft separation / conflict** — following separation, runway single-occupancy, conflict alerts (red ring + HUD). Right-of-way uses a deterministic *total* order (rolling-beats-stopped, id tiebreak), so two aircraft can never both yield → no head-on/intersection deadlock. **Segment reservation (hold-at-junction):** graph-routed traffic treats each taxiway edge as a one-lane resource — the lower-priority aircraft stops *short of the junction* before entering a contested edge and waits for the other to clear, instead of driving through it. Automatic no-overlap floor. _Next: nothing outstanding — predictive alerts shipped (see **Converging-traffic prediction**); gridlock hardening and rollout-speed separation are tracked separately below._
- ✅ **Parallel-taxiway diversion** (separation follow-up) — when the yielder has been reservation-held at a junction for a sustained interval (`DIVERT_AFTER_SEC`), it reroutes to its current destination *around* the contested edge, if a path avoiding it exists and the detour stays within `DIVERSION_COST_FACTOR`× the direct route; otherwise it keeps waiting (no regression on the no-parallel corridor). Graph primitive `routeAvoiding` (Dijkstra excluding blocked edges) + per-clearance diversion memory. Deterministic (fixed-timestep hold accrual). The full fix for the pass-through degrade cases.
- ⬜ **Gridlock hardening** (separation follow-up) — the two-aircraft reservation is deadlock-free; a ≥3-aircraft occupancy cycle *could* gridlock in principle. **Probed post-diversion:** a counter-rotating 3-aircraft ring (each wanting an edge the next occupies) already resolves — the total-order reservation staggers them and all three reach goals; no freeze. A genuine forced no-parallel cycle is contrived to construct and needs new reverse-motion (back-off) kinematics. **Deferred** as low-frequency until a real gridlock is observed. _If needed: build a waits-for graph each tick, detect a cycle where every member's diversion failed, lowest-rank backs off._
- 🚧 **Assigned taxi routes** — clearance as a sequence of named taxiways ("via B, C"). **Shipped:** graph edges carry designators; `routeVia` follows an ordered taxiway sequence; `taxiVia`/`taxiViaGoal` commands; strips display "VIA A · B · C" for every route. **Scope builder:** select an aircraft → "Route ▸" → click taxiways in order (highlighted, chips in the strip) → pick a destination to issue; Esc/Cancel to abandon. Re-issuing on a taxiing aircraft = reroute. **Read-back: done**, by the comms work rather than by this item — every taxi clearance transmits with a read-back echoing the route ("Runway 27 via Alpha, Bravo, Bravo 4, SKW412"), and it is built from `taxiwaysFor(ac)`, the route the aircraft is *actually* on, so it can never parrot an instruction the aircraft isn't flying.
  _Next — **the silent fallback** (`sim.ts` `routeVia`): `const route = via.length > 0 ? via : graph.route(...)`. A via-sequence that cannot reach the goal is not refused; it silently routes shortest-path and returns **accepted**. You ask for "via B, C", get a green accept, and the aircraft taxis via A and D — the read-back naming the real route is the only cue. `no taxi route via those taxiways` fires only when even the fallback fails. Same class as the `contact ground`/`resume` bugs fixed 2026-07-22: the sim answering "yes" when the answer is "no, but here is something else". Real ground control says "unable via Bravo" and lets the controller decide. **Two open questions before building it:** (1) honour a partial via (follow B as far as it goes, then shortest-path onward) or refuse outright — refusal is more honest, partial is closer to how a controller amends a clearance mid-conversation; (2) a refusal has to land in the notice line and leave the route-builder draft **intact** so it can be edited rather than rebuilt._
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
- 🚧 **Clearance Delivery** — the "Clearance" half of the position. **Shipped:** a parked departure's menu starts at **Deliver clearance**, which assigns a deterministic **squawk** (4-digit octal, shown on the strip) and unlocks **Pushback approved**. Departure flow is now clearance → pushback → taxi → hold short → contact tower. **Read-back verification is live** (2026-07-22): a pilot mishears the code about one clearance in seven and squawks what they read back; the strip and the transcript always agree, so catching it means comparing them against the controller's own instruction. Uncaught, it reaches the runway and **Ground's handoff to Tower is refused** ("verify transponder code") — the first and only place it costs anything, and "say again" is the fix. The code outlives later clearances (`issuedSquawk` vs `squawk`), which is what makes an uncaught error traceable at all; it used to be forgotten one clearance later, so it could never bite and never be corrected. Caught/made is scored on the scope header. **Wheels-up windows (EDCT) are live** (2026-07-22): about a third of departures get a slot with their clearance, read out with the squawk and shown on the strip from the gate onward. Tower may line up and hold inside the window but a takeoff clearance before it opens is refused; miss it and a new slot is issued further out, with the aircraft still sitting on everyone else's runway. Met/total scored on the scope header. The delay **cascades**, and it fell out rather than being built: an aircraft queued behind a slot-holder blows its own window while it waits, is re-issued, and waits again. The *lead* is the field's number (`Airport.slots`, measured against KSAN's ~7 min clearance→hold-short); the ±2 min window and the penalty are the flow system's and live in the engine — see the airport/engine split in CLAUDE.md. _Next: route/SID + initial altitude + departure frequency on the clearance — those are TRACON's to define and Clearance Delivery's only to read out, so they wait for SIDs (see the TRACON section). With slots done, that is all that remains here._
- ✅ **Ground servicing → pushback readiness** — parked departures run parallel ground services (fuel 45s long pole, cargo/catering/water/cabin shorter) that must all finish before pushback unlocks. Opt-in `ServicingConfig` on the sim (backwards-compatible); `pushback` refuses with "ground servicing in progress — Ns" until the long pole completes; snapshot exposes per-service progress + an aggregate `serviceSec`. Strip shows an "SVC Ns" countdown + one progress bar per service; the menu gates "Pushback approved" → "Pushback — servicing Ns" until ready. _Next: per-aircraft duration jitter (seeded); tie into turnaround (arrival services → same aircraft's next departure); gate on a handling-agent resource._
- 🚧 **Pushback from gate** — **shipped:** "Pushback approved" reverses the aircraft down its own
  painted lead-in line (nose trailing, creep speed) to where that line meets the taxilane, then
  it's `holding` (ready) and Taxi/Route unlock. Previously it pushed toward the nearest graph
  node, which is why aircraft backed off stands in directions the paint never goes. _Next:
  adjacent-gate/alley-traffic coordination; pick a push direction when the alley has two exits._
- ✅ **Stand geometry (lead-in / lead-out lines)** — a stand is a line, not a point
  (`ground/stands.ts`): the painted lead-in ordered taxilane→nose-stop, from OSM
  `parking_position` ways (all 32 T2 stands, some genuinely curved). Their direction is
  inconsistent (28 one way, 4 the other) so the stand end is resolved per line against the gate
  node; they are matched **by designator, never by proximity** (nearest-endpoint matching picks a
  neighbour's line for a third of the field). T1 (101–119) has none mapped, so those are derived
  off the nearest taxi pavement and flagged `source: 'derived'`. Arrivals route to the line's
  entry then follow the paint; pushback reverses along it; aircraft creep at marshalling pace
  within the line's length of the stop. Drawn on the scope with a stop bar, derived ones dashed.
  _Next: real stand occupancy (one aircraft per stand at a time); AGNIS/PAPA-style docking cue;
  hand-digitise T1's lead-ins from the airport diagram (see `docs/airport-data-pipeline.md`)._
- ✅ **Flight strip bay (ground)** — status-driven strips beside the scope, phase-gated actions, selection synced with the scope. _Next: squawk/route fields, drag-reorder/sequence._
- ✅ **Routing-graph contraction + admin overlay** — the OSM surface gave the router ~1157 vertices when the network has only ~159 real decision points (junctions, endpoints, name changes). `graph.topology()` contracts pass-through vertices into geometry-preserving edges (edges keep the full polyline + true length, so driving still follows the curve) and flags long dead-straight runs for chart review. Admin overlay (GRAPH button / `g` key) draws the graph over the surface — junctions emphasized, flagged straight edges in pink — to spot geometry issues fast. _Next (**#2**): eyeball the ~4 flagged 2-point chords (taxiway C 936ft past the North Ramp is the "drove through the terminal" one) against the airport diagram and patch missing centerline vertices in `tools/ingest`. Later: optionally migrate routing itself onto the contracted graph (needs edge-snapping so gate stubs don't regress)._
- ✅ **The non-terminal stands are usable** — 23 painted lines with no gate node (**N1–N10** North
  Ramp, **W2–W4** West/Island, **11–14** commuter, **1–5** east side, 50A) are now stands built
  from the line alone, oriented on the taxi network instead of a gate node: the end nearer the
  pavement is the entry. `Stand.kind` separates `terminal` from `remote`; the spawner stays on
  terminal gates (what belongs on a freight apron is a scenario question), but everything else
  treats them the same — drawn, occupied, holding arrivals off, and offered by gate reassignment.
  Refs are case-normalised (OSM had a lone lowercase `n6`). _Next: the 17 untagged parking lines._
- ✅ **Traffic fleets — cargo and GA, and the crossings that come with them.** Runway 09/27
  divides KSAN: every passenger gate is south of it, the **North Ramp (N1–N10)** and the
  **east-side GA stands (1–5)** are north. The spawner only used terminal gates, so nothing ever
  needed to cross — the whole crossing exchange, the Ground↔Tower handoff for it,
  hold-short-with-a-reason and the incursion alerts were reachable only by contrivance.
  Traffic is now generated per **fleet**: a class of traffic with its own stands, identities and
  weight. Fleets exist because *what an aircraft is decides where it parks* — choose the stand
  first and you put freighters on jet bridges in proportion to how many jet bridges the field
  has. Weight is movements, not stands: those aprons are a good share of the parking and a small
  share of the day. KSAN runs airline (10) / cargo (2) / GA (2); cargo brings **Heavies** to the
  North Ramp and GA brings **Lights** to the east side, so the wake matrix finally sees the
  pairing it was written for. `SpawnConfig.gates`/`identity` are *replaced* by `fleets`, not sat
  beside them, so there is one source of truth for who parks where. End-to-end test flies the
  whole thing: land → roll out → contact ground → taxi → hold short → cross → park.
  **Per-fleet servicing is now in** (2026-07-22): `SpawnFleet.servicing` overrides the field's
  profile, and the aircraft carries its fleet so it is serviced as what it is — including after a
  turnaround, when the spawner is long out of the picture. KSAN has three tempos: airline (fuel
  45s the long pole), cargo (**freight** 68s — freighters are the field's Heavies *and* they park
  across the runway, so time on stand is pressure on the crossing), GA (fuel 16s, preflight 9s —
  traffic that appears, pushes and goes). No UI work: the strip already drew one bar per service.
  The profile is on the *fleet* rather than the field because it is a fact about the aircraft —
  a light single needs fuel and nothing else at any airport in the world.
  _Next: play it. Also — commuter stands 11–14 and West/Island W2–W4 are south, so they carry no
  crossing and have no fleet yet. Deferred deliberately: a **quick-turn** (arrival → same
  aircraft's next departure) should be shorter than an originating departure, and a widebody
  should take longer than a narrowbody **within** one fleet — both are second axes on this one,
  and the fleet is the coarse handle. See the aircraft-types discussion._
- ✅ **HS1 hotspot** — a hot spot is not geometry the sim can derive: it is somewhere real pilots
  and controllers have repeatedly got confused, published because history says so, and the only
  honest thing a simulation can do with that is **watch harder there**. Inside a shared hot spot
  traffic is called as converging at **3× the open-pavement distance** — a few hundred feet apart
  rather than nose to nose, which is the difference between a warning you can act on and a
  notification. `hotspotAt` takes the nearest centre where two overlap (so the answer does not
  depend on the order the diagram listed them); `busyHotspots` reports only spots holding two or
  more aircraft, because one aircraft in a hot spot is just an aircraft. The circle reads its
  state from the sim — dashed and quiet by default, solid and washed when busy — and the conflict
  line names the spot. A field charting no hot spots behaves exactly as before, with a test.
  This became worth building only once the cargo/GA fleets shipped: HS1 sits at the GA/taxiway-H
  junction **north of 09/27**, on the side the new traffic actually uses. _Next: HS1 is the only
  charted spot at KSAN; the d-TPP diagram is the source if more are wanted._
- ✅ **Runway incursion alerts** — the sim already *refuses* every clearance that would put two
  aircraft on one runway, which left a blind spot: the conflicts no single clearance was wrong
  for. `detectIncursions` (pure, deterministic) classifies each aircraft on the pavement by how
  it got there — takeoff, line-up, rollout, crossing, or nothing at all — and raises three kinds:
  an uncleared occupant, an occupant under an aircraft cleared to land on top of it (advisory
  beyond 1.5 nm, alert inside it), and two aircraft sharing the runway where one holds a clearance
  for it. The occupant named first is the intruder, so the HUD names the aircraft to move.
  Authority rides a small latch (`runwayAuth`: issued → on → dropped when it leaves), so a
  crossing clearance is spent by the movement it was given for; a landing rollout inherits it
  across the Tower→Ground handoff. Snapshot `incursions` + per-aircraft `incursion`; dashed red
  ring on the scope, HUD line at the top of the alert stack.
- ✅ **Making the incursion alert actionable** — there are exactly two ways out of an aircraft
  on the runway under an inbound: move the one in the air, or move the one on the ground.
  **Go around** is now the controller's call (the sim only had the pilot's, announced at the
  threshold); the state change is shared with it, but the two are transmitted differently — the
  pilot's is an announcement, the controller's an instruction with a read-back — so the
  transcript can tell them apart. Not gated on holding a landing clearance: an arrival still
  awaiting one is the aircraft you most want to turn away early. **Expedite** runs the existing
  clearance at 25 kt, cancels a give-way (you cannot hurry and wait at once), and is spent by
  the next clearance; separation caps still apply on top, so hurrying is never permission to run
  into anyone. Both are on the strip menu, labelled with the reason when the aircraft is the one
  in the incursion, and expedite stays *visible and disabled* when the aircraft cannot be
  hurried — "this one cannot get out of the way" is what tells you to send the other one around.
  The banner itself is a button that selects and centres on the intruder, so alert → action is
  one click. _Next: the go-around is still the stub re-establish (back to the 4 nm fix); the
  real one climbs out and re-enters TRACON sequencing — see docs/atc-tower.md Slice 3._
- ✅ **Converging-traffic prediction** (incursion follow-up) — taxi conflicts now have the same
  developing → happening ladder as the runway ones. `converging.ts` (pure, like `incursion.ts`)
  projects each aircraft along its **actual remaining route** — not a straight line out of its
  nose, which on a taxiway network would invent conflicts at every bend and miss the ones that
  happen around them — and reports the pair with seconds-to-conflict. Snapshot gains
  `conflicts[]` (worst first) and a per-aircraft `converging` flag; the scope draws a dashed
  amber ring against the solid red one and the alert line reads `⚠ CONVERGING — … in 12s`.
  Two exclusions keep it from crying wolf: a **queue** (traffic ahead on your own track going
  your way — following separation owns that) and a pair the **junction reservation has already
  resolved**. Both are about *predicting*: a pair actually nose-to-nose is always reported.
  Hot spots widen the distance (×3, as the proximity call always did) *and* double the horizon.
  The sample step scales with closing speed, so a 140-kt rollout cannot step over the moment it
  meets someone; a hold names *who* it is for, so it silences that pair and not the third
  aircraft the held one is also closing on. Both were review findings, reproduced as tests
  first.
- ⬜ **Separation at rollout speed** (separation follow-up) — `LOOK_AHEAD_NM` (0.06 nm) is sized
  for taxi: ~9 s of warning at 25 kt but ~1.5 s at 140 kt, so a landing rollout capped by
  `separationCap` cannot actually stop for anything it meets. Currently mitigated at *planning*
  time — a landing is not sent to a turnoff another aircraft is standing in (`exitBlocked`) —
  which covers the case that made it reachable (an arrival now parks in its turnoff awaiting a
  taxi clearance). The physics backstop is still nearly useless above taxi speed: a speed-scaled
  look-ahead would make it real. _Found while fixing the contact-ground handoff; reproduced as
  two 737s at identical coordinates on B7 before `exitBlocked` existed._
- ✅ **Line up and wait behind landing traffic** — the situation `docs/atc-operations.md` §6 defines the instruction by ("the runway is not quite clear — a landing aircraft is still rolling out") was refused by the sim, so LUAW only worked when it was least needed. Traffic *leaving* down the runway no longer blocks a line-up behind it; anything stationary still does, including a rollout that has stopped. The clearance carries the traffic ("…line up and wait, traffic landing runway 27") and the menu names it. Two bugs fell out: two aircraft could be cleared into position in the same tick (neither was physically on the runway yet), and the incursion detector alerted on a rolling departure with one lined up behind it — anticipated separation, reported as an accident. **The ICAO conditional form is also in**: "behind the landing 737, line up runway 27 and wait, behind" — the first clearance in the sim that is issued now and applied later. Armed at issue; applied when the named traffic has landed *and passed the holding point*; cancelled out loud when it goes around, leaves, or the runway is no longer usable when the moment comes. Never re-pointed at the next arrival. `holdShort` takes it back. The strip shows `⧗ LUAW BEHIND DAL2` while it is outstanding — the one thing on a strip that is true of the future rather than the present.

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
- 🚧 **Misc. messages** — catch-all phraseology. **Say again** is wired (see Read-back verification);
  expedite, verify heading/altitude, etc. still open.
- ✅ **Contact other frequency** — `Contact tower` wired for a departure holding short (Ground→Tower handoff, completes the departure); stays `soon` in other states until more frequencies/modes exist.

### Supporting systems shown in the reference
- ✅ **Comms: show and filter the channel** — every call is labelled with the frequency it went
  out on (GND/TWR, Tower's tinted), including a pilot's unprompted check-in after a handoff,
  which has no controller line above it to inherit one from. The panel has its own ALL/GND/TWR
  filter defaulting to ALL, independent of the strip bay — tying the transcript to the position
  tabs was what hid cross-frequency calls in the first place. _Next: a per-aircraft filter
  (click a strip, see just that flight's exchanges) once transcripts get long._
- ✅ **Communications log** — the sim writes a radio transcript (`ground/comms.ts`): every accepted
  command emits the controller's instruction and the pilot's read-back in 7110.65/AIM phraseology,
  timestamped in sim time and tagged with the frequency it happened on; refused commands say nothing.
  Plus the calls no controller issues — the pilot checking in after a handoff (on the *new*
  frequency) and announcing a go-around. Frequencies come off the `Airport` bundle
  ("contact tower 118.3"). Web: a **COMMS panel** under the strip bay filtered to the active
  position, controller flush + pilot indented, click a line to select the aircraft, `aria-live`.
  _Next: filter to the selected aircraft; a "last call" line on the strip itself._
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
- 🚧 **Slice 3d — communications log + read-back**: **the log and read-back verification shipped**
  (see Cross-cutting systems) — the arrival procedure's transmissions are now all visible in the TWR
  bay. Still open: wake spacing on final, arrival sequence numbers, a player-issued go-around,
  hold-short during rollout, ATIS/weather line.
- ✅ **Slice 3e — Tower owns the crossing.** (Procedure: `docs/atc-runway-crossing.md` §5–7.)
  The reported symptom was "after contacting tower there is no cross-runway option", but the gap
  ran deeper than the menu: `contactTower` explicitly *refused* a transit, so an aircraft holding
  short to cross could never be on Tower's frequency at all. **Procedure option B now works end
  to end.** Ground may hand a transit to Tower for the crossing — including an arrival, which
  crosses to reach its gate; Tower clears it with **"no delay"**, the phraseology that
  distinguishes Local Control's crossing from Ground's; and Tower hands it back, worded "when
  clear of the runway, contact ground" and *armed* when issued mid-crossing, applying the moment
  the aircraft is off the pavement. Nothing is re-routed on the way back — unlike an arrival
  leaving the runway, a transit is already taxiing the clearance it has. Ground keeps its own
  direct **Cross runway** (option A): both are real and the choice is the controller's, so the
  menu offers both. Tower's hold-short menu now splits on *what the aircraft is there for* — a
  departure gets line-up/takeoff, a transit gets the crossing and nothing else, because offering
  to line up a transit offers a runway it has no business using.
  **Latent bug closed on the way:** `crossRunway` used to accept an aircraft cleared *to* the
  runway, which would have driven it on and parked it there unaligned with no takeoff clearance —
  a runway incursion issued by the controller. Two discriminators now, because there are two
  questions: `holdingForTakeoff` (is the *destination* the runway?) decides what a handoff is for
  and how it is phrased; `heldRouteCrosses` (does the held route *end* off the pavement?) answers
  the physical one. **"Hold short of runway N" now exists too** (§2–6): the taxi clearance
  carries the clause that makes it readable back, and the instruction is real — a confirmation
  at the line, the answer to a crossing request, and, before the aircraft is on the pavement, the
  way to **take a crossing clearance back**. That last one is the counterpart to "cancel takeoff
  clearance", and the lever the incursion alert most wants when an arrival appears on final in
  the seconds after a crossing was cleared. _Next: the reason belongs on the air with it — "hold short runway 27,
  traffic on a three mile final". Tracked under Cross-cutting systems as **"A refusal should be a
  transmission, not a tooltip"**, since it is the same gap everywhere the sim says no._
- 💭 **Ramp Control** — a third layer after Ground at large hubs (airline/airport-run, not FAA).
  Deferred: adds a frequency without adding a decision until gate conflicts + pushback contention
  exist (see Turnaround).
- 🚧 Departure releases / wheels-up windows from TRACON — the **time** half is built and live (see Clearance Delivery: EDCT with the clearance, window enforced at the takeoff clearance). What still needs TRACON is the **release** itself — Tower asking for and being given permission to launch, one at a time, during a push _(deferred — needs TRACON)_
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
- 🚧 **Read-back verification** — **built, deliberately switched off in the game.** A pilot who
  mishears a clearance reads it back wrong and *acts on the read-back* — the clearance is never
  withheld, it takes effect wrong. The only cue is the transcript, so catching one is a judgement,
  not a prompt. **Say again** is the catch: it repeats the last clearance with "negative, …" and
  restores what the controller actually said; offered in every phase once anything has been
  transmitted, and accepted whether or not there was an error. A clearance the sim voids on its own
  (go-around, touchdown, handoff, expired give-way) stops being repeatable. Opt-in
  `readback: { errorRate, seed }`; **the running game passes no config, so nothing is ever
  misheard** — see *Gaming the game* below for why and what turning it on entails.
- ✅ **Instructions carry their cause** (this item was originally filed as *"a refusal should be
  a transmission, not a tooltip"* — that framing was wrong, see below). `holdShort` now transmits
  the traffic it is being issued for: *"hold short of runway 27, traffic on a 3 mile final"*,
  or *"traffic on the runway"*, or nothing at all when nothing is in the way — no invented
  reasons. The cause rides on the **instruction** and is deliberately absent from the read-back:
  a pilot reads back what they must comply with, and the reason is *why*, not *what*.
  **Why refusals are not transmitted:** in this game the player *is* the controller. When the sim
  refuses "cleared for takeoff — runway busy", a real controller would not say anything — they
  would look at the scope and simply not issue it. Transmitting "unable" would be the controller
  talking to themselves. The HUD notice is already the right channel, because it *is* the
  controller's own situational awareness rather than a radio call. So the rule that only accepted
  commands are logged stands, and was never the problem.
- ⬜ **The rest of the missing context** (same shape, different instructions). `docs/atc-operations.md`
  Part C lists them: wind on takeoff and landing clearances, traffic advisories on a landing
  clearance, the wake-turbulence caution, "plan Charlie for your exit". All are accepted
  instructions missing the context the real ones carry — worth one pass rather than piecemeal.
  Needs a wind model (there isn't one) before the first two.
- 🚧 **Squawk / transponder codes** — beacon code assigned at clearance delivery (deterministic 4-digit octal), shown on the strip. Note the strip shows the code the aircraft is *squawking*, which is not the issued code when the pilot misheard it — comparing the two is the read-back game. _Next: link the code to a radar target once airborne (feeds TRACON radar contact)._
- ✅ **Stand occupancy** — a stand is a resource, not a label. `standOccupied(ref)` reports who is
  physically on the mark; an aircraft cleared to an occupied stand is *not refused* — the
  clearance is good, the gate just isn't — so it taxis in, creeps up and **holds on the alley**
  until the stand frees, then goes in on its own with no new clearance. The strip says
  `GATE nn OCCUPIED`. The hold sits a full lead-in plus margin back (`STAND_HOLD_NM`), because
  holding at the paint deadlocks the pair: the aircraft on the stand pushes back down that same
  line and stops nose-to-nose with the one waiting for it. _Known residual: if the departing
  aircraft's route out runs **through** the waiting one, they still contend — real ramps solve
  that by holding the arrival further back or pushing the other way, and neither is modelled.
  Watch for it in play before building more._
- ✅ **Turnaround & gate conflict** — an arrival is counted on arrival and then *stays*: same
  airframe, same stand, now a departure running a fresh ground-service cycle. That is what makes
  a gate finite — before it, a stand freed itself the moment it was reached, so occupancy, the
  conflict alert and reassignment were all warning about something that resolved itself. The new
  flight carries nothing over (no squawk, no clearance, no read-back history, no give-way), so it
  starts at Deliver clearance like any other departure. Opt-in `turnaround`; on in the game.
  _Next: a short-turn timer with a scheduled off-blocks time, so a slow turnaround costs
  something; and a new flight number rather than reusing the arrival's callsign._
- ✅ **Sim ↔ UI bridge** — `GroundController` store + `useSyncExternalStore` for strips (canvas stays on rAF; strips re-render only on phase/selection change)
- ✅ **Time controls** — pause / 1× / 2× / 4× in the control bar, Space to pause. Paused stops the
  sim only: pan, zoom, selection and clearances keep working, so it doubles as a planning tool.
  The rate shows in the status line so a fast session can't be mistaken for a busy one. The
  accumulator moved into `simClock.ts` (tested): the background clamp applies to *real* time
  before the multiplier, and steps are divided rather than subtracted in a loop, which was
  silently losing one step per 20 to floating-point drift. _Next: step-one-frame for debugging._
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
- 🚧 **Game loop & scoring** — dep/arr counters plus `readbackErrors`/`readbackCaught` in place (not yet surfaced in the UI); want objectives, delays, incidents, difficulty, fail states
- 💭 **Replay / save** — determinism enables record + replay (and later multiplayer)
- 💭 **Voice / phraseology** — TTS readbacks, speech input
- 🚧 **More airports** — **the abstraction is in** (`Airport` bundle in `world/airport.ts`; KSAN is
  now just data in `world/ksanAirport.ts`). The engine holds no airport knowledge and the web
  layer reads the field off `controller.airport`; `world/airport.test.ts` builds a fictional
  north–south field from scratch and plays a full arrival and departure on it. Adding a
  **single-runway** field is now a data exercise — see `docs/adding-an-airport.md` (~1.5–2.5
  days, dominated by OSM taxiway-naming quality and whether the field has tagged gate nodes).
  _**Multi-runway foundation shipped** (`docs/atc-multi-runway.md`): occupancy and wake are
  per-runway behind a `runwayIdAt` guard, the active runway is a *set*, and inter-runway coupling
  rides a `runwaysInteract` seam — all proven on a fictional intersecting field, KSAN unchanged.
  So a second field is now "+its one rule" rather than blocked — see the candidates below._

### ⬜ Second airport (multi-runway) — candidates

Both measured from the FAA survey (NASR), not assumed. They are **not the same problem**, but the
shared prerequisite — ✅ **now shipped** — was the same for either: runways first-class behind a
`runwayIdAt` guard, occupancy and wake per-runway, the configuration a *set* of active runways, and
an inter-runway `runwaysInteract` seam (`docs/atc-multi-runway.md`). Each field now adds exactly its
own coupling rule as a seam plug; neither is blocked.

- 🚧 **KBUR — the intersecting case** *(recommended first)*. Two runways: **08/26** 5,802 ft
  (091°/271°, ILS on 08) and **15/33** 6,886 ft (167°/347°), **crossing at 66% along 08/26 and 79%
  along 15/33**. Needs a time-and-position conflict model at the crossing, hold-short-of-the-
  intersecting-runway, and timed departures between arrivals; LAHSO optional. Because the crossing
  is past both midpoints, intersection departures before it fall out of the mechanic we already
  have. Compact field, one new rule on top of the foundation. _+3–5 days._
  **Data pipeline shipped** (cycle 2607): NASR + d-TPP + OSM pulled, verified and written up in
  `docs/BUR/` (`runways.md` = surveyed facts; `README.md` = chart index + surface scan; charts
  `00067AD`/`SW3LAHSO`/`SW3HOTSPOT`). Ingest inputs committed (`tools/ingest/kbur.overpass.ql`,
  `kbur-osm.raw.json`, `build-kbur-surface.mjs` → `world/kbur.surface.json`). The crossing point
  re-derives to **66.3% / 79.2%** from the survey; **08 is the only precision end, no displaced
  threshold**; **15/33 both displaced** (909/350 ft); **EMAS 170×350 at DER 08 = the east end**.
  Surface scan: **14/14 gates+stands** (better than KSAN), 44 `construction` features (new
  terminal, excluded). **Verdict: GO.** **Taxiway naming shipped** (`docs/BUR/taxiway-naming.md`):
  19 of the 29 runway-touching connectors patched by way-id to their designator (coverage
  20→39/115), the other 10 (run-up apron, C/D throats, SE terminal cluster, end stubs) left
  unnamed by KSAN discipline. _Next themes: (1) the `Airport` bundle `world/kburAirport.ts` +
  the crossing rule on the `runwaysInteract` seam; (2) copy `world/airport.test.ts` for KBUR._
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

## ⬜ Gaming the game (deferred until the base loop is proven)

Mechanics that make the simulation *harder* rather than more complete. Held back on purpose: a
mechanic that makes a clearance silently take effect wrong is exactly the thing that hides a real
bug behind "the pilot misheard it". The rule is **prove the loop first** — a full departure and a
full arrival should be reliably flyable, with no surprises from the sim itself, before any of this
is switched on.

- ⬜ **Turn read-back errors on.** The mechanism is built, tested and default-off (see Read-back
  verification). Enabling it is one config object in `apps/web/src/ground/controller.ts`
  (`readback: { errorRate, seed }`); ~15% reads as a plausible starting rate. Before then:
  - only the **beacon code** can currently be misheard — a quiet error with no operational
    consequence. The ones worth having are a misheard **runway exit** (wrong turnoff → different
    runway occupancy) and **hold short vs. cross**, which is the genuinely dangerous one.
    `maybeMishear` in `ground/sim.ts` is the single hook for both.
  - `readbackErrors` / `readbackCaught` are on the snapshot but nothing renders them.
- ⬜ **Difficulty / traffic pressure** — demand curves, compressed spacing, a rush.
- ⬜ **Failure states** — what counts as losing (incursion, deadlock, a missed handoff), and how
  the game says so.
- ⬜ **Objectives & delay scoring** — beyond the dep/arr counters.

---

## Polish / UX

- ✅ Ramp / terminal area labels (Terminal 1/2, North Ramp, Air Cargo Ramp, General Aviation, Coast Guard). _Missing: West/Island Ramp Parking (unnamed in OSM), Fire Station/TWR/Admin point features._
- ✅ HS1 hotspot marker (dashed orange circle near GA / taxiway H)
- ✅ Gate stands: clean gate-node markers + zoom-gated numbers (T2 20–51, T1 101–119 from OSM gate nodes, matching the researched scheme); spawn from terminal gate nodes
- ✅ Mobile: pinch-zoom / touch pan / tap-select, responsive stacked layout, LAN dev hosting
- ⬜ Label density control (show major spines when zoomed out, exits when zoomed in) + collision avoidance
- ✅ **Zoom-to-fit + off-screen traffic** — **FIT** button / `f` frames the airport *and* all traffic (`fitPoints` takes arbitrary world points, so it generalizes to climb-outs and TRACON). The final approach course is drawn as the extended centerline with 1-nm range ticks, and airborne traffic outside the viewport gets an edge chevron labelled callsign + range. _Next: scale bar / range rings._
- ✅ **Bug: a click on open ground silently re-cleared the selected aircraft.** *Any* click that
  missed a target counted as a taxi clearance: the raw world point went to `taxiTo`, and
  `goalNodeFor` snapped it to the nearest graph node with no distance limit — so a click on the
  grass or the bay re-routed the selection to whichever node happened to be closest, superseding
  its clearance along with any give-way, expedite or diversion memory. Nothing about clicking
  empty space looks like issuing a clearance, which is why it read as the aircraft changing its
  mind on its own. Fixed in two layers: the scope now reads a click as a clearance only when it
  lands within `CLEARANCE_HIT_PX` of the **routable network** (`distanceToNetworkNm`, walking
  each graph edge's real polyline — "is there pavement here" and "can an aircraft be routed
  here" are different questions, and it is the second that decides); off the network a click
  means what it means with nothing selected, deselect. Underneath, `goalNodeFor` refuses to snap
  a destination further than `MAX_GOAL_SNAP_NM` (0.25 nm) from the network at all — a backstop
  deliberately looser than any aiming tolerance, since a stand's stop mark legitimately sits a
  lead-in line off the nearest node, so no caller can turn a point over the water into a
  clearance. **Follow-up (reported in play):** the first fix used a pure *pixel* tolerance, which
  is right for aiming at something you can see and wrong at whole-airport zoom, where the field
  is only a few hundred pixels across — 44 px reached 345 ft on a desktop and **1,530 ft on a
  phone**, against a taxiway half-width of ~75 ft. So a tap well off the pavement still counted.
  Pavement is a world-space thing, so the tolerance is now capped in world space
  (`clearanceRangeNm` = min(44 px, 0.04 nm ≈ 240 ft)); the pixels only make it clickable once you
  are zoomed in far enough for the question to be meaningful. _Not done: a hover preview of where
  the clearance would go, the way the route builder previews the taxiway a click would pick._
- ⬜ Scale bar / range rings
- ⬜ Pan/zoom clamping (don't lose the airport off-screen)
- ✅ Runway turnoffs drawn along their real geometry for the selected arrival, assigned one emphasized
- ⬜ Gate docking guidance on arrival (AGNIS/PAPA-style stop/center cue) — the aircraft now parks
  on the painted stop mark, but there is no docking-guidance display
- ✅ **Show where a selected arrival is going.** A selected inbound arrival highlights its
  assigned stand on the scope (lead-in emphasised in the route colour + gate number, like an
  assigned turnoff) from the moment it appears on final, and the strip carries a `→ GATE nn`
  destination line. Because occupancy is modelled, the line warns *early* — amber-red
  `⚠ OCCUPIED` when the stand is already taken, so a gate conflict is visible while the aircraft
  is still on final.
- ✅ **Field-wide gate-conflict alert** — `gateBlocked` is a sim snapshot field (an inbound
  arrival whose stand is already occupied), so the strip warning and the scope alert read one
  source. The scope names the gates on its own advisory line — amber and `aria-live="polite"`,
  deliberately quieter than the red separation CONFLICT above it, because that one is happening
  now and this one has not happened yet.
- ✅ **Reassign an arrival's gate** (`assignStand`) — the lever the alert needed. Offered in every
  phase before the arrival parks, on both frequencies, labelled with the conflict when there is
  one. Only free *and unclaimed* stands are offered (a stand another arrival is already heading
  for is a conflict that hasn't arrived yet), nearest first, capped at six. Validated before
  mutating, with the reroute rolled back on failure; an arrival already taxiing is re-routed on
  the spot. _Next: nothing forces the choice to be sensible — reassigning to a stand on the far
  side of the field is legal and free. Terminal/airline affinity would make it a real tradeoff._
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
- ✅ ~~Arrivals park at the nearest taxiway node + a straight leg to the gate point~~ — they now
  follow the stand's painted lead-in line (`ground/stands.ts`). Residual: KSAN Terminal 1 has no
  lines in OSM, so its 19 stands run on a derived straight lead-in (drawn dashed to say so)
- ⬜ Surface redrawn every frame; consider offscreen-canvas caching if perf needs it
- ⬜ **`goalPoint` and the held route can disagree about what an aircraft is doing.**
  `holdingForTakeoff` reads the *goal* (is the destination on the runway?); `heldRouteCrosses`
  reads the *current clearance* (does the held route end off the pavement?). They answer
  different questions and usually agree, but the dev sandbox hands every spawn the runway as its
  goal, so a dev-spawned aircraft manually routed across the runway looks like a departure: it is
  never offered the crossing vocabulary, and `lineUpAndWait`/`clearedForTakeoff` would accept it
  and abandon its real route. Production spawns set both consistently, so this is dev-tool-only
  today. Tightening the clearance guards to consult the held route as well was tried and reverted
  — it fails ~30 tests whose hand-authored fixtures draw a departure's path past the runway, and
  reconciling goal-vs-route across those is a bigger change than it belongs inside. _Fix with the
  fixtures, not around them._
- ⬜ Scenario stitches arbitrary long taxiways for demo traffic — replace with real gate→runway flows
- ℹ️ Headless screenshots show T+00:00 (Chrome virtual-time doesn't drive rAF) — motion is fine live

---

## ✅ Documentation debt

- ✅ **Build docs refreshed for the stand/routing model.** `adding-an-airport.md` gained sections
  on stands-as-lead-in-lines, the turn-aware router (including: survey a new field's turn
  distribution rather than copy KSAN's threshold) and pushback direction;
  `airport-data-pipeline.md` documents `parking_position` as a pre-commit risk to count and what
  those ways don't carry; `lessons-from-ksan.md` gained entries 21–26.

---

## Testing / infra

- ✅ **Dev/admin sandbox** (`?dev`) — empty surface, spawner off, plus a control bar. **SPAWN**: click the surface to drop a test aircraft (snaps to the nearest routing node, auto `DEVnn`); drive it with the normal commands; **GRAPH** (the routing-graph overlay, and its `g` key) is dev-only — outside the sandbox the bar is just the two gameplay controls, RWY and FIT. **ARRIVAL** puts a test arrival on the final approach of the *active* runway (airborne — it can't be placed by clicking the surface) and switches to the Tower bay; successive spawns stagger 1.2 nm down the final. **X** removes the selected, **CLEAR** wipes all. **PROBE**: click two points to draw the shortest graph path between them with a live length + taxiway-sequence readout (no route → dashed red). Works alongside the **GRAPH** overlay. Sim gained `add`/`remove`/`clear`. _Next: param picker (type/wake/intent), exact (off-network) placement, step/pause, save/replay._
- ✅ **Sandbox cleanup ergonomics** — **CLEAR now wipes the transcript with the fleet**
  (`sim.clear()` resets comms + the sequence counter, so the panel isn't a list of ghosts), and a
  **DELETE dev tool** removes aircraft by click: arm it, click the extras away, it stays armed and
  rings the target under the cursor so you never mis-pick in a cluster. `controller.remove(id)`
  removes a specific aircraft. _Next (nice-to-have): a param picker on SPAWN so a placed aircraft
  isn't always a `B738` departure._
- ⬜ Playwright E2E for the interaction flows (needs dependency vetting per policy)
- ⬜ Socket.dev GitHub app on the repo (CI already runs audit + osv-scanner)
- ⬜ Coverage reporting + targets
- ⬜ Visual regression on the scope (screenshots at breakpoints)
