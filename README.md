# AnotherATC

An air-traffic-control simulation game, built web-first as a TypeScript monorepo. You work the
positions a real controller works — clearance, ground, tower — moving aircraft through pushback,
taxi, runway crossings, line-up, and takeoff on a faithfully modelled airport surface.

The engine is a hard split: a deterministic, headless **sim core** knows the rules of ATC and
nothing about pixels; a **React/Vite** layer renders it and dispatches commands back. Every airport
is *data* behind a generic `Airport` bundle, so adding a field is a data exercise rather than a
rewrite.

> **Status:** in active development. The **Ground** and **Tower** (Local Control) positions are
> substantially built; **TRACON** and **Center** are planned. Three airports ship —
> [KSAN](docs/SAN/), [KBUR](docs/BUR/), and [KOAK](docs/OAK/) — spanning single-runway,
> intersecting, and parallel geometries.

---

## Quick start

**Prerequisites:** Node ≥ 22.13 (pnpm 11 uses `node:sqlite`). The repo pins Node 22 via `.nvmrc` —
`fnm use` or `nvm use`. A `Makefile` wraps the common tasks and routes through the right Node
automatically.

```bash
make install     # install dependencies (honours the supply-chain policy)
make dev         # run the web app (Vite dev server, sim + web both hot-reload)
make check       # the full gate: typecheck + lint + test
make help        # list every target
```

Then open the printed local URL. Pick a field with `?airport=KBUR` or `?airport=KOAK`
(defaults to KSAN); append `?dev` for the sandbox (empty surface, spawn/probe/graph tools).

Prefer raw pnpm? `pnpm install`, `pnpm dev`, `pnpm -r test`, `pnpm -r typecheck`, `pnpm lint`.

---

## The domain model

The game models real-world ATC as **four controller positions**, each mapping to a real FAA
facility and a phase of flight. This split is the primary architectural axis.

| Position | Real facility | Phase | Status |
|---|---|---|---|
| Clearance / Ground | ATCT Clearance Delivery + Ground Control | Pre-departure, taxi | 🚧 built |
| Tower | ATCT Local Control | Runway ops, takeoff, landing | 🚧 built |
| TRACON | TRACON Approach + Departure | Terminal airspace, ~0–50 nm | ⬜ planned |
| Center | ARTCC En-Route | Cruise | ⬜ planned |

Aircraft move between positions via **handoffs**, the mode-transition mechanic and a deliberate
source of gameplay tension. Two ideas run through the whole design:

- **One flight, mode-specific projections.** A single flight record renders as a different **flight
  strip** in each position — each showing only what is *actionable* at that phase.
- **The strip is a state machine.** A strip's status flags gate which actions are available (a
  `HOLD SHORT` strip offers `CROSS RUNWAY`, never `CLEARED TO LAND`).

High-tension mechanics that are first-class, not afterthoughts: wake-turbulence spacing, departure
releases and wheels-up (EDCT) windows, go-arounds, runway crossings, ground servicing, and
turnaround. See [`docs/atc-flight-cycle.md`](docs/atc-flight-cycle.md) and
[`docs/atc-flight-strips.md`](docs/atc-flight-strips.md).

---

## Airports

Every field is expressed as data behind the generic `Airport` bundle; the engine carries no airport
specifics. Geometry comes from surveyed **FAA NASR** data and **OpenStreetMap** pavement, verified
against the FAA airport diagram — see [`docs/airport-data-pipeline.md`](docs/airport-data-pipeline.md)
and [`docs/adding-an-airport.md`](docs/adding-an-airport.md).

| Field | Name | Runways | What it exercises |
|---|---|---|---|
| **KSAN** | San Diego Intl | 1 (09/27) | the base loop; displaced thresholds, EMAS, the single-runway model |
| **KBUR** | Hollywood Burbank | 2, **intersecting** (08/26 × 15/33) | position-aware runway crossing at the shared intersection |
| **KOAK** | Oakland Intl | 4, **parallel** (10L/28R ∥ 10R/28L, 1,001 ft) | dependent parallels; two-field taxi with one-runway-at-a-time crossings |

---

## Architecture

