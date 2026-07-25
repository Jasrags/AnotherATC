# TRACON — terminal radar control (Approach + Departure)

**Status:** design note for a new controller mode; §7 records the model as built (empty until the
first slice lands). This note settles the architecture before code, per the cadence in `CLAUDE.md`.
**Authorities:** FAA Order 7110.65 Ch. 5 (Radar) and Ch. 4 §"Approach Control"; AIM Ch. 4 §3, Ch. 5
§4 (arrival/approach). See `docs/atc-flight-cycle.md` §"TRACON Departure Phase" / "Center → TRACON
Approach" (the same handoffs as a sequence) and `docs/atc-positions.md` (who owns what).

TRACON is the **airborne half of the game**. Today an aircraft's airborne life is a stub: a departure
despawns the instant it rotates, and an arrival *appears* already established on a 4-nm final and
flies straight in. TRACON replaces that stub with a real terminal sector — the radar-controlled
airspace roughly 0–50 nm out and below ~18,000 ft, where the player vectors arrivals down to the
final and climbs departures out to the en-route boundary, with the two opposing flows sharing the
same airspace. It is the mode the other positions keep deferring to: SIDs/STARs, route + initial
altitude on the clearance, and the go-around re-injection all wait on it.

---

## 1. What TRACON owns

Two flows, opposite directions, one sector:

- **Arrivals** — received from Center at a **feeder fix** on the terminal boundary, descending. The
  controller vectors and descends them, sequences them onto the final approach course with legal
  spacing, issues the approach clearance, and hands each off to **Tower** once it is established on
  the final — which is precisely where an arrival enters the game today.
- **Departures** — received from **Tower** at rotation, climbing on a heading or SID. The controller
  climbs them through the terminal airspace, deconflicts against the descending arrivals, and hands
  each off to **Center** at the ceiling / boundary.

Deconflicting two opposing vertical flows in shared airspace is the hard, interesting part
(`docs/atc-flight-cycle.md` calls it "the most complex TRACON task"); it is the source of tension
this mode exists to create, the way wake spacing and release metering are for the ground positions.

## 2. Architecture — a separate terminal sim, joined at the seams

**Decision: TRACON is its own headless deterministic sim (`createTerminalSim`), not an extension of
the ground sim.** The ground core is defined by its surface — a taxi graph, stands, runway hold
lines — and a radar sector shares none of that; bolting an airborne vectoring model onto it would
blur the headless *ground* boundary the project guards. The two sims share the `Airport` bundle and
a **handoff contract**, not code. Three seams, each an aircraft crossing from one sim's ownership to
the other's:

| Seam | From → To | Where | State handed over |
|---|---|---|---|
| **Arrival on final** | TRACON → Ground/Tower | the final fix (~4 nm, `ApproachConfig.fix`) | an aircraft established on the final, inbound to the threshold |
| **Departure airborne** | Ground/Tower → TRACON | the departure runway end, at rotation | a climbing departure on its initial heading/altitude |
| **En-route boundary** | TRACON ↔ Center | the terminal boundary / ceiling | (Center is unmodelled — arrivals *spawn* at the feeder fix, departures *despawn* at the boundary) |

The arrival seam is the load-bearing one: **the current "arrival appears on a 4-nm final" spawn IS
TRACON's arrival handoff to Tower.** So the ground sim needs no change to accept TRACON's output — it
already takes a fully-established airborne arrival (`AircraftInit.airborne`, entering at
`finalFix`). TRACON's job is to *produce* that hand-off from a feeder-fix entry, rather than the
spawner conjuring it. When both sims run, the ground sim's arrival spawner is replaced by TRACON's
handoff; until then, the stub stands and nothing regresses.

One flight object still, mode-specific projections (`CLAUDE.md`): the same underlying flight renders
as a **radar data block** in TRACON and a **flight strip** on the ground — each showing only what is
actionable in that phase.

## 3. The airborne-motion model (deterministic)

A terminal aircraft is kinematic state plus the targets it is turning/climbing/slowing toward:

- **State**: position (local nm), `altitudeFt`, `headingDeg`, `speedKt`.
- **Targets**: `targetHeadingDeg`, `targetAltitudeFt`, `targetSpeedKt` — what the controller last
  assigned. Each tick the aircraft moves its state toward its targets at fixed rates, then advances
  position along its heading. No `Math.random`/`Date.now`; seeded `Rng` only where the field needs
  variation (spawn cadence, initial speed within a class), never in the motion itself.
- **Rates (engine constants — a standard-rate turn is a standard-rate turn at every field)**: turn
  at 3°/s (standard rate), climb/descend at a category rate (~1,500–2,500 fpm), accelerate/decelerate
  at a category rate. These live in the sim, not on the `Airport` bundle — see §5.
