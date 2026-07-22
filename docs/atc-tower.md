# Tower (Local Control) — design note

**Status:** design — not yet implemented. This note precedes code because Tower is a new
controller mode (a genuinely new subsystem), per `CLAUDE.md`.
**Authorities:** FAA Order 7110.65 Ch. 3 (Airport Traffic Control) & Ch. 5; AIM Ch. 4.
See also `docs/atc-flight-cycle.md`, `docs/atc-flight-strips.md`, `docs/wake-turbulence.md`.

---

## 1. Purpose

Tower (ATCT Local Control) owns the **runway environment**: the runway surface itself plus
the slice of airspace on short final and initial climb-out. It is the second controller
position after Ground, and the first to touch airborne aircraft.

Today "Tower" does not exist as a position. `contactTower` is a **shortcut** on the Ground
sim: a departure holding short is instantly launched — it rolls to 140 kt, lifts off the far
threshold, and is counted `departed` (`ground/sim.ts:764-798`). Arrivals never fly a final;
they *spawn already on the surface* rolled out at the RWY 9 end and taxi to a gate
(`ksanGame.ts` `arrivalSpawn`, `sim.ts:841-853`). This note replaces the shortcut with a real
position: explicit **line up and wait**, **takeoff clearance**, **landing clearance**, and the
Ground↔Tower handoffs that connect them.

---

## 2. Architecture: one sim, two projections

The project principle is **one flight object, mode-specific projections** (`CLAUDE.md`). Tower
does **not** get its own engine. We extend the existing sim so that Ground and Tower are two
**projections + two command sets over the same fleet**. An aircraft flows between positions by
changing which controller *owns* it — no serialization, no second tick loop.

Concretely:

- Add an ownership axis to each aircraft: `controlledBy: 'ground' | 'tower'`. Handoffs flip it.
  A position's strip bay and command set are filtered to the aircraft it owns.
- Add an `altitude` (feet AGL, `0` on the surface). This is the only genuinely new physics.
  Ground aircraft are all `altitude === 0`; Tower introduces `> 0` on final and climb-out.
