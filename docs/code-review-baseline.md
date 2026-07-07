# Code Review — Baseline Sweep

**Date:** 2026-07-07
**Scope:** Full codebase, first-ever review (~3,200 LOC source across 22 files). Everything built to date — the KSAN Ground/Clearance controller slice.
**Method:** Three parallel specialist reviewers, one per module (`packages/sim`, `apps/web`, `tools/ingest`), each doing a deep correctness + design pass against the project's stated invariants.
**Baseline gate at review time:** ✅ `make check` green — typecheck ✓, lint ✓, 48 sim tests pass. `apps/web` and `tools/ingest` have **zero tests**.

## Summary

| Severity | Count | Notes |
|---|---|---|
| Critical | 0 | No security, data-loss, or crash-class defects in shipped code paths. |
| High | 11 | 1 real sim state-machine bug; 3 data-integrity gaps at the OSM boundary; the rest a11y / perf / UX / error-handling in the web layer. |
| Medium | 14 | Missing wake-turbulence mechanic, no dispatch feedback channel, immutability/validation gaps, perf-at-scale. |
| Low | 10 | File/function size, magic numbers, minor typing, edge cases. |

**Invariants verified clean:** No `Math.random()` / `Date.now()` / `new Date()` anywhere. No DOM/`window`/React leak into `packages/sim`. No unseeded Map/Set iteration nondeterminism. The external `GroundSnapshot` immutability contract holds. Output schema of the ingest script matches `packages/sim` types exactly.

## Recommended fix order (project-pragmatic, not just agent severity)

This is a solo early-dev game, so correctness and data integrity outrank a11y polish for *now* — but the a11y items are real and should be a scheduled batch, not dropped.

1. **Fix before more feature work (correctness / data integrity):**
   - ~~`SIM-1` — status/holding contradiction~~ ✅ fixed.
   - ~~`SIM-6` — `goalNodeFor` centerline degeneracy~~ ✅ fixed.
   - ~~`ING-1` / `ING-2` / `ING-3` + `SIM-4`~~ ✅ fixed (validation theme T2).
2. **Next batch (robustness / UX):** ~~`WEB-6`+`SIM-5` (dispatch error handling + feedback)~~ ✅ done. Remaining: `WEB-2` (resize eats pan/zoom), `WEB-7` (zoom clamp), `WEB-1` (per-frame recompute of static geometry).
3. **Accessibility batch:** `WEB-3`, `WEB-4`, `WEB-5`, `WEB-10` — the ground UI is currently mouse-only and silent to screen readers.
4. **Design debt (schedule deliberately):** `SIM-2` — wake-turbulence spacing is unimplemented despite `CLAUDE.md` flagging it as a mandatory first-class mechanic.
5. **Test coverage:** stand up a Vitest setup for `apps/web` and backfill the sim gaps below. See "Test coverage" section.

---

## `packages/sim` — deterministic core

### HIGH

**SIM-1 — `status` and `holding` are computed by two contradictory rules.** ✅ **FIXED** (2026-07-07) — `statusOf` now trusts the authoritative `holding` flag; `holding` doc reconciled to its broader meaning; regression test in `status.test.ts`. `ground/sim.ts:247-256` (`statusOf`), `:429-431` (`advance`), doc at `types.ts:48-49`.
An aircraft stopped mid-route by `separationCap`/`reservationCap`/`giveWayCap` reports `holding: true` but `status: 'taxi'`, because `statusOf` recomputes taxi-vs-holding from the *nominal* `targetSpeed` (untouched by caps) instead of consulting `ac.holding`. Since the strip's `status` gates which controller actions are available (`docs/atc-flight-strips.md`), a UI keyed off `status` never sees "holding for traffic" during normal separation waits. This silently breaks the flight-strip state machine the project treats as first-class.
**Fix:** make `statusOf` authoritative by reading `ac.holding` directly; reconcile the `holding` doc comment with its actual (broader-than-documented) meaning.

### MEDIUM

