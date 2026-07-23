# Multi-runway foundation

The sim assumes one runway. Two candidate second airports need it not to: **KBUR** (08/26 crosses
15/33) and **KOAK** (10L/28R parallel to 10R/28L, 1,001 ft apart). This note settles the model
change that unblocks *either* — the shared foundation — and deliberately stops short of the rule
each field then adds. It is written before the code, because it reshapes the sim↔UI contract
(`ActiveRunway` becomes a *set*) and it is authority modelling, the class that is cheap to write and
expensive to unwind.

The foundation is built and proven against a **fictional intersecting two-runway field**, not
against real BUR/OAK data. `lessons-from-ksan.md` #17 is the whole reason: every KSAN-coupling bug
passed a green single-airport suite, and the fictional-field test caught a real one minutes after it
was written. A test that only exercises the real airport proves the real airport still works, not
that the code is general.

**KSAN must not move.** Single-runway behaviour is the array-of-one special case of everything
below, and `world/airport.test.ts` is the no-regression anchor — it stays unchanged and green
throughout.

---

## 1. Runway identity

`ActiveRunway` (`ground/runway.ts`) stays exactly as it is: it models a **direction** (a threshold,
a departure end, a far end, declared distances, a glide path). What is missing is the **physical
runway** a direction belongs to — the thing "which runway is this aircraft on" asks about.

A physical runway is identified by its **designator pair**, which the field already carries as
`RunwayLayout.ident` ("09/27", "08/26", "15/33"). That string is the runway id. The two reciprocal
directions of one runway share it; `08` and `26` both belong to `08/26`.

The mapping from a *point* to a runway id is the load-bearing new primitive:

- `buildRunwayGuard` today folds every runway feature into one flat segment list, so `onRunway`
  cannot say *which*. It becomes **segments tagged with their runway id**, and gains
  `runwayIdAt(point): string | null` — the id of the runway a point lies on, or null. `onRunway`
  (any pavement) stays for callers that legitimately mean "any runway".
- Which runway feature is which id comes from the field: the surface's runway features matched to
  the field's `RunwayLayout`s by endpoint geometry (the same matching discipline stands use — never
  by list order). At KSAN there is one, so the id is `09/27` for every segment.

`Airport.layout: RunwayLayout` therefore becomes `layouts: readonly RunwayLayout[]` (one per
physical runway) — part of config-as-a-set (§5). KSAN is a list of one.

## 2. Which runway an aircraft is committed to

One derivation, stated once, read by every per-runway predicate — because the bug class here is two
predicates answering "which runway" differently (the `goalPoint`-vs-held-route disagreement already
on the tech-debt list is exactly this shape).

- **Arrival** → the runway its `threshold` sits on (`runwayIdAt(threshold)`).
- **Departure** → the runway its `goalPoint` / `departureTarget` sits on (`runwayIdAt(goalPoint)`).
- **Transit (crossing)** → not committed to a runway; it is *on* one transiently, answered by
  `runwayIdAt([ac.x, ac.y])`, never by a commitment.

This resolves to a runway **id**, not an `ActiveRunway`, so it is stable regardless of which
direction is active. Expose it as one internal helper (`committedRunwayId(ac)`); nothing recomputes
it inline.

## 3. Occupancy goes per-runway

The field-wide occupancy is the core defect: `blocksRunway` (and `onRunwayNow`, `occupiesForTakeoff`,
`onShortFinal`, `canLineUpNow`) treat the whole field as one runway, so a departure on A blocks a
landing on B. Each becomes scoped to a runway id: "does anything block **runway R**", asked with the
clearance's own runway. Same-runway logic is unchanged; the only new thing is that traffic on a
*different* runway is invisible to the gate — unless the dependency seam (§6) says otherwise.

`nearestRunwayPoint` (line-up) and `farRunwayEnd` likewise resolve against the aircraft's **own**
runway, not the nearest segment of any runway.

## 4. Wake separation goes per-runway

