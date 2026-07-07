---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Testing

> This file extends [common/testing.md](../common/testing.md) with TypeScript/JavaScript specific content.

## AnotherATC

Primary runner is **Vitest** (`fnm exec --using=22 -- pnpm -r test`). The deterministic sim
core (`packages/sim`) holds most tests — assert behavior over fixed `step(dt)` loops with a
seeded `Rng` (never `Math.random()`/`Date.now()`). The 80% target applies to the sim core.

## E2E Testing

Use **Playwright** as the E2E testing framework for critical user flows — but it is not yet
installed here: any new dependency (Playwright included) must first pass the supply-chain
vetting in `docs/security/dependency-policy.md`.

## Agent Support

- **e2e-runner** - Playwright E2E testing specialist