**SIM-2 — Wake-turbulence spacing is not implemented.** `ground/sim.ts:68-96`, `separationCap` `:259-288`, `reservationCap` `:352-375`.
`ac.wake` is tracked end-to-end and surfaced in the snapshot, but separation constants are flat — a Heavy (`B763`) gets identical spacing to a Medium. `CLAUDE.md` explicitly lists this as a mandatory first-class mechanic. Not a crash/divergence bug; a missing domain invariant. No test exists because the feature doesn't.

**SIM-3 — Pervasive in-place mutation of internal fleet state is an undocumented exception to the CRITICAL immutability rule.** `ground/sim.ts:163-164` (comment), `dispatch()` `:528-615`, `advance()` `:417-461`, `fleet.push/splice`.
The *external* snapshot contract is immutable (fresh objects each `snapshot()`), and the hot-loop mutation is a legitimate perf choice — but it directly contradicts the project-wide "never mutate" rule and is reconciled nowhere. **Fix:** add a scoped, explicit exception to `CLAUDE.md`/rules for hot-loop internal sim state behind the immutable public API (recommended), or refactor to per-tick replacement.

**SIM-4 — `KSAN_SURFACE` is force-cast with zero runtime validation at the sim boundary.** ✅ **FIXED** (2026-07-07) — new `world/validateSurface.ts` validates on load (finite coords/bounds, known kinds, non-empty points) and throws a named error; `ksan.ts` now calls it instead of the blind cast. 8 unit tests in `validateSurface.test.ts`. `world/ksan.ts:8`: `surface as unknown as AirportSurface`.
Violates "never trust file content." Malformed geometry (NaN coords, missing `points`) propagates silently: NaN distances make every `d < bestDist` comparison in `taxiGraph.ts:100-112` false, silently returning `null` routes instead of throwing. **Fix:** lightweight schema/sanity check (finite numbers, non-empty `points`, bounds present) at load. Pairs with `ING-2`.

**SIM-5 — `dispatch()` has no feedback channel; every refused command is a silent no-op.** ✅ **FIXED** (2026-07-07) — `dispatch` now returns `DispatchResult` (`{ok:true}` | `{ok:false, reason}`); every refusal branch names its reason (runway occupied, wrong intent, unknown target, no route, …). 7 tests in `dispatchResult.test.ts`. See theme **T1**. `ground/sim.ts:528-615`, interface `types.ts:81-82`.
`pushback` when already moving, `crossRunway`/`contactTower` when the runway is occupied, `clearance`/`giveWay` for unknown ids — all return `void` with no signal. A caller can't distinguish "refused because runway occupied" from "not yet visible." Consistent design choice (tests confirm), but the UI needs to surface *why* a command was refused. See cross-cutting theme **T1**.

**SIM-6 — `goalNodeFor` degenerates on the runway centerline.** ✅ **FIXED** (2026-07-07) — `side === 0` now takes the nearest off-runway node instead of a vacuous filter falling through to an on-runway node; regression test in `runwayRouting.test.ts`. (Real-world impact was partly masked by `splitRouteAtRunway`; the fix removes the spurious planned crossing.) `ground/sim.ts:485-507`.
`side = ccw(seg.a, seg.b, from)` is `0` when the aircraft sits exactly on the centerline (mid-crossing, or float coincidence at a threshold). Then the `> 0` side filter never matches, `onSide` is `null`, and it falls through to plain `nearestNode(dest)` — which can route to the *wrong-side* threshold, across the runway, defeating the whole purpose of the function. Untested (all fixtures start off-centerline). **Fix:** handle `side === 0` explicitly.

### LOW

- **SIM-7** — `dispatch()` ~90 lines (>50 guideline); `sim.ts` is 743 lines (>400 typical, under 800 cap). Extract `caps.ts` / `dispatch.ts` / spawn logic.
- **SIM-8** — `GroundCommand.taxiways: string[]` should be `readonly string[]` for consistency with `AircraftInit.path: readonly Point[]`. `types.ts:16-17`.
- **SIM-9** — `giveWayCap` mutates `ac.giveWayTo = null` as a side effect inside a `.map()` query callback. `sim.ts:387,396,676-678`. Order-safe today; maintainability hazard.
- **SIM-10** — `reservationCap` gives no lookahead on the final route edge (`sim.ts:354`). Likely fine (corridor check covers head-on), but untested edge in the deadlock-avoidance guarantee.

