# Wake-Turbulence Separation — Design Note

Status: **proposed** (design; not yet implemented). Closes review finding `SIM-2`.
Scope of this note: the **Ground/Tower** slice only — successive-**departure** spacing at the runway. Arrival separation on final is a TRACON concern and is explicitly out of scope here (see [Out of scope](#out-of-scope)).

## Why

`CLAUDE.md` lists wake-turbulence spacing as a mandatory first-class mechanic, and the design docs already commit to the exact ground/tower behavior:

> "Wake turbulence timing: if a heavy or super departed recently, Tower enforces a mandatory interval before the next departure can line up." — `docs/atc-flight-cycle.md`

> "Heavy and Super aircraft impose mandatory spacing on following aircraft. This is not optional — it is a hard constraint." — `docs/atc-flight-cycle.md`

Today `ac.wake` (`L | M | H | J` = Light/Medium/Heavy/Super) is tracked end-to-end and shown on strips, but every aircraft gets identical spacing — a Heavy departs no differently than a Medium. This note adds the one high-tension constraint the docs demand: **a following departure cannot begin its takeoff roll until the wake interval behind the previous departure has elapsed.**

Authority: FAA AC 90-23G (Aircraft Wake Turbulence), FAA Order 7110.65 §3-9-6 / §5-5 (successive departures), ICAO Doc 4444 (time-based departure minima).

## Real-world basis

For **successive departures from the same runway**, separation is *time-based*, measured from the moment the preceding aircraft begins its takeoff roll. The interval grows as the leader gets heavier and the follower gets lighter. Real minima cluster around 2 minutes (lighter behind Heavy) and 3 minutes (lighter behind Super); same-category and heavier-follower pairs need little or none.

## Game model

### Inputs
- **Leader** = the aircraft that most recently *began its takeoff roll* (via `contactTower`). Its `wake` and the sim `time` at roll start are retained even after it lifts off and despawns.
- **Follower** = the aircraft now requesting `contactTower`.

### Separation matrix (seconds, same-runway, full-length)

Only Heavy and Super leaders impose a gate — matching "hard constraint behind Heavy/Super". Proposed starting values (tunable):

| Leader ↓ \ Follower → | L | M | H | J |
|---|---|---|---|---|
| **Super (J)** | 180 | 180 | 120 | 90 |
| **Heavy (H)** | 120 | 120 | 90 | 0 |
| **Medium (M)** | 0 | 0 | 0 | 0 |
| **Light (L)** | 0 | 0 | 0 | 0 |

`wakeSeparationSec(leader, follower)` returns the cell; everything not listed is 0.

### The gate
`contactTower` already refuses on an occupied runway. Add a wake check **before** the roll starts:

```
required = wakeSeparationSec(lastDeparture.wake, follower.wake)
elapsed  = time - lastDeparture.atTime
if lastDeparture && elapsed < required:
    refuse: "wake turbulence — {ceil(required - elapsed)}s behind {Heavy|Super}"
```

On acceptance, record `lastDeparture = { wake: follower.wake, atTime: time }`.

### Determinism
The gate reads the sim's accumulated `time` (seconds), never wall-clock — consistent with the deterministic-core rule. Same seed + same command timing ⇒ same gating.

## Integration with existing code

- **New state** (in `createGroundSim`): `let lastDeparture: { wake: WakeCategory; atTime: number } | null = null`.
- **`dispatch` → `contactTower` branch** (`sim.ts`): after the runway-clear check, evaluate the wake gate; refuse via the existing `DispatchResult` reason channel (already surfaced on the HUD as a transient notice, per T1). On success set `lastDeparture`.
- **New pure helper**: `wakeSeparationSec(leader, follower): number` — a small table lookup, unit-testable in isolation.
- **Constants**: a `WAKE_SEP_SEC` matrix in the Separation constants block, plus an optional `WAKE_TIME_SCALE` multiplier (see open questions).
- **Snapshot (optional, later)**: expose `wakeHoldSec` (remaining seconds) per holding-short departure so the strip/menu can show a live countdown instead of only refusing on click.

No change to `separationCap`/`reservationCap` — those govern taxi proximity, a different concern. Wake is strictly a *release* gate at the runway.

## UX / tension

- Immediate: clicking **Contact tower** too early is refused with `wake turbulence — Ns behind Heavy`, shown in the HUD notice. The sequence backs up behind a heavy departure exactly as the docs intend.
- Later polish (not this pass): a wake countdown on the holding-short strip; a visual "wake hold" state distinct from a plain hold; flag a violation if we ever allow an override.

## Test plan (TDD)

1. `wakeSeparationSec` returns the matrix values; 0 for M/L leaders and for unlisted pairs.
2. With a Heavy leader just departed, a following Medium's `contactTower` is **refused** with a wake reason while `elapsed < 120`, and **accepted** once `elapsed ≥ 120` (advance sim time via `step`).
3. A Medium leader imposes **no** wake gate on the next departure.
4. Heavy-behind-Super still gated (120s); Super-behind-Super gated (90s).
5. The gate composes with the runway-occupied gate (occupied still refuses first, or is reported as the more intrinsic reason — decide ordering like the pushback case).
6. Determinism: identical command/step sequences produce identical accept/refuse outcomes.

## Out of scope

- **Arrival / final-approach distance separation** (4–6 nm behind a Heavy) — that lives in TRACON, a later mode. This note is departures only.
- Intersection-departure and opposite-direction adjustments, LUAW-specific timing, crossing-runway wake, and RECAT/pairwise wake recategorization — future refinements once the base gate exists.

## Open questions (need a decision before implementing)

1. **Time values / compression.** The matrix is in real-world seconds. The game's taxi/roll run near real-time, but the departure cadence (spawn ~22s) is compressed — 2–3 real minutes may feel punishing. Options: (a) ship real values as-is; (b) add `WAKE_TIME_SCALE` (default `1.0`) and tune by feel, likely starting ~`0.5`. **Recommend (b)** so the mechanic is real by default but tunable.
2. **Does wake also gate `crossRunway`** (an aircraft transiting behind a heavy departure)? Real-world: crossing behind a departing heavy has wake considerations, but it's a weaker, position-dependent case. **Recommend deferring** — departures only for now.
3. **Reference point** — measure from leader's *roll start* (proposed) vs. *liftoff*. Roll start is simpler and standard for same-runway; confirm.
