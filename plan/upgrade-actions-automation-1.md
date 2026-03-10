---
goal: Major upgrade of repository MCP toolsets, GitHub Actions, automation, CI/CD efficiency, and frontend architecture modernization
version: 2.0
date_created: 2026-03-09
last_updated: 2026-03-09
owner: dkylepeppers-alt
status: 'Planned'
tags: [upgrade, automation, ci-cd, actions, mcp, efficiency, infrastructure, vite, typescript, modernization]
---

# Introduction


Comprehensive upgrade plan for the AI Comic Creator repository's GitHub Actions workflows, MCP toolsets, automation scripts, CI/CD efficiency, and frontend architecture. The current pipeline consists of 7 workflows, 8+ Copilot agents, 4 automation scripts, and a Dependabot configuration. The app itself is built with vanilla HTML/CSS/JS globals (no build step, no module system, no type checking) which limits developer velocity and code quality. This plan identifies gaps, inefficiencies, and architectural debt across both the CI/CD pipeline and the application itself, then prescribes concrete, phased improvements.

### Current State Summary

| Area | Count | Key Observations |
|------|-------|------------------|
| Workflows | 7 | tests.yml, playwright.yml, auto-bump.yml, auto-update-docs.yml, deploy-pages.yml, release.yml, security.yml |
| Agents | 14 | 8 gem-team agents + Bugfixer, Docs-agent, Readme, my-agent, Anotherplanner, architect-innovator |
| Scripts | 4 | bump-version.sh, update-docs.sh, install-hooks.sh, pre-commit |
| Dependabot | 2 ecosystems | npm (weekly), github-actions (weekly) -- no labels, no PR limits, no commit message prefix |
| Pre-commit hook | 1 check | Version consistency only -- no syntax, lint, or format checks |
| Test runners | 2 | Node built-in test runner (unit) + Playwright (E2E) -- no coverage reporting |
| Frontend architecture | Vanilla | Browser globals (IIFEs), no module system, no bundler, no TypeScript, no build step, manual `<script>` ordering |
## 1. Requirements & Constraints

- **REQ-001**: The frontend architecture should be modernized to use ES modules, a build tool (Vite), and TypeScript. The migration is incremental **at the phase level** — each phase produces a stable, shippable checkpoint. However, within Phase 9 the IIFE→ESM conversion (TASK-036/037) is an **atomic step** because old `<script>` tags and the ES module entry point cannot coexist in a working state (see RISK-006). That phase must be completed on a dedicated feature branch, verified with a full E2E pass, then merged as a single PR. All other phases (TypeScript rename, Vitest migration, etc.) can proceed file-by-file. Define intermediate checkpoints: (1) Vite builds and serves the existing JS files unchanged, (2) ESM conversion lands as one atomic PR with full E2E pass, (3) each TypeScript rename compiles with zero `tsc --noEmit` errors
- **REQ-002**: All 5 version files must remain in sync — any workflow change must not break the version consistency test (`config-integrity.test.js`). The version sync mechanism itself may be simplified once a build tool manages it
- **REQ-003**: New workflows must use job-level permissions (least-privilege) following existing convention
- **REQ-004**: Bot loop guards must be maintained — all auto-commit workflows must skip `github-actions[bot]` and `copilot[bot]` actors
- **REQ-005**: The `auto-main-push` concurrency group must be preserved for `auto-bump.yml` and `auto-update-docs.yml` until Phase 6 replaces them
- **REQ-006**: Playwright E2E tests should run against the Vite dev server (after Phase 9 migration) or the Vite preview server, replacing `python3 -m http.server 8080`
- **REQ-007**: New workflows should not duplicate existing functionality — reuse composite actions where possible
- **REQ-008**: Choose the best tool for each job regardless of dependency count — this is a major upgrade, not a patch
- **SEC-001**: No secrets or tokens may be hardcoded — all credentials must use GitHub Actions secrets or `github.token`
- **SEC-002**: Security scanning must cover both npm dependencies and code quality (not just weekly — also on PRs)
- **SEC-003**: Third-party actions must be pinned to specific SHA commits, not floating tags, to prevent supply-chain attacks
- **CON-001**: The repository is a client-side PWA — CI does not need server/database provisioning, but will require a build step after Phase 9 (Vite)
- **CON-002**: Node.js 22 is the target runtime (per existing workflows)
- **CON-003**: New npm packages may be added freely as `devDependencies` or `dependencies` where the build tool needs them. Choose the best-in-class tool for every job regardless of dependency count
- **CON-004**: Agent definition files in `.github/agents/` follow the `.agent.md` naming convention with YAML frontmatter; `.github/agents/architect-innovator.md` is a documented legacy exception that must be renamed/converted to `architect-innovator.agent.md` with YAML frontmatter as part of this upgrade
- **CON-005**: After the Vite migration (Phase 9), `deploy-pages.yml` must deploy the `dist/` build output instead of raw source files
- **GUD-001**: Workflows should complete in under 5 minutes for the common case (push to feature branch)
- **GUD-002**: Use GitHub Actions cache for `node_modules` and Playwright browsers to reduce CI wall time
- **GUD-003**: Prefer workflow reuse (composite actions or reusable workflows) over copy-pasting setup steps
- **PAT-001**: Follow the existing pattern of job-level `permissions` blocks on all new workflows
- **PAT-002**: Follow the existing concurrency group pattern for workflows that push commits to `Main`
- **PAT-003**: Workflow file naming: lowercase-kebab-case `.yml` files in `.github/workflows/`

## 2. Implementation Steps

### Implementation Phase 1 — Composite Actions & Shared Setup (Foundation)