---

## `apps/web` — React / Vite / Canvas2D

No Critical findings. Effect cleanup (rAF, listeners, `ResizeObserver`) is correct; the sim↔UI boundary is respected (no snapshot mutation).

### HIGH

**WEB-1 — Static surface geometry is recomputed from scratch every animation frame.** `ground/render.ts:93-352`, driven from `GroundScope.tsx:231-243`.
`drawSurface`/`drawAreaLabels`/`drawGates`/`drawLabels` re-filter features and rebuild Maps/Sets over static `KSAN_SURFACE` up to 60×/sec. Pure GC churn; scales badly as airports grow. **Fix:** precompute buckets/anchors once (module scope or `useMemo`); only recompute per-frame data (aircraft, selection, hover, route draft).

**WEB-2 — `ResizeObserver` handler discards the user's pan/zoom on every reflow.** `GroundScope.tsx:47-58`.
`resize()` always calls `fitView(...)`, so any window resize / layout reflow silently recenters a controller who panned into a runway. **Fix:** preserve current scale/center on resize; only `fitView` on first mount.

**WEB-3 — Flight strips are not keyboard-operable.** `StripBay.tsx:88-92`.
A `<div onClick>` with no `role`/`tabIndex`/`onKeyDown`. Keyboard and switch-access users can't select a strip at all — which blocks the entire command flow gated behind selection. **Fix:** `<button type="button">` (or `role="button" tabIndex={0}` + Enter/Space) with an accessible name.

**WEB-4 — Canvas radar scope has no keyboard-accessible equivalent.** `GroundScope.tsx:194-201,293-295`.
All scope interaction is pointer/wheel/contextmenu on a `<canvas>` with no `tabIndex`/`role`/`aria-label`; the keyboard shortcuts all require a selection that's mouse-only (WEB-3). The primary game surface is inoperable without a pointer. **Fix:** give the canvas `tabIndex`/`role="application"`/`aria-label` and a keyboard path to cycle/select aircraft (Tab through the existing strip list).

**WEB-5 — Submenu disclosure buttons are missing ARIA state.** `StripCommandMenu.tsx:160-173`.
Submenu triggers render a caret but have no `aria-haspopup`/`aria-expanded`/`aria-controls`. Screen-reader users get no indication a nested menu ("Taxi to…", "Give way to…") exists or is open. **Fix:** add the three ARIA attrs + a stable id on the `cmd-sub` container.

**WEB-6 — `dispatch` has no error handling around sim command execution.** ✅ **FIXED** (2026-07-07) — the controller wraps `sim.dispatch` in try/catch (logs with context on throw) and turns an `{ok:false}` result or an exception into a transient HUD notice (`controller.notice()`, shown in the hint line for ~4s). See theme **T1**. `controller.ts:129-132`.
`sim.dispatch(cmd); publish()` with no try/catch, called from event handlers everywhere. An invalid/stale command throws inside the handler — the click just appears to do nothing, no user feedback, no logged context. Violates the project's "never silently swallow errors" rule. See cross-cutting theme **T1**.

**WEB-7 — No bounds on zoom scale.** `GroundScope.tsx:83-88` (`onWheel`), `view.ts:29-34` (`zoomAt`).
No min/max clamp; repeated zoom can drive `scale` toward 0 or huge, breaking line widths, label thresholds, and hit-test radii (`HIT_PX / view.scale`). **Fix:** named `MIN_SCALE`/`MAX_SCALE` constants, clamp in `zoomAt`.

### MEDIUM

