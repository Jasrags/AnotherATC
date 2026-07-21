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
- `docs/SAN/` — FAA charts for San Diego International (KSAN) as PDFs (airport diagram, STARs, SIDs, approach plates), indexed by `docs/SAN/README.md`. These are **reference material** for building the first real airport: use them to validate nav-fix positions, runway 9/27 setup, taxiway network, and hot spot HS1. `docs/SAN/README.md` also lists charts still "to acquire."

KSAN is the intended first airport. Charts are on the SW-3 cycle (19 MAR 2026 – 16 APR 2026).

## Working with Claude (development harness)

How we collaborate here (defaults — override any time with a one-off instruction):

- **Cadence — a theme at a time.** Given a goal, decompose it into items, execute end-to-end, commit each green step to `main`, and check in when the theme is done or a real fork appears. Don't stop after every item for confirmation.
- **You give the goal, I decompose.** You hand me a theme in your words; I break it down, sequence it (propose the order, then go). Work queues: `backlog.md` (features) and `docs/code-review-baseline.md` (review debt).
- **Planning is lightweight — TDD is the spec.** A few bullets, then failing tests (RED→GREEN); the tests document intent. No formal PRD/design docs except for a genuinely new subsystem (e.g. a new controller mode), which gets a short `docs/` note first.
- **Test the loop, not just the pieces.** Per-command unit tests are necessary but not sufficient — **each slice gets at least one end-to-end scenario test through the real command sequence, with fixtures on the real spawn/entry path.** The bugs live in multi-actor interaction (e.g. two aircraft contending for one runway), which single-actor units structurally miss. _(Learned the hard way on Tower: line-up refused behind a rolling departure, can't launch #2 until #1 clears the whole runway, dev-spawned aircraft offered "Cross runway" not "Contact tower" — all invisible to single-aircraft tests.)_
- **Review each slice, not just green tests.** At the end of a slice, run a code-review pass (parallel specialist reviewers over `git diff <pre-slice-commit>..HEAD`, e.g. `typescript-reviewer` for `packages/sim`, `react-reviewer` for `apps/web`) and fix CRITICAL/HIGH before calling it done. `make check` green is necessary, not sufficient — reviews have caught real HIGH bugs that passed all tests. Note: some defects are *spec* misses (the rule itself is wrong, faithfully tested green); those need domain review or play-testing, not more units.
- **Reach for heavy tooling proactively.** Use parallel agents / workflows when breadth clearly warrants it (e.g. a multi-file review sweep), noting the rough cost — don't wait to be asked.

**Steering vocabulary** (cheap mid-flight redirects): *"plan this"* = plan-mode, no code till approved · *"continue"/"keep going"* = execute autonomously, commit per green step · *"review X"* = code-review pass · *"fan out"/"ultracode"* = multi-agent breadth · *"checkpoint"* = stop and summarize state.

**Always-on guardrails** (enforced without asking): determinism (seeded `Rng`, never `Math.random`/`Date.now`), immutability, sim headless boundary, supply-chain vetting before any dep, `make check` green before every commit, a code-review pass + an end-to-end scenario test per slice, docs-win-over-realism.

## Working Conventions

- **Git:** commit directly to `main` — this is a solo project, no PRs. Keep commits conventional-format and green (`make check` passes). Don't branch or open PRs unless explicitly asked.
- The domain uses precise ATC terminology (SID, STAR, TRACON, squawk, LUAW, feeder fix, wake category). Match it exactly — the design docs cite FAA Order 7110.65, AIM Ch. 4, and AC 90-23G as authorities.
- Prefer deriving per-mode data from one flight record over storing redundant copies.
- When the design docs and general ATC knowledge conflict, the docs win (they reflect intentional game-design tradeoffs, not just realism).