```
packages/sim   headless sim core — pure TS, zero UI/DOM deps (enforced by ESLint + a DOM-free
               tsconfig). Deterministic: no Math.random()/Date.now(); a seeded Rng is threaded
               through. Aircraft, ATC rules, the tick loop, and the strip state machine live here.

apps/web       React + Vite. Imports @anotheratc/sim as source, renders it (radar on Canvas2D,
               strips/panels in DOM), and dispatches commands back. The sim never imports React.

tools/ingest   one-time OSM → local-nm surface projectors (no runtime network calls); the raw
               snapshots are committed so ingestion is reproducible.
```

The sim ↔ UI contract is **commands in, immutable snapshots out**. Two principles keep the split
honest:

- **Determinism.** A given seed replays identically. This is what makes the tests trustworthy and
  will later enable record/replay.
- **The airport/engine split.** A value that would be *wrong at a different airport* is the field's
  and rides the `Airport` bundle; a rule that applies wherever it applies is the engine's.
  `packages/sim/src/world/airport.test.ts` builds a fictional field from scratch and plays a full
  arrival and departure on it — if that passes, the abstraction is real.

---

## Commands

`make help` lists everything. The essentials:

| Task | Make | pnpm |
|---|---|---|
| Install | `make install` | `pnpm install` |
| Dev server | `make dev` | `pnpm dev` |
| Dev + typecheck + tests, all watching | `make watch` | — |
| Production build | `make build` | `pnpm build` |
| All tests once | `make test` | `pnpm -r test` |
| Typecheck | `make typecheck` | `pnpm -r typecheck` |
| Lint (incl. sim headless-boundary rule) | `make lint` | `pnpm lint` |
| Supply-chain audit | `make audit` | `pnpm audit --audit-level=high` |
| **Full gate** | `make check` | — |

Run a single sim test file: `pnpm --filter @anotheratc/sim exec vitest run src/random.test.ts`.

---

## Documentation

The `docs/` notes are the source of truth for the domain model — read them before proposing
mechanics or data.

- [`atc-flight-cycle.md`](docs/atc-flight-cycle.md) — the full departure→arrival sequence and the handoff table
- [`atc-flight-strips.md`](docs/atc-flight-strips.md) — the controller modes and per-mode strip layouts
- [`atc-tower.md`](docs/atc-tower.md) · [`atc-runway-crossing.md`](docs/atc-runway-crossing.md) · [`atc-multi-runway.md`](docs/atc-multi-runway.md) · [`atc-operations.md`](docs/atc-operations.md) · [`wake-turbulence.md`](docs/wake-turbulence.md)
- [`airport-data-pipeline.md`](docs/airport-data-pipeline.md) — where every airport number comes from (NASR, d-TPP, OSM)
- [`adding-an-airport.md`](docs/adding-an-airport.md) · [`lessons-from-ksan.md`](docs/lessons-from-ksan.md) — building a new field, and the post-mortem to read first
- [`docs/SAN/`](docs/SAN/) · [`docs/BUR/`](docs/BUR/) · [`docs/OAK/`](docs/OAK/) — per-airport chart indexes and surveyed runway facts
- [`docs/security/`](docs/security/) — the dependency-vetting policy

---

## Development conventions

- **Deterministic sim.** Never `Math.random()` / `Date.now()` in `packages/sim` — thread the seeded
  `Rng` (`createRng`). The headless boundary (no React, no `window`/`document`) is enforced by ESLint
  and a DOM-free tsconfig.
- **Supply-chain vetting** is required before adding any npm dependency — follow
  [`docs/security/dependency-policy.md`](docs/security/dependency-policy.md). Hardening lives in
  `pnpm-workspace.yaml` (24h install cooldown, build-script allowlist, exact pins, committed lockfile).
- **Testing cadence.** Per-command unit tests plus at least one end-to-end scenario per slice, on the
  real spawn/command path — the interesting bugs live in multi-actor interaction. `make check` must
  be green before every commit.
- **Docs win over realism** where they conflict — they encode deliberate game-design tradeoffs.

CI (`.github/workflows/ci.yml`) runs install (frozen lockfile), `pnpm audit`, typecheck, lint, tests,
the web build, and an OSV supply-chain scan.