- GOAL-001: Eliminate duplicated setup steps across workflows by creating reusable composite actions. Currently, 5 of 7 workflows repeat the identical Node.js + npm install sequence.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `.github/actions/setup-node-env/action.yml` composite action that performs: (1) `actions/checkout@v4`, (2) `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, (3) `npm ci`. This replaces the 3-step boilerplate in `tests.yml`, `playwright.yml`, `release.yml`, `security.yml`, and any new workflows. | ✅ | 2026-03-09 |
| TASK-002 | Create `.github/actions/setup-playwright/action.yml` composite action that performs: (1) calls `setup-node-env`, (2) caches Playwright browsers using `actions/cache@v4` with key `playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}` and path `~/.cache/ms-playwright`, (3) runs `npx playwright install --with-deps chromium` only on cache miss. | ✅ | 2026-03-09 |
| TASK-003 | Refactor `tests.yml` to use `setup-node-env` composite action, removing the duplicated checkout/setup-node/npm-ci steps. Verify all 4 steps (checkout, setup, install, syntax-check, lint, test) still pass. | ✅ | 2026-03-09 |
| TASK-004 | Refactor `playwright.yml` to use `setup-playwright` composite action. Verify Playwright browser caching works (second run should skip browser download). | ✅ | 2026-03-09 |
| TASK-005 | Refactor `release.yml` to use `setup-node-env` composite action. Verify the full release flow still works (tests -> bump -> commit -> tag -> release). | ✅ | 2026-03-09 |
| TASK-006 | Refactor `security.yml` to use `setup-node-env` composite action. | ✅ | 2026-03-09 |

### Implementation Phase 2 — Enhanced CI Pipeline (Quality Gates)

- GOAL-002: Add missing quality gates to the CI pipeline: Prettier formatting enforcement, test coverage reporting, and PR-triggered security scanning.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Add a `format-check` step to `tests.yml` that runs `npm run format:check` after the lint step. This enforces Prettier formatting on every push and PR. Currently, `format:check` exists as a script but is not run in CI. | | |
| TASK-008 | Create `.github/workflows/security-pr.yml` workflow triggered on `pull_request` events that runs `npm audit --audit-level=high`. This supplements the weekly `security.yml` cron with PR-time checks so vulnerabilities are caught before merge. Use the `setup-node-env` composite action. | | |
| TASK-009 | Add `c8` as a devDependency for test coverage reporting. Update the test command in `tests.yml` to run `npx c8 --reporter=text --reporter=lcov node --test test/*.test.js`. Add a `codecov/codecov-action@v4` step that uploads the `coverage/lcov.info` report to Codecov after tests pass. Add a `coverage` and `coverage:ci` script to `package.json`. Configure `c8` thresholds in `.c8rc.json` (e.g., 60% lines, 60% branches). Store the `coverage/` directory as a workflow artifact. **Note**: This is a temporary stepping stone — Phase 10 (TASK-045/054) will replace `c8` with Vitest's built-in `@vitest/coverage-v8` provider. At that point, `.c8rc.json` should be deleted and its thresholds moved into `vitest.config.ts`. | | |
| TASK-010 | Add a `concurrency` block to `tests.yml` and `playwright.yml` keyed on `ci-${{ github.ref }}` with `cancel-in-progress: true` to cancel redundant CI runs when new commits are pushed to the same branch. This saves CI minutes. | | |
| TASK-011 | Add a path filter to `playwright.yml` so E2E tests only run when relevant files change (i.e., `js/**`, `css/**`, `index.html`, `sw.js`, `test/e2e/**`, `playwright.config.js`). Use `paths` filter on the `push` and `pull_request` triggers. Add a `paths-ignore` for `docs/**`, `*.md`, `plan/**`. | | |

### Implementation Phase 3 — Workflow Hardening & Security

- GOAL-003: Harden all workflows against supply-chain attacks and improve security posture.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | Pin all third-party actions in every workflow file to their full SHA commit hash instead of floating version tags. Affected actions: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`, `actions/cache@v4`. Add a comment next to each SHA with the tag name for readability (e.g., `# v4.2.2`). | | |
| TASK-013 | Add `permissions: {}` (empty/deny-all) as the top-level default for all workflow files, then explicitly grant only required permissions at the job level. This follows the principle of least privilege. Currently, `deploy-pages.yml` uses top-level permissions — keep that exception but add a comment explaining why. | | |
| TASK-014 | Add a `codeql-analysis.yml` workflow that runs GitHub CodeQL analysis on push to `Main` and on PRs. Configure it for JavaScript and TypeScript analysis. This provides automated SAST scanning beyond npm audit. After Phase 10 (TypeScript migration), CodeQL's TypeScript support will provide even deeper analysis. | | |
| TASK-015 | Update `dependabot.yml` to: (1) add `labels: ["dependencies"]` for npm updates and `labels: ["ci"]` for github-actions updates, (2) add `commit-message: { prefix: "chore" }` for consistent commit messages, (3) add `open-pull-requests-limit: 10` to prevent Dependabot from overwhelming the repo, (4) add `groups` to batch minor/patch updates together. | | |
### Implementation Phase 4 — Automation Script Improvements

- GOAL-004: Enhance automation scripts and pre-commit hooks to catch more issues before they reach CI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | Rename `scripts/pre-commit` to `scripts/pre-commit-version-check.sh` to clarify its purpose (version consistency only). Add a `node --check` syntax validation loop for staged `.js` files as a separate function within the script. This is a preparatory step — Phase 11 (TASK-055/056) will replace the entire manual hook system with `husky` + `lint-staged`. | ✅ | 2026-03-09 |
| TASK-017 | Create `scripts/check-actions.sh` — a local validation script that uses `actionlint` (if installed) to lint all workflow YAML files. Add a corresponding `npm run lint:actions` script to `package.json`. This is optional/advisory (does not block commits) but provides quick feedback. | ✅ | 2026-03-09 |
| TASK-018 | Enhance `scripts/update-docs.sh` to also generate an agent roster table in README.md by scanning `.github/agents/*.agent.md` files and extracting the agent name and description from frontmatter. Add a new `<!-- AUTO-GENERATED-CONTENT:START (AGENT_ROSTER) -->` section to README.md. | ✅ | 2026-03-09 |
| TASK-019 | Add a `scripts/validate-workflows.sh` script that checks all workflow files for: (1) presence of `permissions` block, (2) bot loop guards on auto-commit workflows, (3) concurrency groups on Main-push workflows. Add as `npm run validate:workflows` to `package.json`. | ✅ | 2026-03-09 |

### Implementation Phase 5 — Auto-Merge & PR Automation

- GOAL-005: Add PR automation workflows to reduce manual overhead and improve merge velocity.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Create `.github/workflows/auto-merge-dependabot.yml` workflow that automatically approves and merges Dependabot PRs for minor/patch updates after CI passes. Use `dependabot/fetch-metadata` to determine update type, `gh pr review --approve` to auto-approve, and `gh pr merge --auto --squash` with `github.token` to merge. Trigger on `pull_request` with `if: github.actor == 'dependabot[bot]'`. Only auto-merge if the version bump is minor or patch (gated via metadata `update-type`). | ✅ | 2026-03-09 |
| TASK-021 | Create `.github/workflows/pr-labeler.yml` workflow that automatically adds labels to PRs based on changed file paths. Use `actions/labeler@v5` with a `.github/labeler.yml` config that maps: `js/**` -> `javascript`, `css/**` -> `styles`, `.github/workflows/**` -> `ci`, `test/**` -> `tests`, `docs/**` -> `documentation`, `.github/agents/**` -> `agents`, `plan/**` -> `planning`. | ✅ | 2026-03-09 |
| TASK-022 | Create `.github/labeler.yml` configuration file for the PR labeler workflow (TASK-021). Define path-based label rules for all major directories. | ✅ | 2026-03-09 |
| TASK-023 | Create `.github/workflows/stale.yml` workflow using `actions/stale@v9` to automatically mark issues and PRs as stale after 30 days of inactivity and close them after 7 more days. Exempt issues/PRs with labels `pinned`, `security`, or `enhancement`. Run on a daily `schedule` cron. | ✅ | 2026-03-09 |

### Implementation Phase 6 — Consolidated Merge Pipeline

- GOAL-006: Combine the `auto-bump.yml` and `auto-update-docs.yml` workflows into a single, atomic post-merge pipeline to eliminate the race condition between the two separate workflows that share the `auto-main-push` concurrency group.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-024 | Create `.github/workflows/post-merge.yml` workflow triggered on `push` to `Main`. This single workflow runs two sequential jobs: (1) `bump-version` — runs `bash scripts/bump-version.sh patch`, reads new version, commits and pushes. (2) `update-docs` — depends on `bump-version` via `needs:`, checks out the updated Main, runs `bash scripts/update-docs.sh`, commits and pushes if changed. Both jobs use the same bot identity and bot-loop guards. Use concurrency group `post-merge-main` with `cancel-in-progress: true`. | | |
| TASK-025 | Delete `auto-bump.yml` and `auto-update-docs.yml` after `post-merge.yml` is verified working. Update `.github/copilot-instructions.md` to reference the new consolidated workflow. | | |
| TASK-026 | Update the CI Workflow section of `.github/copilot-instructions.md` to document all new and modified workflows, including the composite actions, security-pr, post-merge, auto-merge-dependabot, pr-labeler, stale, and codeql-analysis workflows. | | |

### Implementation Phase 7 — Agent & MCP Toolset Enhancements

- GOAL-007: Upgrade Copilot agent definitions for better task specialization and add MCP server configuration for enhanced tooling.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-027 | Create `.github/copilot-mcp.json` MCP server configuration file that defines the available MCP toolsets for Copilot agents: (1) `github` MCP server for issue/PR management, workflow inspection, and repository operations, (2) `fetch` MCP server for HTTP requests (API testing, webhook verification). Follow the standard MCP configuration format. | ✅ | 2026-03-09 |
| TASK-028 | Update `gem-devops.agent.md` to include instructions for using the new composite actions (`setup-node-env`, `setup-playwright`) when creating or modifying workflows. Add the workflow validation script (`scripts/validate-workflows.sh`) to the agent's post-change checklist. | ✅ | 2026-03-09 |
| TASK-029 | Update `gem-reviewer.agent.md` to include the CodeQL workflow (`codeql-analysis.yml`) and the PR-triggered security scan (`security-pr.yml`) in its security review checklist. Add instruction to verify that new workflows use pinned action SHAs. | ✅ | 2026-03-09 |
| TASK-030 | Update `Bugfixer.agent.md` to include instructions for running the full CI pipeline locally before submitting fixes: `npm run check-syntax && npm run lint && npm run format:check && npm test`. Add the coverage reporting flag to the test command. | ✅ | 2026-03-09 |
| TASK-031 | Create `.github/agents/ci-optimizer.agent.md` — a new specialized agent for CI/CD pipeline optimization. The agent's role is to: (1) analyze workflow run times and identify bottlenecks, (2) suggest caching improvements, (3) validate workflow security (pinned actions, least-privilege permissions), (4) maintain composite actions. Include the standard `.agent.md` frontmatter with `tools: ["read", "search", "agent"]`. | ✅ | 2026-03-09 |

### Implementation Phase 8 — Monitoring & Observability

- GOAL-008: Add workflow efficiency monitoring and status visibility.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-032 | Add CI status badges to `README.md` for all key workflows: Tests, Playwright E2E, Deploy Pages, Security Audit, and CodeQL. Place them in a new "CI Status" section below the title. Use the standard GitHub Actions badge URL format: `https://github.com/{owner}/{repo}/actions/workflows/{workflow}/badge.svg`. | ✅ | 2026-03-10 |
| TASK-033 | Create `.github/workflows/ci-metrics.yml` workflow that runs weekly (cron) and uses `actions/github-script@v7` to: (1) fetch the last 20 workflow runs for `tests.yml` and `playwright.yml`, (2) calculate average duration, (3) post a summary as a GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`). This provides ongoing visibility into CI efficiency. | ✅ | 2026-03-10 |
| TASK-034 | Add a `timeout-minutes` field to all workflow jobs to prevent stuck jobs from consuming unlimited CI minutes. Recommended values: unit tests = 10 min, Playwright E2E = 15 min, deploy = 10 min, release = 15 min, security = 5 min. | ✅ | 2026-03-10 |

### Implementation Phase 9 — Frontend Build System (Vite + ES Modules)

- GOAL-009: Replace the zero-build-step vanilla JS architecture with a modern Vite-based build pipeline. This enables ES module imports, tree-shaking, minification, hot module replacement (HMR) during development, and lays the groundwork for TypeScript adoption.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-035 | Install Vite as a devDependency: `npm install -D vite`. Create `vite.config.js` at the repository root configured for a vanilla JS SPA: set `root: '.'`, `build.outDir: 'dist'`, `server.port: 8080`, and `publicDir: 'public'`. Move static assets (`icons/`, `manifest.json`, `version.json`, `.nojekyll`) into a new `public/` directory so Vite copies them to `dist/` unchanged. | | |
| TASK-036 | Restructure the project directory for Vite: (1) move `css/app.css` to `src/css/app.css`, (2) move all `js/*.js` and `js/pages/*.js` to `src/js/` and `src/js/pages/`, (3) update `index.html` to replace the 12+ individual `<script>` tags with a single `<script type="module" src="/src/js/app.js"></script>` entry point. Vite will resolve all imports from there. | | |
| TASK-037 | Convert all JS files from IIFE/global patterns to ES module exports/imports. For each file: (1) remove the IIFE wrapper, (2) replace `window.X = ...` or `var X = ...` globals with `export const X = ...` or `export default ...`, (3) add `import` statements at the top of each file for its dependencies. Order of conversion: `utils.js` → `db.js` → `api.js` → each page module → `app.js` (because `app.js` depends on all pages). Update the ESLint config `sourceType` from `'script'` to `'module'` and remove the manual browser/app globals from the globals list (they become imports). | | |
| TASK-038 | Update `sw.js` for the Vite build: (1) Vite generates hashed filenames (e.g., `assets/index-abc123.js`) so the static `STATIC_ASSETS` array must be replaced with a dynamic approach. Use `vite-plugin-pwa` (install as devDependency) to auto-generate the service worker with Workbox precaching. Configure it in `vite.config.js` with `registerType: 'autoUpdate'` and a `globPatterns` list. Remove the hand-written `sw.js` file. (2) **Cache migration strategy**: the existing hand-written SW uses cache names like `comic-creator-v1.6.38`. Workbox uses a different naming scheme. To force cache invalidation during the transition: configure `vite-plugin-pwa` to call `caches.keys().then(keys => keys.filter(k => k.startsWith('comic-creator-')).forEach(k => caches.delete(k)))` in the Workbox `cleanupOutdatedCaches` hook, ensuring old caches are purged on first activation of the new SW. Test this transition explicitly with a browser that has the old SW cached. | | |
| TASK-039 | Update `package.json` scripts for the Vite workflow: (1) add `"dev": "vite"` for local development with HMR, (2) change `"serve"` from `python3 -m http.server 8080` to `vite preview --port 8080` (serves the `dist/` build), (3) add `"build": "vite build"`, (4) update `"check-syntax"` — no longer needed as Vite will fail on import errors; replace with a no-op or remove. (5) Add `dist/` to `.gitignore`. | | |
| TASK-040 | Update `deploy-pages.yml` to build before deploying: add an `npm run build` step after `npm ci`, and change the `Prepare site directory` step to copy `dist/` instead of manually cherry-picking source files into `_site`. The site directory becomes simply `dist/`. | | |
| TASK-041 | Update `playwright.config.js`: change `webServer.command` from `python3 -m http.server 8080 --bind 127.0.0.1` to `npx vite preview --port 8080 --host 127.0.0.1`. Update `baseURL` to `http://127.0.0.1:8080`. Add a `webServer.reuseExistingServer` flag. E2E tests now run against the production build. | | |
| TASK-042 | Update `tests.yml` and `release.yml` workflows to add an `npm run build` step after `npm ci` and before running tests, so that unit tests can import from the built modules if needed. Alternatively, configure Vitest (see Phase 10) as the test runner which handles module resolution natively. | | |
| TASK-043 | Update the version bump script (`scripts/bump-version.sh`): after the Vite migration, the version only needs to live in `version.json` and `package.json` — the service worker CACHE_NAME is managed by Workbox and settings.js APP_VERSION can read from `version.json` at build time. **Version injection mechanism**: use Vite's `define` config in `vite.config.js` to replace a `__APP_VERSION__` global constant at build time by reading `version.json`: `define: { __APP_VERSION__: JSON.stringify(require('./version.json').version) }`. Then in `settings.ts`, use `const APP_VERSION = __APP_VERSION__` (declared in a `vite-env.d.ts` type definition). Simplify the bump script to update only `version.json`, `package.json`, and `index.html` (3 files instead of 5). Update `config-integrity.test.js` accordingly. | | |

### Implementation Phase 10 — TypeScript & Vitest Migration

- GOAL-010: Add TypeScript for type safety across the entire codebase and migrate from the Node.js built-in test runner to Vitest for faster, more feature-rich testing with native ES module and TypeScript support.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-044 | Install TypeScript and Vitest: `npm install -D typescript vitest @vitest/coverage-v8 jsdom`. Create `tsconfig.json` with: `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, **`"strict": false`** (initially), `"allowJs": true`, `"checkJs": false` (initially), `"skipLibCheck": true`, `"outDir": "dist"`, `"rootDir": "src"`, `"include": ["src/**/*"]`. Start with relaxed settings to avoid a flood of type errors on existing JS. Enable `"checkJs": true` after TASK-047 (utils.ts conversion), then enable `"strict": true` only after ALL files have been converted to `.ts` in TASK-050/051. This ensures truly incremental adoption. | | |
| TASK-045 | Create `vitest.config.ts` extending `vite.config.js`: configure `test.globals: true`, `test.environment: 'jsdom'` (for DOM-dependent tests), `test.include: ['test/**/*.test.{js,ts}']`, `test.coverage.provider: 'v8'`, `test.coverage.reporter: ['text', 'lcov']`, `test.coverage.thresholds: { lines: 60, branches: 60 }`. This replaces both `c8` and the Node.js built-in test runner. | | |
| TASK-046 | Migrate all existing test files (`test/*.test.js`) from `node:test` / `node:assert` to Vitest's `describe`/`it`/`expect` API. Replace `require('node:test')` with `import { describe, it, expect } from 'vitest'`. Replace `assert.ok(x)` with `expect(x).toBeTruthy()`, `assert.equal(a, b)` with `expect(a).toBe(b)`, etc. Replace `require('fake-indexeddb')` with `import 'fake-indexeddb/auto'`. Update `package.json` `"test"` script from `node --test test/*.test.js` to `vitest run`. Add `"test:watch": "vitest"` for development. | | |
| TASK-047 | Rename JS files to TypeScript incrementally. Start with utility files that have no DOM dependencies: rename `src/js/utils.js` → `src/js/utils.ts`, add type annotations to all exported functions (`escHtml(str: string): string`, `timeAgo(ts: number): string`, `cosineSimilarity(a: number[], b: number[]): number`, etc.). Define a `Genre` interface: `{ id: string; name: string; emoji: string }` and type the `GENRES` array. Fix any type errors. | | |
| TASK-048 | Convert `src/js/db.js` → `src/js/db.ts`: define TypeScript interfaces for all IndexedDB object shapes (`Character`, `World`, `Comic`, `Page`, `Preset`, `ImagePreset`, `Setting`). Type all `DB` methods. Use `IDBDatabase` type from `lib.dom.d.ts`. This provides compile-time safety for all database operations. | | |
| TASK-049 | Convert `src/js/api.js` → `src/js/api.ts`: define interfaces for API request/response payloads (`ChatMessage`, `ImageGenOptions`, `EmbeddingResponse`, etc.). Type the streaming callback `onChunk: (delta: string, fullText: string) => void`. Type `API.parseComicResponse` return value. This catches prompt-building bugs at compile time. | | |
| TASK-050 | Convert all page modules (`src/js/pages/*.js`) to TypeScript one at a time. Define a `PageModule` interface: `{ render(param?: string): string; postRender?(param?: string): void; onMount?(param?: string): Promise<void>; onUnmount?(): void; }`. Each page module must satisfy this interface. Convert in order: `home.ts`, `settings.ts`, `characters.ts`, `worlds.ts`, `create.ts`, `library.ts`, `presets.ts`, `image-presets.ts`. | | |
| TASK-051 | Convert `src/js/app.js` → `src/js/app.ts`: type the `pages` registry as `Record<string, PageModule>`, type `App.navigate`, `App.showModal`, `App.toast`, `App.logError`. This is the final file to convert since it imports all page modules. | | |
| TASK-052 | Update `eslint.config.js` to use `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`. Install both as devDependencies. Add TypeScript-specific rules: `@typescript-eslint/no-explicit-any: warn`, `@typescript-eslint/no-unused-vars: warn`. Remove the manual browser globals list (no longer needed with ES module imports). Update `package.json` `"lint"` script to lint `src/` instead of `js/`. | | |
| TASK-053 | Add a `npm run typecheck` script to `package.json` that runs `tsc --noEmit`. Add this as a CI step in `tests.yml` between the lint and test steps. This provides a dedicated type-checking gate separate from the Vite build (which strips types without checking them). | | |
| TASK-054 | Update `tests.yml` workflow: replace `npm test` with `vitest run --coverage`. Replace `npm run check-syntax` with `npm run typecheck`. Add a `codecov/codecov-action@v4` step that uploads `coverage/lcov.info`. Remove the separate `c8` coverage step (Vitest handles it natively). | | |

