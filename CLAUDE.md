# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**AnotherATC** is an air-traffic-control simulation/game, built as a **TypeScript pnpm workspace**, web-first. The engine is a hard split between a deterministic headless **sim core** (`packages/sim`) and a **React/Vite presentation** layer (`apps/web`); see `memory` and `docs/` for the rationale. KSAN (San Diego) is the first airport.

The design docs under `docs/` are the source of truth for the domain model. Read them before proposing gameplay mechanics, data structures, or UI — they encode deliberate decisions about how real ATC maps onto game systems.

## Toolchain & Commands

- **Node ≥ 22.13 is required** (pnpm 11 uses `node:sqlite`). If `pnpm` errors about `node:sqlite`, you're on an old Node — this repo pins Node 22 via `.nvmrc` (`fnm use` / `nvm use`).
- Package manager is **pnpm 11** (pinned in root `packageManager`).
- A `Makefile` wraps the common tasks — run `make help`. Notably `make watch` (dev server + `tsc --watch` + Vitest together) and `make check` (typecheck + lint + test).

```bash
pnpm install            # honors the supply-chain policy (cooldown, allowBuilds, etc.)
pnpm dev                # run the web app (Vite dev server)
pnpm build              # production build of apps/web
pnpm -r test            # all package tests (Vitest)
pnpm --filter @anotheratc/sim test   # just the sim core
pnpm -r typecheck       # tsc --noEmit across packages
pnpm lint               # eslint (includes the sim headless-boundary rule)
pnpm audit --audit-level=high
```

Run a single sim test file: `pnpm --filter @anotheratc/sim exec vitest run src/random.test.ts`.

## Workspace Layout

- `packages/sim` — headless sim core. **Pure TS, zero UI/DOM deps.** No React, no `window`/`document` (enforced by ESLint + a DOM-free tsconfig `lib`). Deterministic: never use `Math.random()`/`Date.now()` — thread the seeded `Rng` (`createRng`) through instead. This is where aircraft, ATC rules, the tick loop, and the strip state machine live.
- `apps/web` — React + Vite. Imports `@anotheratc/sim` (as source, via `workspace:*`), renders it, dispatches commands back. Radar on Canvas2D; strips/panels in DOM.
- Sim ↔ UI contract: commands in, immutable snapshots out (planned bridge: external store + `useSyncExternalStore`). The sim never imports React.

## Dependency Security (mandatory)

Supply-chain vetting is required before adding **any** npm dependency — follow `docs/security/dependency-policy.md`. Hardening lives in `pnpm-workspace.yaml`: 24h install cooldown (`minimumReleaseAge: 1440`), build scripts blocked except the audited `allowBuilds` allowlist (currently only `esbuild`), `blockExoticSubdeps`, `trustPolicy: no-downgrade`, exact version pins, committed lockfile. Prefer zero/low-dependency packages.

## Domain Architecture

The game models real-world ATC as **four controller modes**, each mapping to a real FAA facility and a phase of flight. This mode split is the primary architectural axis — most systems (UI, state, actions) are expected to be organized around it.

| Mode | Real Facility | Phase |
|---|---|---|
| Clearance / Ground | ATCT Clearance Delivery + Ground Control | Pre-departure, taxi |
| Tower | ATCT Local Control | Runway ops, takeoff, landing |
| TRACON | TRACON Approach + Departure | Terminal airspace, ~0–50nm, <18,000ft |
| Center | ARTCC En-Route | Cruise, high altitude |

Aircraft move through these modes via **handoffs** (`docs/atc-flight-cycle.md` has the full departure→arrival sequence and a handoff-trigger table). Handoffs are the mode-transition mechanic and a deliberate source of gameplay tension.

### Two concepts that drive the code design

1. **One flight object, mode-specific projections.** A single underlying flight-data object renders as a different **flight strip** in each mode — each position shows only what is *actionable* at that phase (Tower hides route/squawk; TRACON hides taxi route; etc.). See the strip-field-by-mode comparison table in `docs/atc-flight-strips.md`. When modeling flight data, keep one canonical record and derive per-mode views rather than duplicating state.

2. **The strip is a state machine.** A strip's status flags gate which player actions are available (a `HOLD SHORT` strip offers `POSITION & HOLD`, never `CLEARED TO LAND`). Constrain available actions to the phase — this is both correctness and the intended UX discipline.

