# Departure releases — Tower ↔ TRACON coordination

**Status:** built — §5 records the model as shipped.
**Authorities:** FAA Order 7110.65 Ch. 3 §9 (departure procedures / release), and the flow-cycle
description in [`atc-flight-cycle.md`](atc-flight-cycle.md) §"Departure Release / Wheels-Up Time".

A departure into controlled airspace is not Tower's to launch on its own: Tower must have a
**release** from the overlying TRACON first. During a push TRACON issues releases **one at a time**
to meter the departure flow into its airspace — the mechanic the whole thing exists for. This is the
*permission* half of "TRACON controls departures"; the **wheels-up window (EDCT)** already built is
the *time* half. The two are independent — a departure can need a release, an EDCT, both, or neither.

TRACON is not a playable position yet, so — exactly like the EDCT/flow system — it is modelled as an
**automated black box**: the player, as Tower, *calls for release*, and TRACON grants it on a
deterministic schedule. What makes it a game is that the grant is **metered**, so a rush of
departures queues behind the release rate.

---

## 1. The coordination (real procedure)

The call is a landline between Tower and TRACON, not a radio transmission the pilot hears:

> Tower → TRACON: *"SoCal, Burbank, release Southwest 1234, runway 15."*
> TRACON → Tower: *"Southwest 1234 released."* — or *"…hold for release."* — or *"…released, void
> if not off by 1-5, time now 1-2."*

Tower then clears the aircraft for takeoff on the frequency the pilot *does* hear. The **void time**
is the teeth: a release is good only for a short window; miss it (blocked behind wake, occupancy, or
a slow taxi onto the runway) and Tower must call for release again — and the re-request goes to the
back of the metering queue.

## 2. The model

A field opts in with a `ReleaseConfig` on its `Airport` bundle (like `slots` / `servicing`); a field
without one behaves exactly as before. At a release field **every departure needs a release**.

- **`coordSec`** — how long TRACON takes to answer a request (the coordination delay).
- **`intervalSec`** — the minimum spacing between successive releases **on one runway**. This is the
  metering: one release per `intervalSec` per runway, so a push serialises.
- **`voidSec`** — how long a granted release is valid before it lapses.

Per-runway, because departures off independent runways release independently — consistent with the
per-runway departure model (occupancy and wake are already per-runway;
[`atc-multi-runway.md`](atc-multi-runway.md) §3–4).

## 3. The flow

1. A departure at a release field is marked **needs release** at clearance delivery.
2. Tower issues **`requestRelease`** (calls TRACON). The strip shows the request pending.
3. **TRACON grants** it when *both*: `coordSec` has elapsed since the request, **and** `intervalSec`
   has elapsed since the last release on that runway. Among pending requests on a runway the
   earliest is granted first (FIFO — deterministic). The strip shows **RELEASED**, void at a time.
4. **`clearedForTakeoff`** requires a current, unexpired release; without one it is refused
   (*"call for release"* if none requested, *"hold for release"* while TRACON coordinates). The
   release is spent at takeoff.
5. If the **void window** passes before takeoff, the release lapses — Tower calls for release again,
   and that departure re-enters the metering queue behind the others. This is the cascade the docs
   describe: a departure that misses its release backs the whole line up.

## 4. Phraseology in the game

The coordination is a landline, so the pilot transcript stays quiet until there is something for the
pilot: the **grant** ("released, void 1-5") and the eventual takeoff clearance. The *request* is a
strip-state change, not a radio call. Refusals ride the HUD notice as every refusal does — the
controller looks at the strip and calls for release, they do not transmit "unable" to themselves.

## 5. Where the sim is

**Built (this slice).**

- **Config** — `ReleaseConfig { coordSec, intervalSec, voidSec }` in `ground/sim.ts`, threaded through
  the `Airport` bundle (`world/airport.ts`) as an optional `releases`. A field without one is
  unchanged. KBUR carries `{ coordSec: 10, intervalSec: 60, voidSec: 90 }` (the SoCal TRACON meters
  Burbank's departures); KSAN and KOAK opt in later.
- **State** — three internal fields per aircraft: `needsRelease` (set at `clearance` when the field
  has a release config), `releaseReqSec` (when Tower called), `releasedSec` (when TRACON granted). The
  snapshot derives one enum `release: 'none' | 'required' | 'requested' | 'released'` plus
  `releaseVoidSec`, so the UI holds no release logic.
- **Command** — `requestRelease` (`ground/types.ts` `GroundCommand`): a landline, so it is *silent*
  (`phraseFor` returns null for it, like the slot request). Refused unless it is a needs-release
  departure on Tower's frequency, holding short or lined up, without a valid release already.
- **Grant** — `resolveReleases()` runs each tick: it first lapses any release past its void window
  (transmitting *"release void"*), then grants the earliest-requested pending release per runway once
  `coordSec` has elapsed **and** the runway's `intervalSec` since its last grant — recorded in
  `lastReleaseByRunway`, keyed by physical runway id, so independent runways never meter each other.
- **Takeoff gate** — in `clearedForTakeoff`, after the wake check and before the EDCT window: a
  needs-release departure without a valid release is refused (*"call for release"* / *"hold for
  release"*). The release is spent by the takeoff.
- **UI** — the strip menu (`commands.ts`) surfaces a *Call TRACON for release* action when required, a
  *standby* status while requested, and folds the release reason into the *Cleared for takeoff*
  disabled label (ahead of EDCT, mirroring the gate order).
- **Tests** — `ground/departureRelease.test.ts` (mechanic: flag-at-clearance, request→grant timing,
  same-runway metering, cross-runway independence, void lapse, takeoff gating) and the release block
  in `apps/web/src/ground/commands.test.ts` (menu wiring).

**Deferred until TRACON is a real position:** the release becoming an actual radar-handoff /
miles-in-trail decision a *player* on the TRACON side makes, rather than the automated schedule; and
a per-push release *rate* that varies with TRACON workload rather than the fixed per-runway interval.