### Implementation Phase 11 — Enhanced Developer Tooling & DX

- GOAL-011: Add modern developer experience tooling: conventional commits, automated changelogs, PR/issue templates, security linting, and Lighthouse CI for PWA performance monitoring.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-055 | Install `husky`, `lint-staged`, `commitlint`, and `@commitlint/config-conventional` as devDependencies. Run `npx husky init` to create `.husky/` directory. Configure `.husky/pre-commit` to run `npx lint-staged`. Configure `.husky/commit-msg` to run `npx --no -- commitlint --edit $1`. Create `commitlint.config.js` with `extends: ['@commitlint/config-conventional']`. This enforces conventional commit messages (feat:, fix:, chore:, etc.) on every commit. | | |
| TASK-056 | Configure `lint-staged` in `package.json` or `.lintstagedrc.json`: `"*.{js,ts}": ["eslint --fix", "prettier --write"]`, `"*.{css,json,md,yml}": ["prettier --write"]`. **Note**: Do NOT include `vitest related --run` in lint-staged — running tests on every commit slows down the pre-commit hook significantly. Instead, add a separate `.husky/pre-push` hook that runs `vitest related --run` against changed files before pushing. This keeps commits fast while still catching test regressions before they reach CI. Replace `scripts/install-hooks.sh` and `scripts/pre-commit` — keep only `scripts/pre-commit-version-check.sh` (renamed) called from `.husky/pre-commit` after lint-staged. Update `package.json` `"prepare"` from `bash scripts/install-hooks.sh` to `husky`. | | |
| TASK-057 | Install `eslint-plugin-security` as a devDependency. Add it to `eslint.config.js` with recommended rules enabled. This provides lint-time detection of common security anti-patterns (eval, non-literal RegExp, etc.) as a complement to CodeQL's deeper analysis. | | |
| TASK-058 | Create `.github/PULL_REQUEST_TEMPLATE.md` with sections: Description, Type of Change (checkboxes: bug fix, feature, refactor, docs, CI), Testing (how was this tested?), Screenshots (if UI change), and Checklist (tests pass, lint passes, types check, no secrets committed). | | |
| TASK-059 | Create `.github/ISSUE_TEMPLATE/bug_report.yml` and `.github/ISSUE_TEMPLATE/feature_request.yml` using GitHub's YAML issue form syntax. Bug report includes: description, reproduction steps, expected behavior, actual behavior, browser/OS, screenshots. Feature request includes: description, motivation, proposed solution, alternatives considered. Add `.github/ISSUE_TEMPLATE/config.yml` with `blank_issues_enabled: false`. | | |
| TASK-060 | Create `.github/workflows/lighthouse-ci.yml` workflow: triggered on PRs that change `src/**`, `index.html`, `public/**`. Installs `@lhci/cli` as a devDependency, runs `npm run build`, then runs `lhci autorun` against the Vite preview server. Configure `.lighthouserc.js` with assertions: `performance >= 0.9`, `accessibility >= 0.9`, `best-practices >= 0.9`, `pwa >= 0.9`. Upload the Lighthouse report as a workflow artifact. Post results as a PR comment via `actions/github-script`. | | |
| TASK-061 | Install `release-please` GitHub Action. Create `.github/workflows/release-please.yml` that runs on push to `Main` and creates/updates a release PR automatically based on conventional commit messages. Configure `release-type: node` so it bumps `package.json` version and generates a `CHANGELOG.md`. This replaces the manual `release.yml` workflow dispatch and the `auto-bump.yml` patch auto-increment. | | |
| TASK-062 | Create `.github/workflows/bundle-size.yml` workflow: triggered on PRs. Runs `npm run build`, captures the output `dist/` size with `du -sh dist/`, and compares against the base branch build size. Posts a PR comment showing the size diff (e.g., "+12 KB / 340 KB total"). Uses `actions/cache` to store the base branch build size. This prevents unintentional bundle bloat. | | |

