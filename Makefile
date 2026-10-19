# minmux — task runner
# Run `make` or `make help` to see available targets.

.ONESHELL:
SHELL := /bin/bash
.DEFAULT_GOAL := help

## ─────────────────────────────── Setup ───────────────────────────────

.PHONY: install
install: ## Install deps, rebuild native modules, activate git hooks
	npm install
	npx electron-rebuild -f -o node-pty
	npx lefthook install || echo "run 'npm i -D lefthook' to enable git hooks"

## ─────────────────────────────── Run ─────────────────────────────────

.PHONY: run
run: ## Run the app in dev mode, dev profile (MINMUX_PROFILE=<name> for another)
	npm run dev

.PHONY: dev
dev: run ## Alias for `run`

.PHONY: build
build: ## Build the app (electron-vite)
	npm run build

.PHONY: dist
dist: ## Package installable artifacts for this OS (ad-hoc signed; .dmg/.zip on mac)
	npm run dist

# git-cliff is a devDependency (pinned in package-lock.json)
CLIFF := npx --no-install git-cliff
# CHANGELOG.md starts after v0.1.0 (cliff.toml's footer holds 0.1.0).
CHANGELOG_RANGE := v0.1.0..HEAD

.PHONY: changelog
changelog: ## Regenerate CHANGELOG.md from the PR titles on main (TAG=vX.Y.Z names the unreleased part)
	$(CLIFF) $(CHANGELOG_RANGE) $(if $(TAG),--tag $(TAG)) -o CHANGELOG.md

.PHONY: release-notes
release-notes: ## Print TAG's CHANGELOG.md entry without its heading (the GitHub release body)
	$(if $(TAG),,$(error TAG=vX.Y.Z is required))
	@awk -v head='## [$(patsubst v%,%,$(TAG))]' \
	  '/^## / { if (on) exit; on = index($$0, head) == 1; next } on && NF { text = 1 } on && text' CHANGELOG.md

.PHONY: release
release: ## Cut a release: start the Release workflow on GitHub (BUMP=patch|minor|major, default patch)
	gh workflow run release.yml -f bump=$(or $(BUMP),patch) && \
	  echo "Release started on GitHub: follow it with 'gh run watch' or in Actions → Release."

## ─────────────────────────────── Lint ────────────────────────────────

.PHONY: lint
lint: ## Lint: tsc (renderer + electron) + eslint + prettier check
	npm run typecheck
	npm run lint
	npm run format:check

## ─────────────────────────────── Format ──────────────────────────────

.PHONY: fmt
fmt: ## Auto-format (eslint --fix + prettier)
	npm run lint:fix
	npm run format

## ─────────────────────────────── Test ────────────────────────────────

.PHONY: test
test: ## Run tests (Vitest)
	npm run test

.PHONY: coverage
coverage: ## Coverage report
	npm run test:coverage

## ─────────────────────────────── Gates ───────────────────────────────

.PHONY: check
check: lint test ## Do all: lint + test (the pre-merge gate)

.PHONY: ci
ci: check build ## Full local CI: lint + test + build

.PHONY: audit
audit: ## Security audit of dependencies
	npm audit --omit=dev || true

## ─────────────────────────────── Misc ────────────────────────────────

.PHONY: hooks
hooks: ## Install/refresh git hooks (lefthook)
	npx lefthook install

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf out dist coverage

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