### High-tension mechanics to preserve
These are called out repeatedly as the interesting/hard parts and should be first-class, not afterthoughts: **wake-turbulence spacing** (hard constraint behind Heavy/Super), **departure releases & wheels-up windows** (Tower can't launch without TRACON release), **go-arounds** (re-inject an aircraft into TRACON sequencing, cascading downstream), **parallel ground servicing** as a pushback constraint timer, and **turnaround** linking an arrival directly into the same aircraft's next departure.

## Repository Layout

- `docs/atc-flight-cycle.md` — full operational sequence (departure + arrival), handoff table, gameplay design notes.
- `docs/atc-flight-strips.md` — controller modes, flight-strip layouts/fields per mode, strip-as-state-machine notes.
- `docs/airport-data-pipeline.md` — where every airport fact comes from (NASR, d-TPP, OSM, the airport diagram), the exact commands, and what each source does **not** carry. Read before sourcing any airport data.
- `docs/adding-an-airport.md` — the process for building a new field, and what is not ready (multi-runway).
- `docs/lessons-from-ksan.md` — twenty things that went wrong on the first airport, written as checks for the next one.
- `docs/SAN/` — every chart the FAA publishes for KSAN, indexed by `docs/SAN/README.md` from the d-TPP metafile (not guessed from filenames). Reference material for validating the taxiway network, nav fixes and hot spot HS1. **The PDFs are on an expired cycle** (SW-3, 19 MAR – 16 APR 2026); the README says so and how to refresh.
- `docs/SAN/runway-9-27.md` — the surveyed runway facts (displaced thresholds, declared distances, EMAS, glide paths). The source of truth for runway geometry, ahead of both the airport diagram and OSM.

KSAN is the first airport. It is now expressed as data (`world/ksanAirport.ts`) behind the
generic `Airport` bundle, so the engine and the web layer carry no airport specifics.

### The airport/engine split

Every number has an owner, and the question that decides it is: **would this value be wrong at a
different airport?** If yes it is the field's — it belongs on the `Airport` bundle, and the
engine takes it as a parameter and owns none of it. If it would be identical at every airport,
it is the engine's (or the rulebook's) and belongs in the sim.

Two things make this harder than it sounds, so check for them by name:

- **Anything derived from the field's geometry is the field's, even when it looks like a tuning
  knob.** A wheels-up slot issued "eight minutes out" is a lead that has to clear that field's
  taxi time: generous where you cross the field in three minutes, a guaranteed miss where you
  cross it in twelve. Measure the field and put the number on the bundle.
- **A rule that applies wherever the rule applies is the engine's**, however arbitrary the
  constant looks. EDCT compliance is ±2 minutes at every airport the flow system touches, so it
  is a constant in the sim, not a field property — the same file, deliberately, as the lead it
  sits beside.

The test that catches a mistake is `packages/sim/src/world/airport.test.ts`, which builds a
fictional field from scratch and plays it: a value that should have been the field's but was
baked into the engine makes the made-up airport play like KSAN. When you add a constant, ask
whether KTST would still be right.

## Working with Claude (development harness)

How we collaborate here (defaults — override any time with a one-off instruction):