## 3. Alternatives

- **ALT-001**: Instead of composite actions (Phase 1), we considered using reusable workflows (`workflow_call`). Composite actions were chosen because they can be used as steps within any job, while reusable workflows replace entire jobs and are more rigid. Composite actions also live in the same repository without requiring a separate ref.
- **ALT-002**: Instead of consolidating auto-bump and auto-update-docs into a single workflow (Phase 6), we considered keeping them separate but adding a `workflow_run` trigger so `auto-update-docs` runs after `auto-bump` completes. The single workflow approach was chosen because it eliminates the race condition entirely and reduces complexity.
- **ALT-003**: Instead of CodeQL for SAST (Phase 3), we considered only ESLint security plugins (`eslint-plugin-security`). Both are now included — CodeQL provides deeper semantic analysis and is natively integrated with GitHub's security tab, while `eslint-plugin-security` catches issues at lint time during development.
- **ALT-004**: Instead of `actions/stale` for issue management (Phase 5), we considered GitHub's built-in auto-close features. The `actions/stale` approach was chosen because it provides more granular control over exemptions and timing.
- **ALT-005**: For test coverage (TASK-009/TASK-054), we considered Node.js built-in `--experimental-test-coverage` and standalone `c8`. Vitest with `@vitest/coverage-v8` was chosen because it provides integrated coverage with the test runner, native ES module and TypeScript support, lcov output for Codecov, and configurable thresholds — all in a single tool.
- **ALT-006**: For the build tool (Phase 9), we considered Webpack, Rollup, esbuild, and Parcel. Vite was chosen because: (1) it uses esbuild for dev and Rollup for production giving the best of both, (2) it has first-class TypeScript support with no config, (3) `vite-plugin-pwa` provides turnkey service worker generation, (4) the Vitest test runner shares the same config, and (5) it has the largest community adoption for new projects.
- **ALT-007**: For TypeScript migration (Phase 10), we considered: (a) a big-bang rewrite (too risky), (b) JSDoc type annotations only (limited tooling support), (c) incremental `.js` → `.ts` conversion with `allowJs: true` (chosen). The incremental approach allows one file at a time while keeping the app functional at every commit.
- **ALT-008**: For the test framework (Phase 10), we considered keeping the Node.js built-in test runner, or switching to Jest. Vitest was chosen because it natively understands Vite's module resolution, supports TypeScript without config, provides a Jest-compatible API for easy migration, and shares the Vite config for environment consistency.
- **ALT-009**: For conventional commit enforcement (Phase 11), we considered `semantic-release` vs `release-please`. `release-please` was chosen because it creates visible release PRs that can be reviewed before merging, and it doesn't require npm publish tokens (this is a client-side app, not a published package).
- **ALT-010**: For the frontend framework, we considered React, Svelte, and Vue. Staying with vanilla JS/TS (no framework) was chosen for Phase 9–10 because the app's DOM manipulation patterns are simple enough, and adding a framework would require a complete rewrite of all page modules rather than an incremental migration. A framework migration can be a future phase if the app's complexity grows.