- **WEB-8** — `commandsFor` (`StripCommandMenu.tsx:27-101`, ~74 lines) is the actual implementation of the "strip is a state machine" rule but is module-private and untestable. **Export or extract to `commands.ts`** and unit-test per `GroundStatus`×`GroundIntent`.
- **WEB-9** — `publish()` (`controller.ts:90-116`) builds a Map + signature string over all aircraft every call, including every frame (`GroundScope.tsx:223`), then usually discards it (signature unchanged). **Fix:** sim-side dirty flag/tick counter to skip the work.
- **WEB-10** — HUD `statusRef`/`alertRef`/`hintRef` (`GroundScope.tsx:249-273`) have no `aria-live`; the `⚠ CONFLICT` alert is never announced. **Fix:** `aria-live="polite"` on hint/status, `role="alert"` / `aria-live="assertive"` on alert.
- **WEB-11** — Ref mutated during render (`StripCommandMenu.tsx:131-132`) — violates the project's own hooks rule outright. Move to `useEffect(() => { commandsRef.current = commands })` or keep with an explicit rule-exception comment.
- **WEB-12** — `nearestTaxiwayRef` (`render.ts:373-400`) is an unindexed linear scan per hover/click frame. Fine at KSAN scale; needs a spatial index (grid/quadtree) for bigger surfaces.
- **WEB-13** — Global `keydown` listeners (`GroundScope.tsx:145-157`, `StripCommandMenu.tsx:134-150`) act on bare keys with no `activeElement`/input-focus guard. Latent — will break the first text field added.
- **WEB-14** — Inline magic-number nm thresholds in `render.ts:293,321,324` — name them like the file's other well-named constants.

### LOW

- **WEB-15** — `render.ts` is 554 lines; natural split: pavement / labels / aircraft-selection.
- **WEB-16** — `GroundScope.tsx` effect body is one ~260-line function; extract `attachPointerHandlers` and the `frame` loop.
- **WEB-17** — 3+ finger pointer input is silently no-op'd (`GroundScope.tsx:89-105`). Harmless edge case.
- **WEB-18** — Canvas 2D context null-checked only at setup; a mid-session context-loss would throw inside `frame()` and silently kill the rAF loop. No `catch` around the frame body.

---

## `tools/ingest` — OSM → surface data pipeline

The project's only external-data boundary. Determinism is fine (committed static snapshot, stable ordering). Output schema matches `packages/sim` types. But the boundary has **no validation** — the recurring theme below.

### HIGH

**ING-1 — Silent data loss for aeroway ways with missing/incomplete geometry.** ✅ **FIXED** (2026-07-07) — kept elements lacking usable geometry are collected and the build throws (non-zero exit) instead of silently dropping them. `build-ksan-surface.mjs:98-104`.
An `else { continue }` drops any kept `aeroway` way whose `geometry` isn't an array, with zero logging. On the documented re-fetch, if Overpass truncates geometry for one taxiway/runway, that feature vanishes silently → missing taxi-graph edges → aircraft can't route, no error anywhere. **Fix:** count/log skipped elements by id; fail the build (non-zero exit) if any `KEEP`-listed way lacks usable geometry.

**ING-2 — No finiteness validation; `JSON.stringify` silently turns NaN/Infinity into `null`.** ✅ **FIXED** (2026-07-07) — `project()` throws on non-finite input/output; empty-geometry ways are rejected; final bounds are asserted finite before write. `:27-32` (`project`/`round`), `:99-101`, `:122-134` (bounds).
No `Number.isFinite` check on lat/lon/x/y or final bounds. A non-finite coord (or empty `points`) serializes as `null` inside a `Point[]`, which `taxiGraph.ts:85-95` destructures unguarded → crash far from root cause, or a silent `NaN` edge weight that corrupts Dijkstra without throwing. **Fix:** assert finiteness on every projected coord and on bounds before write; throw with the offending element id. Pairs with `SIM-4`.

**ING-3 — `REF_PATCH` (hardcoded OSM way-id → taxiway designator) has no existence check.** ✅ **FIXED** (2026-07-07) — the build tracks which `REF_PATCH` ids matched and throws listing any that are absent from the current snapshot. `:52-85`, used at `:107`.
All 27 ids resolve today, but nothing asserts it. OSM ids change on upstream re-edit; a re-fetch that stops matching an entry silently drops that taxiway's `ref`, and `routeVia` (`taxiGraph.ts:169-225`) matches edges by exact `ref` string → routes requiring that named taxiway silently break, no exception. **Fix:** after building features, verify every `REF_PATCH` key matched at least once; throw/log for unmatched ids.

### MEDIUM