- **Cadence — a theme at a time.** Given a goal, decompose it into items, execute end-to-end, commit each green step to `main`, and check in when the theme is done or a real fork appears. Don't stop after every item for confirmation.
- **You give the goal, I decompose.** You hand me a theme in your words; I break it down, sequence it (propose the order, then go). Work queues: `backlog.md` (features) and `docs/code-review-baseline.md` (review debt).
- **Planning is lightweight — TDD is the spec.** A few bullets, then failing tests (RED→GREEN); the tests document intent. No formal PRD/design docs except for a genuinely new subsystem (e.g. a new controller mode), which gets a short `docs/` note first.
- **Test the loop, not just the pieces.** Per-command unit tests are necessary but not sufficient — **each slice gets at least one end-to-end scenario test through the real command sequence, with fixtures on the real spawn/entry path.** The bugs live in multi-actor interaction (e.g. two aircraft contending for one runway), which single-actor units structurally miss. _(Learned the hard way on Tower: line-up refused behind a rolling departure, can't launch #2 until #1 clears the whole runway, dev-spawned aircraft offered "Cross runway" not "Contact tower" — all invisible to single-aircraft tests.)_
- **Review each slice, not just green tests.** At the end of a slice, run a code-review pass (parallel specialist reviewers over `git diff <pre-slice-commit>..HEAD`, e.g. `typescript-reviewer` for `packages/sim`, `react-reviewer` for `apps/web`) and fix CRITICAL/HIGH before calling it done. `make check` green is necessary, not sufficient — reviews have caught real HIGH bugs that passed all tests. Note: some defects are *spec* misses (the rule itself is wrong, faithfully tested green); those need domain review or play-testing, not more units.
- **Reach for heavy tooling proactively.** Use parallel agents / workflows when breadth clearly warrants it (e.g. a multi-file review sweep), noting the rough cost — don't wait to be asked.

**Steering vocabulary** (cheap mid-flight redirects): *"plan this"* = plan-mode, no code till approved · *"continue"/"keep going"* = execute autonomously, commit per green step · *"review X"* = code-review pass · *"fan out"/"ultracode"* = multi-agent breadth · *"checkpoint"* = stop and summarize state.

**Always-on guardrails** (enforced without asking): determinism (seeded `Rng`, never `Math.random`/`Date.now`), immutability, sim headless boundary, the airport/engine split (above — field data on the `Airport` bundle, rules in the sim), supply-chain vetting before any dep, `make check` green before every commit, a code-review pass + an end-to-end scenario test per slice, docs-win-over-realism.

### Model selection

Pick the cheaper model that can do the job; escalate only when the work actually demands deeper
reasoning. Default to **`claude-sonnet-5`** and reach for **`claude-opus-4-8`** for the hard,
high-stakes work.

**Use `claude-sonnet-5` (default) for:**
- Implementing a specced slice where the design is already settled.
- Single-file or small multi-file edits, bug fixes, and refactors with a clear shape.
- Writing tests, docs, commit messages, and backlog/`docs/` authoring.
- Mechanical follow-ups from a review (applying agreed fixes).
- Wiring a built sim command into the strip menu, or a snapshot field into a strip.
- Tracing/answering "where does X live" and other code-navigation questions.

**Use `claude-opus-4-8` for:**
- Architectural decisions that cross the **sim ↔ UI boundary** or change the command/snapshot
  contract (a new snapshot predicate is routine; changing what `dispatch` logs, or how
  clearances are phrased and read back, is not).
- A genuinely new subsystem — a new controller mode, a new airport's data pipeline — which per
  the cadence above gets a short `docs/` note before code.
- Authoring or amending a `docs/` design note, or resolving a fork the docs leave open (e.g.
  whether Ground's crossing stays direct or becomes a Tower-coordinated request).
- Modelling **authority and state machines**: who owns an aircraft, what a clearance permits and
  when it is spent, which of two predicates is the authority for a question. These are cheap to
  write and expensive to unwind, and they are where the real bugs have been.
- Determinism and ordering bugs — per-tick resolution order, a latch that goes stale, state read
  a frame after the thing that set it. The class where the test passes and the model is wrong.
- Multi-step work spanning many files where the plan itself is uncertain.

**Escalate Sonnet → Opus mid-task when:**
- Sonnet has tried twice and the fix isn't converging (thrashing, or re-introducing the same bug).
- The change turns out to deviate from a `docs/` note or an always-on guardrail, and the right
  call needs design judgment rather than a patch.
- The blast radius grew past the original estimate — what looked like a one-file edit now
  reshapes the sim/UI contract, the comms phraseology, or a widely-used test fixture. *(Real
  example: tightening a clearance guard to read the held route instead of the goal broke ~30
  tests, because "where is it going" and "what does this clearance do" are different questions.
  That is an escalate, not a fixture sweep.)*
- A code review surfaces a CRITICAL/architectural finding rather than a mechanical one.

When escalating, hand off with the current state captured — what was tried, what failed, the
relevant `file:line` — so Opus isn't re-deriving from scratch.

## Working Conventions

- **Git:** commit directly to `main` — this is a solo project, no PRs. Keep commits conventional-format and green (`make check` passes). Don't branch or open PRs unless explicitly asked.
- The domain uses precise ATC terminology (SID, STAR, TRACON, squawk, LUAW, feeder fix, wake category). Match it exactly — the design docs cite FAA Order 7110.65, AIM Ch. 4, and AC 90-23G as authorities.
- Prefer deriving per-mode data from one flight record over storing redundant copies.
- When the design docs and general ATC knowledge conflict, the docs win (they reflect intentional game-design tradeoffs, not just realism).