## 4. Dependencies

### GitHub Actions (CI/CD)

- **DEP-001**: `actions/checkout@v4` — Git checkout (already in use, to be SHA-pinned)
- **DEP-002**: `actions/setup-node@v4` — Node.js setup (already in use, to be SHA-pinned)
- **DEP-003**: `actions/cache@v4` — Dependency and browser caching (new addition for Playwright and build cache)
- **DEP-004**: `actions/upload-artifact@v4` — Artifact upload (already in use, to be SHA-pinned)
- **DEP-005**: `actions/github-script@v7` — Scripted GitHub API calls (new addition for metrics and PR comments)
- **DEP-006**: `actions/labeler@v5` — PR auto-labeling (new addition)
- **DEP-007**: `actions/stale@v9` — Stale issue/PR management (new addition)
- **DEP-008**: `github/codeql-action` — CodeQL SAST analysis (new addition)
- **DEP-009**: `actions/configure-pages@v5` — Pages configuration (already in use, to be SHA-pinned)
- **DEP-010**: `actions/upload-pages-artifact@v3` — Pages artifact upload (already in use, to be SHA-pinned)
- **DEP-011**: `actions/deploy-pages@v4` — Pages deployment (already in use, to be SHA-pinned)
- **DEP-012**: `codecov/codecov-action@v4` — Coverage upload to Codecov (new addition)
- **DEP-013**: `google/release-please-action` — Automated release PR management (new addition, replaces manual release workflow)

