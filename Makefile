# AnotherATC — developer tasks.
#
# Requires Node >= 22.13 (pnpm 11) and pnpm via Corepack. The repo pins Node in
# .nvmrc, so activate it first with `fnm use` (or `nvm use`) if your shell's
# default is older. Run `make` or `make help` to list targets.

SHELL := /bin/bash
PNPM  := pnpm
SIM   := @anotheratc/sim
WEB   := @anotheratc/web

.DEFAULT_GOAL := help

.PHONY: help
help: ## List available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: check-node
check-node: ## Verify Node is new enough for pnpm 11
	@node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)){console.error("\n  Node "+process.versions.node+" is too old — pnpm 11 needs >= 22.13.\n  Activate the pinned version:  fnm use   (or nvm use)\n");process.exit(1)}'

.PHONY: install
install: check-node ## Install dependencies (enforces the supply-chain policy)
	$(PNPM) install

# ─── Run ────────────────────────────────────────────────────────────────────

.PHONY: dev
dev: check-node ## Run the web app with hot reload (sim + web changes both reload)
	$(PNPM) dev

.PHONY: watch
watch: check-node ## Dev server + typecheck + sim tests, all watching (Ctrl-C stops all)
	@echo "▶ dev server + tsc --watch + vitest — Ctrl-C to stop all"
	@trap 'kill 0' EXIT INT TERM; \
		$(PNPM) dev & \
		$(PNPM) --filter $(SIM) exec tsc --noEmit --watch --preserveWatchOutput & \
		$(PNPM) --filter $(SIM) exec vitest & \
		wait

.PHONY: preview
preview: check-node ## Build then serve the production bundle
	$(PNPM) build && $(PNPM) --filter $(WEB) exec vite preview

.PHONY: build
build: check-node ## Production build of the web app
	$(PNPM) build

# ─── Quality gates ──────────────────────────────────────────────────────────

.PHONY: test
test: check-node ## Run all tests once
	$(PNPM) -r test

.PHONY: test-watch
test-watch: check-node ## Run sim tests in watch mode
	$(PNPM) --filter $(SIM) exec vitest

.PHONY: typecheck
typecheck: check-node ## Typecheck every package
	$(PNPM) -r typecheck

.PHONY: typecheck-watch
typecheck-watch: check-node ## Typecheck the sim in watch mode
	$(PNPM) --filter $(SIM) exec tsc --noEmit --watch --preserveWatchOutput

.PHONY: lint
lint: check-node ## Lint (includes the sim headless-boundary rule)
	$(PNPM) lint

.PHONY: audit
audit: check-node ## Supply-chain audit (fails on high severity)
	$(PNPM) audit --audit-level=high

.PHONY: check
check: typecheck lint test ## Full gate: typecheck + lint + test

# ─── Data / housekeeping ────────────────────────────────────────────────────

.PHONY: ingest-ksan
ingest-ksan: check-node ## Rebuild KSAN surface data from the committed OSM snapshot
	node tools/ingest/build-ksan-surface.mjs

.PHONY: clean
clean: ## Remove build outputs and installed dependencies
	rm -rf node_modules packages/*/node_modules apps/*/node_modules apps/web/dist
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