- **Capture**: an aircraft cleared for the approach captures the final approach course and the glide
  path (the field's published `glidePathDeg`) and flies them in to the seam, at which point it is the
  established arrival the ground sim already knows how to land.

Determinism is the same contract as the ground core: same seed + same command sequence → same radar
picture, tick for tick. That is what makes the airborne phase testable the way the taxi loop is.

## 4. The sim ↔ UI contract

Commands in, immutable radar snapshots out — the same shape as the ground sim's contract:

**Commands** (player → TRACON), each targeting one aircraft:
- `vectorHeading` — "turn left/right heading 270"
- `assignAltitude` — "descend and maintain 3,000" / "climb and maintain 10,000"
- `assignSpeed` — "reduce speed 180" / "maintain 210 or greater"
- `clearApproach` — "cleared ILS runway 27" (arms the final/glide-path capture)
- `directTo` — "proceed direct <fix>" (for STAR/feeder navigation)
- `handoff` — "contact tower" (arrival, at the seam) / "contact departure/center" (departure)

**Snapshot** (TRACON → scope), per target: callsign, type, wake, position, altitude, heading, speed,
the assigned targets (so the data block can show the amber "assigned vs current" the way the strip
shows a held clearance), phase (inbound / on-vector / on-approach / departing / handoff-pending), and
a short position history for the trail. The scope reads snapshots and dispatches commands; TRACON
imports no React, exactly as the ground sim does.

## 5. The airport / engine split

The same test as everywhere (`CLAUDE.md`): would the value be wrong at a different field?

- **The field's** (on the `Airport` bundle): **feeder fixes** (named entry points on the boundary,
  where Center hands arrivals in), **the terminal boundary / ceiling geometry**, **SIDs and STARs**
  (named procedures authored from that field's charts — `docs/SAN/`), the **approach gates / final
  fix** per runway, and the runway/threshold/glide-path geometry already on the bundle. Every one of
  these is drawn from the field's charts and would be wrong at another airport.
- **The engine's** (in the sim): turn/climb/descent/accel rates, the terminal **separation minima**
  (3 nm lateral / 1,000 ft vertical, standard terminal radar separation), **wake separation on final**
  (already in the engine — `docs/wake-turbulence.md`), the ~18,000-ft ceiling convention, and the
  vectoring-command semantics. A rule that holds wherever the rule holds is the engine's, however
  arbitrary the constant looks — the same call made for EDCT tolerance in `docs/atc-departure-release.md`.

The generality anchor, as with the ground core, is a fictional field: the terminal sim must play a
made-up airport (its own feeder fixes and finals) without any KSAN constant baked into the engine.

## 6. Slice sequence

Thin vertical slices, each green and playtested, in the project's cadence:

1. **Airborne kinematics + radar scope** — terminal-sim state (heading/altitude/speed toward
   targets, deterministic motion); the scope renders radar targets with data blocks (callsign, alt,
   GS) and history trails. An arrival spawns at a feeder fix at altitude and flies its inbound course.
2. **Vectoring** — `vectorHeading`, `assignAltitude`, `assignSpeed`; steer and descend an inbound by
   hand. *(Slice 1 + a heading vector is the thinnest playable loop — a blip you can turn.)*
3. **Approach clearance + the arrival seam** — `clearApproach` captures the final and glide path;
   at the final fix the aircraft is handed to Tower as the established arrival the ground sim already
   lands. Sequence multiple arrivals with the terminal separation minima.
4. **Departure sector** — accept Tower's rotation handoff, climb on heading/SID to the boundary,
   hand to Center (despawn). Now both flows share the sector and must be deconflicted.
5. **SIDs / STARs from the KSAN charts** — author named procedures; clearances read them out. This
   back-fills route + initial altitude + departure frequency on the *clearance* (the Clearance-Delivery
   "Next" items that were waiting on TRACON).
6. **Terminal hardening** — feeder-fix merges, conflict alerts on converging airborne traffic
   (the airborne analog of the surface converging-traffic prediction), and **go-around re-injection**:
   a rejected landing re-enters TRACON sequencing, cascading downstream — the high-tension mechanic
   `CLAUDE.md` calls out to keep first-class.

## 7. Where the sim is

_(Filled in as the slice lands.)_

**Slice 1 — airborne kinematics + radar scope (done).** The deterministic terminal core is
`packages/sim/src/terminal/sim.ts` (`createTerminalSim`): an aircraft is kinematic state plus the
targets it eases toward at engine-constant rates (§3), commands in / immutable snapshots out (§4),
same determinism guarantee as the ground core. The Slice-1 command vocabulary is one heading vector
(`vectorHeading`); altitude/speed targets are already in the kinematic model, settable at init, so
Slice 2's `assignAltitude`/`assignSpeed` drop onto a proven core.

The radar scope is `apps/web/src/terminal/` — reachable at `?mode=tracon` (with the usual
`?airport=`). It is render-only this slice: `TerminalScope.tsx` runs the sim and draws the picture
each frame; `render.ts` paints range rings, targets, history trails, velocity vectors, and data
blocks (callsign / altitude-hundreds / groundspeed); `scene.ts` derives the demo arrival from runway
geometry and formats the data block. One arrival enters at a feeder-fix-like point 15 nm out on the
active runway's extended final, at 6,000 ft, and flies its inbound course. That entry is Slice-1
scaffolding — real feeder fixes become `Airport`-bundle data in a later slice (§5). The scope reuses
the ground core's pure view/clock helpers (`ground/view`, `ground/simClock`) and imports no React
into the sim.