### npm devDependencies (Build & Tooling)

- **DEP-014**: `vite` — Build tool and dev server (new — replaces `python3 -m http.server`)
- **DEP-015**: `vite-plugin-pwa` — Auto-generates service worker with Workbox (new — replaces hand-written `sw.js`)
- **DEP-016**: `typescript` — TypeScript compiler for type checking (new)
- **DEP-017**: `vitest` — Test runner with native Vite/TS support (new — replaces Node.js built-in test runner)
- **DEP-018**: `@vitest/coverage-v8` — V8-based coverage provider for Vitest (new — replaces `c8`)
- **DEP-019**: `jsdom` — DOM simulation for Vitest tests (new — replaces manual DOM mocking)
- **DEP-020**: `husky` — Modern Git hooks manager (new — replaces `scripts/install-hooks.sh`)
- **DEP-021**: `lint-staged` — Run linters on staged files only (new)
- **DEP-022**: `commitlint` + `@commitlint/config-conventional` — Conventional commit enforcement (new)
- **DEP-023**: `eslint-plugin-security` — Security-focused ESLint rules (new)
- **DEP-024**: `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` — TypeScript ESLint support (new)
- **DEP-025**: `@lhci/cli` — Lighthouse CI for PWA performance regression detection (new)
- **DEP-026**: `workbox-window` — Workbox client library for SW registration (new — used by `vite-plugin-pwa`)

## 5. Files

### New Files

- **FILE-001**: `.github/actions/setup-node-env/action.yml` — Composite action for Node.js environment setup (checkout + setup-node + npm ci)
- **FILE-002**: `.github/actions/setup-playwright/action.yml` — Composite action for Playwright setup (includes browser caching)
- **FILE-003**: `.github/workflows/security-pr.yml` — PR-triggered security scanning workflow
- **FILE-004**: `.github/workflows/codeql-analysis.yml` — CodeQL SAST analysis workflow
- **FILE-005**: `.github/workflows/auto-merge-dependabot.yml` — Auto-merge for Dependabot minor/patch PRs
- **FILE-006**: `.github/workflows/pr-labeler.yml` — Automatic PR labeling workflow
- **FILE-007**: `.github/labeler.yml` — Path-to-label mapping configuration for pr-labeler
- **FILE-008**: `.github/workflows/stale.yml` — Stale issue/PR management workflow
- **FILE-009**: `.github/workflows/post-merge.yml` — Consolidated post-merge pipeline (replaces auto-bump + auto-update-docs)
- **FILE-010**: `.github/workflows/ci-metrics.yml` — Weekly CI metrics reporting workflow
- **FILE-011**: `scripts/check-actions.sh` — Local workflow YAML linting script
- **FILE-012**: `scripts/validate-workflows.sh` — Workflow security/convention validation script
- **FILE-013**: `.github/agents/ci-optimizer.agent.md` — CI/CD optimization specialist agent
- **FILE-014**: `.github/copilot-mcp.json` — MCP server configuration for Copilot agents
- **FILE-015**: `vite.config.js` (or `vite.config.ts`) — Vite build configuration with PWA plugin
- **FILE-016**: `tsconfig.json` — TypeScript compiler configuration
- **FILE-017**: `vitest.config.ts` — Vitest test runner configuration (extends Vite config)
- **FILE-018**: `.c8rc.json` — Coverage thresholds (may be superseded by Vitest config in Phase 10)
- **FILE-019**: `public/` directory — Static assets moved here for Vite (`icons/`, `manifest.json`, `version.json`, `.nojekyll`)
- **FILE-020**: `src/js/` directory — All JS/TS source files moved here from `js/`
- **FILE-021**: `src/css/` directory — Stylesheets moved here from `css/`
- **FILE-022**: `commitlint.config.js` — Conventional commit configuration
- **FILE-023**: `.lintstagedrc.json` — lint-staged file-to-command mapping
- **FILE-024**: `.husky/pre-commit` — Husky pre-commit hook (runs lint-staged + version check)
- **FILE-025**: `.husky/commit-msg` — Husky commit-msg hook (runs commitlint)
- **FILE-026**: `.github/PULL_REQUEST_TEMPLATE.md` — PR template with description, type, testing, checklist
- **FILE-027**: `.github/ISSUE_TEMPLATE/bug_report.yml` — Bug report issue form
- **FILE-028**: `.github/ISSUE_TEMPLATE/feature_request.yml` — Feature request issue form
- **FILE-029**: `.github/ISSUE_TEMPLATE/config.yml` — Issue template chooser config
- **FILE-030**: `.github/workflows/lighthouse-ci.yml` — Lighthouse CI PWA performance workflow
- **FILE-031**: `.lighthouserc.js` — Lighthouse CI configuration (performance/a11y/PWA thresholds)
- **FILE-032**: `.github/workflows/release-please.yml` — Automated release PR workflow (replaces manual release.yml)
- **FILE-033**: `.github/workflows/bundle-size.yml` — Bundle size tracking workflow
- **FILE-034**: `CHANGELOG.md` — Auto-generated changelog (managed by release-please)

### Modified Files