`lastDeparture` (one global record) becomes **keyed by runway id**: `Map<runwayId, {wake, atTime}>`.
A departure consults the record for its own runway. Cross-runway wake interaction (close parallels)
is not a same-runway fact — it rides the dependency seam, not this map.

## 5. Configuration is a set of active runways

Today the sim holds one `runway: ActiveRunway`; `setRunway` replaces it; `DispatchInterface.runway()`
returns one. The foundation makes the sim hold an **active set** — `ActiveRunway[]`, at most one
direction per physical runway active at a time. `setRunway` **activates/deactivates a direction**
rather than swapping the single one.

- KSAN is a set of **one** direction. `runway()` / `setRunway()` keep working for the single-runway
  UI; the RWY 27/09 control is "deactivate 27, activate 09" on the one runway, which is today's swap.
- `createAirportGame` builds departures/arrivals per active runway. With one active runway this is
  precisely the current single flow.
- The sim↔UI contract additions (`runways(): ActiveRunway[]`, per-runway activate) are additive;
  the single-runway accessors stay so the KSAN web layer needs no change.

## 6. The dependency seam (the crux)

Two runways interact in field-specific ways the foundation must *not* hardcode: KBUR's departures
and arrivals conflict at the **crossing**; KOAK's close parallels demand **staggered** dependent
approaches. The foundation defines the socket; each field brings the plug.

**One predicate, consulted by the occupancy/line-up/landing gates in addition to their same-runway
check:**

```
runwaysInteract(mine: RunwayId, other: RunwayId, kind: InteractionKind): boolean
```

- Returns whether traffic committed to `other` should be visible to a gate protecting `mine`.
- `kind` distinguishes *why* we're asking (`'occupancy'` | `'landing'` | `'wake'`), so a field can
  couple runways for one and not another (parallels are wake-dependent and approach-dependent but
  not occupancy-coupled; a crossing is occupancy-coupled).
- **Default = independent**: `() => false`. A single-runway field, and any field that hasn't stated
  a dependency, behaves exactly as §3–4 alone — no cross-runway interaction. KSAN's answer is always
  false because it has one runway.
- It lives on the `Airport` config (a `RunwayDependency[]` the field declares, compiled into the
  predicate), so it is field data, per the airport/engine split — the *rule's shape* is the engine's,
  the *which-runways-and-how* is the field's.

The note fixes the **signature and the call sites** (every per-runway gate consults it after its
same-runway check). It does **not** implement KBUR's crossing geometry or KOAK's stagger timing —
those are the next slices. The proof it carries a real rule is a test stub (§7), not a real field.

## 7. The fictional test field

A made-up **intersecting** two-runway field, built from scratch like `world/airport.test.ts`'s
north–south field — two runways whose centrelines cross. It exercises the foundation generically:

- A departure holding/rolling on runway A does **not** block a line-up or landing on runway B
  (fails today: field-wide `blocksRunway`).
- Wake on A does not gate a departure on B (fails today: global `lastDeparture`).
- Line-up resolves to the aircraft's own runway.
- With `runwaysInteract` defaulted independent, occupancy on A never touches B; with a test stub
  returning true for `'occupancy'`, it does — proving the seam plugs in.

It is expressed through the seam, not as a KBUR special case, so it tests generality rather than one
field. Adding KBUR later adds its crossing rule *and* its own play-through test; this one stays.

---

## What this is not

- Not KBUR's crossing-conflict model (time-and-position at the intersection, hold-short-of-the-
  intersecting-runway, timed departures between arrivals). A later slice, plugging into §6.
- Not KOAK's dependent-approach staggering. A later slice, plugging into §6.
- Not the KSAN prove-the-loop fixes (rollout-speed separation, silent `routeVia` fallback) — a
  separate precursor pass in `backlog.md`.

Effort, per `docs/adding-an-airport.md`: this foundation ≈ 1 week; KBUR then +3–5 days, KOAK +5–8.
