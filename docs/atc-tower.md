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

- `clearedForTakeoff` / `lineUpAndWait` refused if any aircraft is on the runway, on short
  final inside a threshold distance, or already lined up.
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

### Slice 2 — Tower owns arrivals (airborne)
Sim:
- Arrivals spawn on final: `altitude > 0`, position on the centerline-extended path; `step`
  descends them toward the threshold deterministically.
- `clearedToLand` → touchdown at threshold (`altitude→0`) → rollout decel → stop near taxi speed.
- Runway-clear predicate covers final + LUAW + on-runway; cross-checked by refusal tests
  (land-over-departure refused; takeoff-under-arrival refused).
- Tower→Ground handoff on exit: arrival becomes `controlledBy:'ground'`, taxis to its gate,
  counts `arrived` after the existing gate dwell (reuses `arrival.test.ts` tail).

### Slice 3 — tension & polish
- Wake spacing on final (arrival-behind-heavy) + assign-exit; sequence numbering; `goAround`
  re-inject stub; ATIS/weather line. Each independently testable.

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