- **FILE-035**: `.github/workflows/tests.yml` — Add format-check, typecheck, Vitest coverage, concurrency, timeout, use composite action, pin action SHAs
- **FILE-036**: `.github/workflows/playwright.yml` — Add path filters, concurrency, timeout, use composite action, pin action SHAs, use Vite preview server
- **FILE-037**: `.github/workflows/release.yml` — Replaced by `release-please.yml` (may be kept as manual fallback with `setup-node-env` composite action)
- **FILE-038**: `.github/workflows/security.yml` — Use composite action, pin action SHAs, add timeout
- **FILE-039**: `.github/workflows/deploy-pages.yml` — Pin action SHAs, add timeout, add `npm run build`, deploy from `dist/`
- **FILE-040**: `.github/dependabot.yml` — Add labels, commit message prefix, PR limits, groups
- **FILE-041**: `scripts/pre-commit` → `scripts/pre-commit-version-check.sh` — Renamed; version check only (lint-staged handles the rest)
- **FILE-042**: `scripts/update-docs.sh` — Add agent roster table generation
- **FILE-043**: `package.json` — Major update: add all new devDependencies, new scripts (`dev`, `build`, `typecheck`, `test:watch`, `lint:actions`, `validate:workflows`), update `prepare` to `husky`, add `lint-staged` config
- **FILE-044**: `README.md` — Add CI status badges section, add agent roster auto-generated section markers
- **FILE-045**: `.github/copilot-instructions.md` — Major update: document Vite build system, TypeScript, new workflows, new project structure
- **FILE-046**: `eslint.config.js` — Switch to TypeScript parser, add security plugin, remove manual globals list, update `sourceType` to `module`
- **FILE-047**: `index.html` — Replace 12+ `<script>` tags with single `<script type="module" src="/src/js/app.js"></script>` entry point
- **FILE-048**: `playwright.config.js` — Update to use Vite preview server
- **FILE-049**: `scripts/bump-version.sh` — Simplify to update only 3 files (version.json, package.json, index.html) after Vite migration
- **FILE-050**: `test/config-integrity.test.js` — Update version sync assertions for simplified version locations
- **FILE-051**: `.gitignore` — Add `dist/`, `.husky/_/`, `coverage/`, `*.tsbuildinfo`

### Moved Files (Phase 9 restructure)

- **FILE-052**: `js/utils.js` → `src/js/utils.ts` (converted to ES module + TypeScript)
- **FILE-053**: `js/db.js` → `src/js/db.ts` (converted to ES module + TypeScript)
- **FILE-054**: `js/api.js` → `src/js/api.ts` (converted to ES module + TypeScript)
- **FILE-055**: `js/app.js` → `src/js/app.ts` (converted to ES module + TypeScript)
- **FILE-056**: `js/pages/*.js` → `src/js/pages/*.ts` (8 page modules, converted)
- **FILE-057**: `css/app.css` → `src/css/app.css` (moved, imported by `app.ts`)
- **FILE-058**: `icons/`, `manifest.json`, `version.json` → `public/` (static assets for Vite)

### Deleted Files

- **FILE-059**: `.github/workflows/auto-bump.yml` — Replaced by `post-merge.yml` (Phase 6) and later by `release-please.yml` (Phase 11)
- **FILE-060**: `.github/workflows/auto-update-docs.yml` — Replaced by `post-merge.yml` (Phase 6)
- **FILE-061**: `sw.js` — Replaced by auto-generated service worker from `vite-plugin-pwa` (Phase 9)
- **FILE-062**: `scripts/install-hooks.sh` — Replaced by `husky` (Phase 11)
- **FILE-063**: `scripts/pre-commit` — Renamed to `scripts/pre-commit-version-check.sh` and called from `.husky/pre-commit`

## 6. Testing

### CI/CD Pipeline Tests (Phases 1–8)

- **TEST-001**: After TASK-003, run `npm run check-syntax && npm run lint && npm test` to verify tests.yml refactoring did not break the CI steps
- **TEST-002**: After TASK-004, trigger a Playwright workflow run and verify browser caching works (check cache hit/miss in logs)
- **TEST-003**: After TASK-007, run `npm run format:check` locally to verify it catches formatting issues
- **TEST-004**: After TASK-009, run `npx c8 --reporter=text node --test test/*.test.js` locally and verify coverage output is generated (pre-Vitest migration)
- **TEST-005**: After TASK-010, push two rapid commits to the same branch and verify the first CI run is cancelled
- **TEST-006**: After TASK-012, verify all workflows still pass after SHA pinning (no typos in SHA hashes)
- **TEST-007**: After TASK-015, verify Dependabot PRs have the expected labels after the next weekly run
- **TEST-008**: After TASK-016, verify `npx lint-staged` runs syntax check, ESLint fix, and Prettier write on staged `.js` files
- **TEST-009**: After TASK-019, run `npm run validate:workflows` and verify it reports on all workflow files
- **TEST-010**: After TASK-024/TASK-025, push a commit to Main and verify the consolidated post-merge workflow runs bump + docs-update sequentially
- **TEST-011**: After TASK-032, verify README badges render correctly on GitHub
- **TEST-012**: After TASK-034, verify all jobs have `timeout-minutes` set by running `grep -L timeout-minutes .github/workflows/*.yml` — should return no results

### Vite Migration Tests (Phase 9)

- **TEST-013**: After TASK-035, run `npx vite` and verify the dev server starts on port 8080 with HMR working
- **TEST-014**: After TASK-036, run `npx vite build` and verify `dist/` is created with `index.html`, hashed JS/CSS assets, and all public files
- **TEST-015**: After TASK-037 (ES module conversion), verify: (1) `npx vite build` completes with no errors, (2) `npx vite preview` serves the app correctly, (3) all page navigation works in the browser
- **TEST-016**: After TASK-038 (PWA plugin), verify: (1) `dist/sw.js` is auto-generated by Workbox, (2) the app registers the service worker, (3) offline mode still works after caching
- **TEST-017**: After TASK-039, run `npm run dev` and verify HMR updates CSS/JS changes instantly without full reload
- **TEST-018**: After TASK-040, trigger `deploy-pages.yml` manually and verify the site deploys from `dist/` correctly
- **TEST-019**: After TASK-041, run `npm run test:e2e` and verify Playwright tests pass against the Vite preview server
- **TEST-020**: After TASK-043, run the simplified `scripts/bump-version.sh patch` and verify it updates only 3 files and the version is picked up at build time

### TypeScript & Vitest Tests (Phase 10)

- **TEST-021**: After TASK-044, run `npx tsc --noEmit` and verify it type-checks the `allowJs` JavaScript files with zero errors
- **TEST-022**: After TASK-045, run `npx vitest run` and verify it finds and runs all test files
- **TEST-023**: After TASK-046 (test migration), run `npx vitest run --coverage` and verify all 147+ tests still pass with coverage output generated
- **TEST-024**: After TASK-047 (utils.ts), run `npx tsc --noEmit` and `npx vitest run test/utils.test.ts test/pure-functions.test.ts` — both must pass
- **TEST-025**: After TASK-048 (db.ts), run `npx vitest run test/db.test.ts` — all DB tests must pass with typed interfaces
- **TEST-026**: After TASK-049 (api.ts), run `npx vitest run test/api-*.test.ts` — all API tests must pass
- **TEST-027**: After TASK-050–051 (all pages + app.ts), run full `npx vitest run` and `npx tsc --noEmit` — zero errors, all tests pass
- **TEST-028**: After TASK-053, verify `npm run typecheck` exits 0 in CI

