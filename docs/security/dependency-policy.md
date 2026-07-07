# Dependency & Supply-Chain Security Policy

The npm ecosystem is the primary target of software supply-chain attacks. In 2025 alone ~454,600 new malicious npm packages were catalogued (~1.23M cumulative, +75% YoY). The dominant 2025–2026 pattern is **self-propagating worms that execute at install time** (`postinstall` hooks), steal npm/GitHub/cloud tokens, and auto-republish into more packages — e.g. Shai-Hulud / Shai-Hulud 2.0, the axios compromise (Mar 2026, live ~3h at 100M weekly downloads), Miasma / `@redhat-cloud-services` (Jun 2026), and the Phantom Gyp / node-gyp wave (Jun 2026).

**Key fact we design around:** most malicious versions are detected and unpublished within hours. A short install cooldown blocks the overwhelming majority before we ever fetch them.

This policy is mandatory for every dependency added to this repo.

## Threat Model

| Vector | Example | Our control |
|---|---|---|
| Install-time code execution | `postinstall` steals tokens | Build scripts blocked by default (allowlist) |
| Hijacked popular package (phished maintainer) | axios, chalk/debug | Install cooldown (`minimumReleaseAge`) |
| Self-propagating worm via stolen tokens | Shai-Hulud, Miasma | Cooldown + secrets hygiene + scoped short-lived tokens |
| Typosquatting / dependency confusion | `plain-crypto-js` | Manual add-review checklist; scoped internal packages |
| Malicious transitive dep from exotic source | git/tarball subdep | `blockExoticSubdeps` |
| Silent malicious downgrade of trust | republished bad version | `trustPolicy: no-downgrade` |

## Baseline Controls (baked into the scaffold)

### 1. pnpm ≥ 11, pinned via Corepack
pnpm 11 ships hardened defaults built for this threat model. Pin the exact version in `package.json` `packageManager` and use Corepack so everyone (and CI) runs the same resolver.

### 2. `pnpm-workspace.yaml` security settings
```yaml
# Supply-chain hardening — see docs/security/dependency-policy.md
minimumReleaseAge: 1440          # 24h cooldown; a version must be >=1 day old to install
blockExoticSubdeps: true         # no git/tarball transitive deps
trustPolicy: no-downgrade        # reject a package whose trust level dropped vs prior release
allowBuilds:                     # ONLY these packages may run install/build scripts
  - esbuild                      # native binary fetch; required by vite + vitest
# dangerouslyAllowAllBuilds: NEVER set this
```
- Every entry in `allowBuilds` is a reviewed decision — a package that *needs* a postinstall script is higher risk and must be justified here.
- `minimumReleaseAge` may be raised (e.g. `4320` = 3 days) for extra margin; never lower it.

### 3. `.npmrc`
```ini
save-exact=true                  # no ^/~ ranges — lockfile + exact pins only
```

### 4. Lockfile is law
- `pnpm-lock.yaml` is committed and reviewed on every change.
- CI installs with `pnpm install --frozen-lockfile` — a drifted lockfile fails the build.

### 5. CI gates (GitHub Actions)
Run on every PR; a failure blocks merge:
- `pnpm audit --audit-level=high` (known CVEs)
- `osv-scanner` (broader advisory coverage than npm audit)
- **Socket** (free GitHub app + CLI) — flags install scripts, obfuscation, network/filesystem access, and newly-risky versions that CVE scanners miss
- `pnpm install --frozen-lockfile` and `pnpm dedupe --check`

### 6. Automated updates with cooldown
- Renovate (or Dependabot) with a **cooldown / grace period** on routine version bumps; **security advisories fast-tracked**. Never auto-merge without the cooldown + CI gates above.

### 7. Secrets hygiene (worms harvest tokens)
- No long-lived npm publish tokens on dev machines; use granular, short-lived tokens and 2FA.
- Do **not** run `pnpm install` in a shell that has cloud/CI credentials in its environment.
- Prefer installing in CI or a sandbox; treat any machine that ran a compromised install as credential-exposed.

## Adding a Dependency — Required Checklist

Before adding any package (direct or intentionally pulled transitive), confirm and note in the PR:

- [ ] **Necessity** — can this be done with the standard library, existing deps, or a small amount of our own code? Fewer deps = smaller attack surface.
- [ ] **Reputation** — maintained, real download volume, healthy repo, known author/org.
- [ ] **Age** — not brand-new; the specific version clears `minimumReleaseAge`.
- [ ] **Transitive footprint** — check `pnpm why` / dependency count; reject deep unfamiliar chains.
- [ ] **Install scripts** — does it (or a dep) run `postinstall`? If so, justify the `allowBuilds` entry.
- [ ] **Provenance** — prefer packages published with npm provenance / sigstore attestation.
- [ ] **Socket score** — run `pnpm dlx socket manifest` / check the Socket report; no unexplained capabilities.
- [ ] **License** — compatible with the project.

Prefer **zero- or low-dependency** packages (e.g. `zod` has no runtime deps).

## Vetting Log — Current Intended Dependencies

For the walking-skeleton scaffold. Full verification (`pnpm why`, Socket, provenance) happens at install time; this is the pre-install assessment.

| Package | Publisher | Runtime deps | Install script | Risk | Notes |
|---|---|---|---|---|---|
| `react`, `react-dom` | Meta | minimal | none | Low | Heavily scrutinized, published with provenance |
| `typescript` | Microsoft | none | none | Low | No runtime deps |
| `zod` | colinhacks | **zero** | none | Very low | Ideal dependency profile |
| `vite`, `@vitejs/plugin-react` | Vite team | transitive (rollup, esbuild) | via esbuild | Medium | Large transitive tree; `esbuild` needs `allowBuilds` |
| `vitest` | Vitest team | larger transitive tree | via esbuild | Medium | Vet transitive tree with Socket |
| `@types/react`, `@types/react-dom` | DefinitelyTyped | none | none | Low | Types only (stripped at build) |
| eslint + boundary enforcement | eslint / plugin author | some | none | Medium | Pin the boundary plugin; vet it specifically |

**Build-script allowlist for this set:** `esbuild` only. Anything else requesting a build script is a stop-and-review event.

## References
- pnpm supply-chain security: https://pnpm.io/supply-chain-security
- Socket: https://socket.dev
- OSV-Scanner: https://google.github.io/osv-scanner/