- **ING-4** — ✅ **FIXED** (2026-07-07) — `ref` fallback now uses `||` so an empty-string OSM tag can't defeat `REF_PATCH`. `:107-108`.
- **ING-5** — ✅ **FIXED** (2026-07-07) — read/parse wrapped in try/catch (error chained via `cause`); `Array.isArray(raw.elements)` validated with a clear boundary message. `:90`.

### LOW

- **ING-6** — `widthNm` assumes OSM `width` is always meters (`:109-112`); `parseFloat("98 ft")` mis-converts `98` as meters. Reject/warn on non-bare-numeric widths.
- **ING-7** — No final output sanity gate before `writeFileSync` (`:147`) — non-empty features, ≥3-point rings, finite bounds. Last line of defense before corrupt data lands in version control. Consider a small Zod schema matching `AirportSurface`.

---

## Cross-cutting themes

**T1 — No command-refusal feedback (SIM-5 + WEB-6).** ✅ **ADDRESSED** (2026-07-07) — `dispatch` returns a typed `DispatchResult` with a reason; the web controller surfaces refusals/errors as a transient HUD notice and logs exceptions with context. Follow-up: `WEB-10` (add `aria-live` to the hint element) would make these notices screen-reader-announced — folded into the a11y batch.

**T2 — Unvalidated external-data boundary (ING-1/2/3/5 + SIM-4).** ✅ **ADDRESSED** (2026-07-07) — both sides now validate: the ingest build fails loudly on missing geometry, non-finite coords, unmatched `REF_PATCH` ids, or a malformed response; and `validateSurface` guards the sim boundary on load. `ING-7` (a final output schema gate in the build) remains open as belt-and-suspenders but is largely subsumed by consumer-side `validateSurface`.

**T3 — Accessibility: the ground UI is pointer-only and silent (WEB-3/4/5/10).** No keyboard path to select or command aircraft; conflict alerts aren't announced. Batch these into one a11y pass.

---

## Test coverage

**`apps/web` and `tools/ingest` have zero tests.** Sim core has 48 (green).

### Stand up `apps/web` tests (Vitest, no DOM needed for the pure units), highest value first:
1. `ground/view.ts` — `fitView`, `toScreen`/`toWorld` are true inverses, `zoomAt` fixed-point invariant (world point under cursor stays under cursor), `pan`. Pure math, trivial 100%.
2. `ground/controller.ts` — `select`/`beginRoute`/`addVia` (consecutive-dedupe)/`removeViaAt`/`clearRoute`, and the `publish()` signature-dedupe (callbacks fire only on real change). Most load-bearing file in the layer.
3. `ground/render.ts` pure helpers — `polylineLength`, `polylineMidpoint`, `distToSeg`, `nearestTaxiwayRef` against synthetic surfaces (no Canvas mock).
4. `commandsFor` (WEB-8) — export it, test every `GroundStatus`×`GroundIntent` to lock the strip state-machine contract.

### Sim gaps (backfill as regression tests):
- **Assert `.status` (not just `holding`/`groundspeed`) while an aircraft is capped to a stop mid-route** — this is exactly the gap that let `SIM-1` through.
- Arrival→gate completion path (`GATE_DWELL_SEC` dwell, `arrived` increment, fleet removal, `sim.ts:627-643`) — only departures are tested.
- `giveWayCap` "forget" branch (`GIVEWAY_FORGET_NM`, `:395`).
- `reservationCap` `contends` branch isolated from `occupies`; final-edge no-lookahead (SIM-10).
- `dispatch({type:'giveWay', toId: <unknown/self>})`.
- Fully unreachable destination (disconnected graph) via `taxiTo`/`taxiVia` (`applyRoute` silent no-op, `:464-465`).
- `goalNodeFor` centerline degeneracy (SIM-6).
- `edgeCtx()`, `outranks()`, `taxiwaysOf()` consecutive-dedup beyond the one happy path.
- Schema/sanity smoke test on generated `KSAN_SURFACE` (SIM-4).

---

## Keeping it from piling up again

This baseline exists because reviews hadn't been run. To avoid a repeat: run `/code-review` on each feature branch/PR before merge (it diffs against the base branch). New modules → `/gen-docs` then `/verify-module`. Security-touching changes → `/verify-security`. The three module reviewers used here can be re-run wholesale any time as a periodic deep sweep.