### Developer Tooling Tests (Phase 11)

- **TEST-029**: After TASK-055, attempt a commit with message "bad message" and verify commitlint rejects it. Then commit with "feat: add feature" and verify it passes
- **TEST-030**: After TASK-056, stage a `.ts` file with a lint error, run `git commit`, and verify lint-staged auto-fixes it
- **TEST-031**: After TASK-057, run `npx eslint src/` and verify `eslint-plugin-security` rules are active (e.g., `security/detect-eval-with-expression`)
- **TEST-032**: After TASK-060, run `npx lhci autorun` locally and verify Lighthouse scores are above configured thresholds
- **TEST-033**: After TASK-062, make a PR that adds a large file to `src/`, and verify the bundle-size workflow reports the increase

### Cross-Cutting Validation

- **TEST-034**: Run `config-integrity.test.js` (or its Vitest equivalent) after all phases to verify version sync is still enforced
- **TEST-035**: Run the full CI pipeline (`npm run typecheck && npm run lint && npm run format:check && vitest run --coverage`) after all phases to verify no regressions
- **TEST-036**: Verify the app works end-to-end: navigate to every page, create a character, create a world, start a comic generation (API key required for full test)

## 7. Risks & Assumptions

### Risks

- **RISK-001**: SHA-pinning actions (TASK-012) creates a maintenance burden — new action versions require manual SHA updates. Mitigated by Dependabot's `github-actions` ecosystem monitoring which will auto-create PRs for action updates.
- **RISK-002**: Consolidating auto-bump + auto-update-docs (Phase 6) into a single workflow changes the concurrency behavior. If the single workflow fails mid-way, only the bump (or only the docs update) may have been committed. Mitigated by making the docs-update job depend on bump-version via `needs:` and using atomic commit+push in each job.
- **RISK-003**: CodeQL analysis (TASK-014) may produce false positives on `innerHTML` usage in page modules. Mitigated by the existing `escHtml()` sanitization pattern and by tuning CodeQL's alert severity thresholds. After TypeScript migration, stricter typing reduces this risk further.
- **RISK-004**: Auto-merge Dependabot (TASK-020) could merge a dependency with a subtle regression that passes tests. Mitigated by only auto-merging minor/patch updates and requiring all CI checks to pass first.
- **RISK-005**: Path filters on Playwright (TASK-011) could cause E2E tests to be skipped when a workflow file change affects test behavior. Mitigated by including `playwright.config.js` and `.github/workflows/playwright.yml` in the path filter.
- **RISK-006**: The Vite migration (Phase 9) is the highest-risk phase — converting from browser globals to ES modules touches every source file. A single missed import or export will break the app. Mitigated by: (1) TASK-036 and TASK-037 should be executed as a single atomic step on a feature branch with all file conversions done together, then verified with a full E2E test pass before merging, (2) running `vite build` after every individual file conversion to catch import/export errors immediately, (3) the old `<script>` approach CANNOT coexist with the module entry point — this is a one-shot conversion that must be completed in full before committing. Use a dedicated PR for this phase with thorough review.
- **RISK-007**: TypeScript migration (Phase 10) may initially produce many type errors from the existing loosely-typed codebase. Mitigated by starting with `strict: false` or per-file `// @ts-check` annotations, then progressively enabling stricter checks.
- **RISK-008**: The `vite-plugin-pwa` service worker may behave differently from the hand-written `sw.js`, potentially breaking offline caching for existing users. Mitigated by: (1) thorough testing of offline mode, (2) using `registerType: 'autoUpdate'` which prompts users to refresh, (3) keeping the Workbox precache list aligned with the previous `STATIC_ASSETS` list.
- **RISK-009**: Adding 13+ new devDependencies significantly increases the `node_modules` install time. Mitigated by `npm ci` caching in CI (composite action) and the `setup-node` cache feature.
- **RISK-010**: Replacing `release.yml` manual workflow with `release-please` changes the release process. Existing contributors may be surprised. Mitigated by documenting the new flow in `CONTRIBUTING.md` and `.github/copilot-instructions.md`.

### Assumptions

- **ASSUMPTION-001**: The repository owner has GitHub Actions enabled with sufficient minutes for the additional workflows (estimated +30% CI minutes from new workflows + build step).
- **ASSUMPTION-002**: GitHub CodeQL is available for the repository (free for public repos, requires GitHub Advanced Security for private repos).
- **ASSUMPTION-003**: The `actions/labeler@v5`, `actions/stale@v9`, `github/codeql-action`, `codecov/codecov-action@v4`, and `google/release-please-action` are stable and available at their current versions at the time of implementation.
- **ASSUMPTION-004**: The existing IndexedDB schema and data stored by users in their browsers will not be affected by the Vite migration — the built JavaScript will produce the same runtime behavior. Data URLs stored as character/world images remain valid.
- **ASSUMPTION-005**: The existing gem-team agent framework (from mubaidr/gem-team) supports the modifications described in Phase 7 without breaking orchestrator delegation.
- **ASSUMPTION-006**: Vite's dev server and preview server can serve the PWA correctly including `manifest.json` and service worker registration with the correct scope.
- **ASSUMPTION-007**: All existing 147 unit tests and E2E tests can be migrated to Vitest without behavioral changes — the Vitest API is Jest-compatible and the `describe`/`it`/`expect` pattern maps directly from `node:test`/`node:assert`.

## 8. Related Specifications / Further Reading

- [GitHub Actions Composite Actions documentation](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action)
- [GitHub Actions Security Hardening guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GitHub CodeQL documentation](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql)
- [Dependabot configuration options](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file)
- [MCP (Model Context Protocol) specification](https://modelcontextprotocol.io/)
- [gem-team multi-agent framework](https://github.com/mubaidr/gem-team)
- [Vite documentation](https://vite.dev/guide/)
- [vite-plugin-pwa documentation](https://vite-pwa-org.netlify.app/)
- [TypeScript Handbook — Migrating from JavaScript](https://www.typescriptlang.org/docs/handbook/migrating-from-javascript.html)
- [Vitest documentation](https://vitest.dev/guide/)
- [Husky documentation](https://typicode.github.io/husky/)
- [lint-staged documentation](https://github.com/lint-staged/lint-staged)
- [commitlint documentation](https://commitlint.js.org/)
- [release-please documentation](https://github.com/googleapis/release-please)
- [Lighthouse CI documentation](https://github.com/GoogleChrome/lighthouse-ci)
- [Codecov GitHub Action](https://github.com/codecov/codecov-action)
- Current repository: [dkylepeppers-alt/Comiccreator](https://github.com/dkylepeppers-alt/Comiccreator)