- The snapshot stays a single immutable `Snapshot`; each position derives its own view from it
  (mirrors how the Ground strip already hides fields the phase can't action).

**Naming debt:** the module is `packages/sim/src/ground/` and the entry is `createGroundSim`.
Extending it with airborne Tower state strains the name. We keep the name for this work (a
rename is pure churn mid-feature) and revisit once Tower lands — likely `local/` or `atct/`,
since one facility (the ATCT) runs both Ground and Local Control. Tracked in `backlog.md`.

---

## 3. The airborne model (minimal)

The sim is currently surface-only. Tower needs just enough airborne fidelity to make final
approach and climb-out legible — **not** a flight model (that's TRACON's job later).

| Concept | Model |
|---|---|
| Altitude | `altitude` ft AGL; `0` on surface. Descends on final, climbs after liftoff. |
| Final approach | A straight, ~3° geometric descent along the runway centerline extended, from a fixed **final fix** (e.g. 4 nm out, ~1200 ft) to the threshold. Position interpolates along it; no wind, no glideslope capture. |
| Touchdown | Reaching the threshold at `altitude ≈ 0` transitions to a **rollout** (deceleration along the runway, reusing surface kinematics in reverse of the takeoff roll). |
| Climb-out | After liftoff, continue past the far threshold climbing to a **handoff altitude**, then despawn as `departed` (TRACON would take it; TRACON doesn't exist yet). |
| Missed approach / go-around | Re-inject onto a fresh final (stub) — full version cascades into TRACON, deferred. |

Determinism is unchanged: all motion is a function of `step(dt)` and seeded spawn. No
`Math.random`/`Date.now`. The final path is geometry, computed from runway endpoints.

---

## 4. Ownership & handoffs

```
        Ground                         Tower                        (TRACON — later)
  ┌──────────────────┐        ┌───────────────────────┐        ┌──────────────────┐
  │ pushback→taxi→   │  CTT   │ holdShort → LUAW →     │ liftoff│ climb-out →      │
  │ hold short  ─────┼───────▶│ takeoff roll ──────────┼───────▶│ (despawn:        │
  │                  │        │                        │        │  departed)       │
  │  taxi to gate ◀──┼────────┤ ◀── rollout ← land ◀───┼────────┤ spawn on final   │
  └──────────────────┘  exit  └───────────────────────┘        └──────────────────┘
     controlledBy:'ground'         controlledBy:'tower'
```

- **Ground → Tower (departure):** `contactTower` no longer launches. It **transfers control** —
  the aircraft stays holding short, now `controlledBy:'tower'`, appearing on Tower's strips and
  removed from Ground's actionable set. (Guard unchanged: only a departure holding short of its
  *own* runway, not a crossing — the existing crossing refusal at `sim.ts:774` stands.)
- **Tower → Ground (arrival):** on **runway exit** after rollout, the arrival flips to
  `controlledBy:'ground'` and becomes an ordinary taxiing aircraft with a goal of its gate —
  reusing the existing taxi/route machinery wholesale.
- Arrivals *originate* under Tower (spawned on final). Departures *originate* under Ground.

---

## 5. Command vocabulary (Tower)

New `GroundCommand` variants (the union in `types.ts:14-25`), all Tower-owned:

| Command | Precondition | Effect |
|---|---|---|
| `lineUpAndWait` | Tower-owned departure holding short; runway clear | Taxi onto the runway centerline at the threshold, stop, hold (`status:'lineUpWait'`). LUAW ≠ takeoff clearance. |
| `clearedForTakeoff` | Tower-owned departure holding short **or** lined up & waiting; runway clear; wake interval satisfied | Begin the takeoff roll (existing `departing` kinematics). |
| `cancelTakeoff` / `holdPosition` | Departure in LUAW | Return to holding short (or hold on the runway pending a decision). |
| `clearedToLand` | Tower-owned arrival on final; runway clear of conflicting traffic | Arm the landing; on touchdown, roll out and slow to taxi speed. |
| `goAround` | Arrival on final or short final | Abandon the approach, climb, re-inject on a fresh final (stub). |
| `assignExit` *(later)* | Arrival rolling out | Choose the turnoff taxiway; default = nearest suitable exit. |

Refusals reuse the typed `DispatchResult` reason channel (`types.ts:98-99`) — e.g.
`"runway occupied"`, `"line up and wait first"`, `"wake turbulence — Ns behind Heavy"`.

**Wake spacing moves to the takeoff-clearance gate.** Today the wake interval is checked at
`contactTower` (`sim.ts:779-786`). With a real Tower it belongs on `clearedForTakeoff`, and a
second interval applies to arrival-behind-arrival on final (`docs/wake-turbulence.md` extends).

---

## 6. Tower strip & state machine

Per `docs/atc-flight-strips.md` §Tower Strip: lean, runway-focused. Fields: callsign, type +
**wake category**, assigned runway, **sequence number**, weather (ATIS), status flags.
Tower does *not* show route, squawk, cruise altitude.

New `GroundStatus` values for the strip state machine (`types.ts:8`):

```
departure:  holdShort ──lineUpAndWait──▶ lineUpWait ──clearedForTakeoff──▶ departing ──▶ (gone: departed)
                └────────────────────────clearedForTakeoff (direct)────────────────────────▶
arrival:    onFinal ──clearedToLand──▶ landing ──touchdown──▶ rollout ──exit──▶ taxi (→ Ground)
                └──goAround──▶ onFinal (fresh)
```

The strip gates actions to phase exactly as Ground does (`commandsFor` in
`apps/web/src/ground/commands.ts` grows a Tower branch): an `onFinal` strip offers
`Cleared to land` / `Go around`, never `Cleared for takeoff`.

---

## 7. Runway occupancy — the shared resource

The single tension that makes Tower a game: **one runway, contested by departures and
arrivals.** The existing single-occupancy guard (`onRunway`, used at `sim.ts:776`) generalizes
to a **runway-clear predicate** consulted by every clearance:

- `clearedForTakeoff` refused if any aircraft is on the runway, on short final inside a
  threshold distance, or already lined up.
- `lineUpAndWait` is looser, deliberately: traffic **leaving** down the runway — a departure
  rolling, or a landing still rolling out — does not block a line-up behind it. That is the
  situation the instruction exists for (`docs/atc-operations.md` §6), and the traffic is issued
  with the clearance ("runway 27, line up and wait, traffic landing runway 27"). Anything
  *stationary* on the pavement still blocks, including a rollout that has stopped on it, and so
  does an aircraft already cleared into position — one aircraft in position at a time, counted
  from the clearance rather than from when its wheels reach the centerline.
- The incursion detector knows about this pair: a rolling departure with one lined up behind it
  is **anticipated separation, not an incursion**. Alerting on it meant the game issued an
  instruction and then shouted about the result.
- **Conditional line-up** (`lineUpAndWait` with `behind`) — "behind the landing 737, line up
  runway 27 and wait, behind". ICAO phraseology (Doc 4444) and deliberately *not* FAA, which
  issues explicit clearances only; it is here for the mechanic rather than the realism. The
  condition brackets the clearance in both the instruction and the read-back, so it cannot be
  heard as an unconditional one. Armed at issue, applied when the named traffic has landed *and
  passed the holding point* — measured along the runway from the threshold, because "behind"
  means behind and not merely "has landed".

  It is **cancelled, out loud**, when the traffic stops being a landing aircraft (a go-around
  voids the landing clearance, which is exactly that fact) or leaves the sim, and when the
  runway is not usable at the moment the condition comes true. Never silently re-pointed at the
  next arrival: "the landing 737" is one aircraft. `holdShort` takes it back, the same way it
  takes back a crossing the aircraft has not acted on.
- `clearedToLand` refused (or flagged as a conflict alert) if a departure occupies the runway
  or is lined up and waiting — the classic "go around, traffic on the runway."
- An aircraft in **LUAW** counts as occupying, so you can't land over it.

This is where sequence numbers, wake spacing, and the go-around all bite. Getting the predicate
right (and tested) is the spine of Slice 2.

---

## 8. Slices & TDD plan

Lightweight planning, tests-as-spec (`CLAUDE.md`). Each bullet is a failing test to write first.

### Slice 1 — Tower owns departures
Sim (`packages/sim`):
- `contactTower` transfers control instead of launching: aircraft becomes `controlledBy:'tower'`,
  still `holdShort`, **not** `departing`; `departed` unchanged.
- `lineUpAndWait` moves a Tower departure onto the centerline and holds (`status:'lineUpWait'`,
  `groundspeed→0` at the threshold); refused if runway occupied or not Tower-owned.
- `clearedForTakeoff` from `holdShort` **and** from `lineUpWait` both begin the roll; refused if
  runway occupied or wake interval unmet (assert the reason string).
- Wake interval now gates `clearedForTakeoff`, not `contactTower` (move the existing test).
- Snapshot exposes `controlledBy` and the new statuses; determinism regression holds.

Web (`apps/web`):
- `commandsFor` Tower branch: `holdShort`→[LUAW, Cleared for takeoff]; `lineUpWait`→[Cleared for
  takeoff, Hold position]. Unit-test the table like the Ground one (`commands.test.ts`).
- Position switch (Ground | Tower tabs) filters strips + scope to `controlledBy`; controller test
  for the filter + selection reset on switch.

### Slice 2 — Tower owns arrivals (airborne) — **shipped**
Sim:
- Arrivals spawn on final: `airborne` init flag, `altitude > 0`, position on the
  centerline-extended path (`SpawnConfig.approach = { fix, threshold }`, 4 nm / 1250 ft at KSAN).
  Altitude is *derived* from range to the threshold rather than integrated, so the descent is a
  pure function of position — deterministic and drift-free.
- `clearedToLand` arms the landing; the aircraft keeps flying the same final. Touchdown at the
  threshold (`altitude→0`) hands it to surface kinematics decelerating (`ROLLOUT_DECEL`) down the
  runway toward the far end.
- Runway-clear predicate unified as `blocksRunway` = on-runway occupant (minus a rotated
  departure) **or** anyone inside `SHORT_FINAL_NM` (1.5 nm). One predicate now gates line-up,
  takeoff, runway crossing, and the landing clearance alike.
- Tower→Ground handoff on exit: once the rollout slows to taxi speed the arrival becomes
  `controlledBy:'ground'` and is routed to its gate, reusing the existing taxi machinery and the
  gate dwell / `arrived` counter.
- **Go-around stub landed early** (Slice 3 owned the command version): an arrival that reaches the
  threshold with no landing clearance is re-established at the final fix. Without it the state
  machine has a hole — an aircraft flying past the threshold with nowhere to go. The *player-issued*
  `goAround` command and the climb-out/TRACON re-inject remain Slice 3.

Statuses: `onFinal → landing → rollout → (Ground) taxi`. Airborne aircraft are exempt from the
surface systems — taxi separation, junction reservation, give-way, conflict detection, and the
hold-short route split all skip them; they are over the field, not on it.

Web (`apps/web`):
- Tower arrival vocabulary: `onFinal`→[Cleared to land, Go around *(soon)*], `landing`→[Go around],
  `rollout`→ automatic. The landing clearance is disabled with a visible "runway busy" reason that
  mirrors `blocksRunway`, so the menu never offers a button the sim would refuse.
- Strips show FINAL / CLR LAND / ROLLOUT plus a range + altitude row; the scope draws airborne
  traffic as a hollow target with an altitude-in-hundreds / range data block. Range enters the
  strip-bay re-render signature at 0.1 nm precision, so a final costs ~one re-render per 2.5 s
  rather than one per frame.

### Slice 3 — runway exits & the real post-landing procedure — **shipped (3a–3c)**

Slice 2 got the aircraft onto the ground but ended the arrival as a physics trigger: it braked
to taxi speed wherever that happened to be, then handed itself to Ground. Two things were wrong
with that — the turnoff wasn't a *place*, and the handoff wasn't a *player action*.

**3a — exits are objects** (`runwayExits.ts`). A connector meets the runway with several legs:
an acute lead-in, a perpendicular, and the mirrored acute lead-in for the opposite landing
direction. The leg making the shallowest angle *with the direction of landing* is the one an
arrival would use, and its angle classifies the turnoff:

| kind | angle | speed | note |
|---|---|---|---|
| rapid exit (RET / high-speed) | ≤ 60° | 40 kt | mid-field; the throughput lever |
| standard | 60–100° | 12 kt | right-angle turnoff, usually near the ends |
| — | > 100° | — | points back down the runway: it is the *other* direction's exit |

So classification falls out of geometry already in the surface data. KSAN yields 8+ named
turnoffs on both sides of 9/27, and the set correctly mirrors when the landing direction
reverses. **Still worth eyeballing against the airport diagram in `docs/SAN/`.**

**3b — the rollout is planned.** At touchdown the aircraft aims at a turnoff, and the braking
rate is *solved* (`brakeRateFor`, v² = v₀² + 2·a·x in kt and nm) so it arrives there at the speed
that turn can be taken. Runway occupancy therefore varies with the choice — taking the
high-speed versus being sent to the far end is a 15+ second difference — which is the whole
reason RETs exist and the lever arrival spacing was previously missing.

**3c — Tower owns the exit and the frequency change.**
- `assignExit` on final (planning ahead) or mid-rollout (re-solving the braking). Refused for a
  turnoff the aircraft cannot slow down enough to make: *"unable B5"*.
- `contactGround` replaces the automatic handoff. Issued during the roll it is the real
  *"when vacated, contact ground"* — it arms the change, which applies the moment the aircraft is
  clear. **Nothing switches frequency on its own**, matching the rule that a pilot stays on Tower
  until told otherwise.
- **"Vacated" means past the turnoff's hold-short point**, not merely outside the pavement band,
  so a landing aircraft holds the runway against a departure for as long as it really would.

### Slice 3d and beyond — still open
- **Communications log + read-back** — the arrival procedure is 4–5 transmissions and none of
  them are visible; the Tower↔Ground conversation is currently invisible state.
- Wake spacing on final (arrival-behind-heavy); arrival sequence numbering; a player-issued
  `goAround` (the automatic stub exists — see Slice 2); ATIS/weather line.
- Hold-short instructions during rollout (*"hold short of taxiway X"*).
- **Ramp Control** — at large hubs Ground hands off to a (non-FAA) ramp controller near the
  terminal. Deliberately deferred: it adds a frequency without adding a decision until gate
  conflicts and pushback contention exist, which belong to Turnaround.

**Docs win over realism** where they conflict (`CLAUDE.md`): the 3° final, fixed final fix, and
"despawn on climb-out" are deliberate simplifications until TRACON exists.

---

## 9. Deferred (needs TRACON / Center)

- **Departure releases & wheels-up windows** — Tower can't launch without a TRACON release during
  busy periods (`docs/atc-flight-cycle.md`). No TRACON yet → not modeled; the hook is the
  `clearedForTakeoff` gate.
- **Full go-around cascade** — re-entering the TRACON arrival sequence and displacing traffic.
  Slice 3 ships only the local re-inject stub.
- **Multiple runways / LAHSO / intersection departures** — KSAN is single-runway (9/27), so out
  of scope here. One coupling to revisit if this changes: `nearestRunwayPoint` (line-up-and-wait)
  projects onto the *nearest* runway segment, not the aircraft's assigned runway — correct while
  there's only one runway, but it must be scoped to the goal's runway once a second one exists.

---

## 10. Open questions

1. **Final length & spawn cadence** — 4 nm / ~90 s to the threshold is a starting guess; tune for
   playable arrival pressure against the 22 s departure spawn interval (`ksanGame.ts`).
2. **Position switch vs. split view** — tabs are the default (one scope at a time). A future
   combined "supervisor" view could show both, but that's not this work.
3. **Does LUAW auto-release on takeoff clearance, or stay a distinct step?** Modeled as distinct
   (LUAW then a separate `clearedForTakeoff`) to teach the real phraseology; `clearedForTakeoff`
   direct from `holdShort` remains legal for the fast path.
