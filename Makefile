# AnotherATC — developer tasks.
#
# Requires Node >= 22.13 (pnpm 11). If your active Node is older but `fnm` has a
# suitable version installed (`fnm install 22`), these targets transparently run
# through it — you do NOT need fnm shell integration. Run `make` to list targets.

SHELL := /bin/bash
PNPM  := pnpm
SIM   := @anotheratc/sim
WEB   := @anotheratc/web

# Is the currently-active node new enough?
NODE_OK := $(shell node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>22||(a===22&&b>=13)?"1":"")' 2>/dev/null)
# If not, and fnm is available, route commands through fnm's Node 22.
ifeq ($(NODE_OK),1)
  RUN :=
else ifneq ($(shell command -v fnm 2>/dev/null),)
  RUN := fnm exec --using=22 --
else
  RUN :=
endif

.DEFAULT_GOAL := help

.PHONY: help
help: ## List available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: check-node
check-node: ## Verify (or select) a Node new enough for pnpm 11
	@$(RUN) node -e 'const v=process.versions.node,[a,b]=v.split(".").map(Number); if(a<22||(a===22&&b<13)){console.error("\n  Node "+v+" is too old — pnpm 11 needs >= 22.13.\n  Install it once:  fnm install 22   (then targets auto-use it)\n");process.exit(1)} console.error("using node "+v)'

.PHONY: install
install: check-node ## Install dependencies (enforces the supply-chain policy)
	$(RUN) $(PNPM) install

# ─── Run ────────────────────────────────────────────────────────────────────

.PHONY: dev
dev: check-node ## Run the web app with hot reload (sim + web changes both reload)
	$(RUN) $(PNPM) dev

.PHONY: watch
watch: check-node ## Dev server + typecheck + sim tests, all watching (Ctrl-C stops all)
	@echo "▶ dev server + tsc --watch + vitest — Ctrl-C to stop all"
	@trap 'kill 0' EXIT INT TERM; \
		$(RUN) $(PNPM) dev & \
		$(RUN) $(PNPM) --filter $(SIM) exec tsc --noEmit --watch --preserveWatchOutput & \
		$(RUN) $(PNPM) --filter $(SIM) exec vitest & \
		wait

.PHONY: preview
preview: check-node ## Build then serve the production bundle
	$(RUN) $(PNPM) build && $(RUN) $(PNPM) --filter $(WEB) exec vite preview

.PHONY: build
build: check-node ## Production build of the web app
	$(RUN) $(PNPM) build

# ─── Quality gates ──────────────────────────────────────────────────────────

.PHONY: test
test: check-node ## Run all tests once
	$(RUN) $(PNPM) -r test

.PHONY: test-watch
test-watch: check-node ## Run sim tests in watch mode
	$(RUN) $(PNPM) --filter $(SIM) exec vitest

.PHONY: typecheck
typecheck: check-node ## Typecheck every package
	$(RUN) $(PNPM) -r typecheck

.PHONY: typecheck-watch
typecheck-watch: check-node ## Typecheck the sim in watch mode
	$(RUN) $(PNPM) --filter $(SIM) exec tsc --noEmit --watch --preserveWatchOutput

.PHONY: lint
lint: check-node ## Lint (includes the sim headless-boundary rule)
	$(RUN) $(PNPM) lint

.PHONY: audit
audit: check-node ## Supply-chain audit (fails on high severity)
	$(RUN) $(PNPM) audit --audit-level=high

.PHONY: check
check: typecheck lint test ## Full gate: typecheck + lint + test

# ─── Data / housekeeping ────────────────────────────────────────────────────

.PHONY: ingest-ksan
ingest-ksan: check-node ## Rebuild KSAN surface data from the committed OSM snapshot
	$(RUN) node tools/ingest/build-ksan-surface.mjs

.PHONY: audit-taxi
audit-taxi: check-node ## Audit a field's taxi-graph geometry (AIRPORT=KBUR, or all fields)
	@AUDIT_AIRPORT=$(or $(AIRPORT),ALL) $(RUN) $(PNPM) --filter $(SIM) exec vitest run \
		src/world/taxiAuditCli.test.ts --disable-console-intercept --reporter=dot

.PHONY: clean
clean: ## Remove build outputs and installed dependencies
	rm -rf node_modules packages/*/node_modules apps/*/node_modules apps/web/dist
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
