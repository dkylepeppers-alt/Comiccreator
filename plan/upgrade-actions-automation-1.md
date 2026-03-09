---
goal: Major upgrade of repository MCP toolsets, GitHub Actions, automation, and CI/CD efficiency
version: 1.0
date_created: 2026-03-09
last_updated: 2026-03-09
owner: dkylepeppers-alt
status: 'Planned'
tags: [upgrade, automation, ci-cd, actions, mcp, efficiency, infrastructure]
---

# Introduction


Comprehensive upgrade plan for the AI Comic Creator repository's GitHub Actions workflows, MCP toolsets, automation scripts, and overall CI/CD efficiency. The current pipeline consists of 7 workflows, 8+ Copilot agents, 3 automation scripts, and a Dependabot configuration. This plan identifies gaps, inefficiencies, and missing capabilities, then prescribes concrete, phased improvements that can be executed by AI agents or humans.

### Current State Summary

| Area | Count | Key Observations |
|------|-------|------------------|
| Workflows | 7 | tests.yml, playwright.yml, auto-bump.yml, auto-update-docs.yml, deploy-pages.yml, release.yml, security.yml |
| Agents | 11 | 8 gem-team agents + Bugfixer, Docs-agent, Readme, my-agent, Anotherplanner, architect-innovator |
| Scripts | 4 | bump-version.sh, update-docs.sh, install-hooks.sh, pre-commit |
| Dependabot | 2 ecosystems | npm (weekly), github-actions (weekly) -- no labels, no PR limits, no commit message prefix |
| Pre-commit hook | 1 check | Version consistency only -- no syntax, lint, or format checks |
| Test runners | 2 | Node built-in test runner (unit) + Playwright (E2E) -- no coverage reporting |
## 1. Requirements & Constraints

- **REQ-001**: All changes must preserve backward compatibility with the existing vanilla JS architecture (no bundler, no module system)
- **REQ-002**: All 5 version files must remain in sync — any workflow change must not break the version consistency test (`config-integrity.test.js`)
- **REQ-003**: New workflows must use job-level permissions (least-privilege) following existing convention
- **REQ-004**: Bot loop guards must be maintained — all auto-commit workflows must skip `github-actions[bot]` and `copilot[bot]` actors
- **REQ-005**: The `auto-main-push` concurrency group must be preserved for `auto-bump.yml` and `auto-update-docs.yml` until Phase 6 replaces them
- **REQ-006**: Playwright E2E tests must continue to use `python3 -m http.server 8080` as the local server
- **REQ-007**: New workflows should not duplicate existing functionality — reuse composite actions where possible
- **SEC-001**: No secrets or tokens may be hardcoded — all credentials must use GitHub Actions secrets or `github.token`
- **SEC-002**: Security scanning must cover both npm dependencies and code quality (not just weekly — also on PRs)
- **SEC-003**: Third-party actions must be pinned to specific SHA commits, not floating tags, to prevent supply-chain attacks
- **CON-001**: The repository is a pure client-side PWA with no backend — CI does not need server/database provisioning
- **CON-002**: Node.js 22 is the target runtime (per existing workflows)
- **CON-003**: No new npm dependencies should be added to `dependencies` (only `devDependencies` for tooling)
- **CON-004**: Agent definition files in `.github/agents/` follow the `.agent.md` naming convention with YAML frontmatter
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
| TASK-001 | Create `.github/actions/setup-node-env/action.yml` composite action that performs: (1) `actions/checkout@v4`, (2) `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, (3) `npm ci`. This replaces the 3-step boilerplate in `tests.yml`, `playwright.yml`, `release.yml`, `security.yml`, and any new workflows. | | |
| TASK-002 | Create `.github/actions/setup-playwright/action.yml` composite action that performs: (1) calls `setup-node-env`, (2) caches Playwright browsers using `actions/cache@v4` with key `playwright-${{ hashFiles('package-lock.json') }}` and path `~/.cache/ms-playwright`, (3) runs `npx playwright install --with-deps chromium` only on cache miss. | | |
| TASK-003 | Refactor `tests.yml` to use `setup-node-env` composite action, removing the duplicated checkout/setup-node/npm-ci steps. Verify all 4 steps (checkout, setup, install, syntax-check, lint, test) still pass. | | |
| TASK-004 | Refactor `playwright.yml` to use `setup-playwright` composite action. Verify Playwright browser caching works (second run should skip browser download). | | |
| TASK-005 | Refactor `release.yml` to use `setup-node-env` composite action. Verify the full release flow still works (tests -> bump -> commit -> tag -> release). | | |
| TASK-006 | Refactor `security.yml` to use `setup-node-env` composite action. | | |

### Implementation Phase 2 — Enhanced CI Pipeline (Quality Gates)

- GOAL-002: Add missing quality gates to the CI pipeline: Prettier formatting enforcement, test coverage reporting, and PR-triggered security scanning.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Add a `format-check` step to `tests.yml` that runs `npm run format:check` after the lint step. This enforces Prettier formatting on every push and PR. Currently, `format:check` exists as a script but is not run in CI. | | |
| TASK-008 | Create `.github/workflows/security-pr.yml` workflow triggered on `pull_request` events that runs `npm audit --audit-level=high`. This supplements the weekly `security.yml` cron with PR-time checks so vulnerabilities are caught before merge. Use the `setup-node-env` composite action. | | |
| TASK-009 | Add Node.js `--experimental-test-coverage` flag to the test command in `tests.yml` to generate a coverage summary. Create a step that parses the coverage output and posts it as a PR comment using `actions/github-script@v7`. Store the coverage data as a workflow artifact. | | |
| TASK-010 | Add a `concurrency` block to `tests.yml` and `playwright.yml` keyed on `ci-${{ github.ref }}` with `cancel-in-progress: true` to cancel redundant CI runs when new commits are pushed to the same branch. This saves CI minutes. | | |
| TASK-011 | Add a path filter to `playwright.yml` so E2E tests only run when relevant files change (i.e., `js/**`, `css/**`, `index.html`, `sw.js`, `test/e2e/**`, `playwright.config.js`). Use `paths` filter on the `push` and `pull_request` triggers. Add a `paths-ignore` for `docs/**`, `*.md`, `plan/**`. | | |

### Implementation Phase 3 — Workflow Hardening & Security

- GOAL-003: Harden all workflows against supply-chain attacks and improve security posture.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | Pin all third-party actions in every workflow file to their full SHA commit hash instead of floating version tags. Affected actions: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`, `actions/cache@v4`. Add a comment next to each SHA with the tag name for readability (e.g., `# v4.2.2`). | | |
| TASK-013 | Add `permissions: {}` (empty/deny-all) as the top-level default for all workflow files, then explicitly grant only required permissions at the job level. This follows the principle of least privilege. Currently, `deploy-pages.yml` uses top-level permissions — keep that exception but add a comment explaining why. | | |
| TASK-014 | Add a `codeql-analysis.yml` workflow that runs GitHub CodeQL analysis on push to `Main` and on PRs. Configure it for JavaScript analysis. This provides automated SAST scanning beyond npm audit. | | |
| TASK-015 | Update `dependabot.yml` to: (1) add `labels: ["dependencies"]` for npm updates and `labels: ["ci"]` for github-actions updates, (2) add `commit-message: { prefix: "chore" }` for consistent commit messages, (3) add `open-pull-requests-limit: 10` to prevent Dependabot from overwhelming the repo, (4) add `groups` to batch minor/patch updates together. | | |
### Implementation Phase 4 — Automation Script Improvements

- GOAL-004: Enhance automation scripts and pre-commit hooks to catch more issues before they reach CI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | Enhance the `scripts/pre-commit` hook to add an optional syntax check step: run `node --check` on all staged `.js` files. Gate this behind a quick check (only run if JS files are staged). Keep the version consistency check as the primary gate. | | |
| TASK-017 | Create `scripts/check-actions.sh` — a local validation script that uses `actionlint` (if installed) to lint all workflow YAML files. Add a corresponding `npm run lint:actions` script to `package.json`. This is optional/advisory (does not block commits) but provides quick feedback. | | |
| TASK-018 | Enhance `scripts/update-docs.sh` to also generate an agent roster table in README.md by scanning `.github/agents/*.agent.md` files and extracting the agent name and description from frontmatter. Add a new `<!-- AUTO-GENERATED-CONTENT:START (AGENT_ROSTER) -->` section to README.md. | | |
| TASK-019 | Add a `scripts/validate-workflows.sh` script that checks all workflow files for: (1) presence of `permissions` block, (2) bot loop guards on auto-commit workflows, (3) concurrency groups on Main-push workflows. Add as `npm run validate:workflows` to `package.json`. | | |

### Implementation Phase 5 — Auto-Merge & PR Automation

- GOAL-005: Add PR automation workflows to reduce manual overhead and improve merge velocity.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Create `.github/workflows/auto-merge-dependabot.yml` workflow that automatically approves and merges Dependabot PRs for minor/patch updates after CI passes. Use `gh pr merge --auto --squash` with `github.token`. Trigger on `pull_request` with `if: github.actor == 'dependabot[bot]'`. Only auto-merge if the version bump is minor or patch (check PR title). | | |
| TASK-021 | Create `.github/workflows/pr-labeler.yml` workflow that automatically adds labels to PRs based on changed file paths. Use `actions/labeler@v5` with a `.github/labeler.yml` config that maps: `js/**` -> `javascript`, `css/**` -> `styles`, `.github/workflows/**` -> `ci`, `test/**` -> `tests`, `docs/**` -> `documentation`, `.github/agents/**` -> `agents`, `plan/**` -> `planning`. | | |
| TASK-022 | Create `.github/labeler.yml` configuration file for the PR labeler workflow (TASK-021). Define path-based label rules for all major directories. | | |
| TASK-023 | Create `.github/workflows/stale.yml` workflow using `actions/stale@v9` to automatically mark issues and PRs as stale after 30 days of inactivity and close them after 7 more days. Exempt issues/PRs with labels `pinned`, `security`, or `enhancement`. Run on a daily `schedule` cron. | | |

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
| TASK-027 | Create `.github/copilot-mcp.json` MCP server configuration file that defines the available MCP toolsets for Copilot agents: (1) `github` MCP server for issue/PR management, workflow inspection, and repository operations, (2) `fetch` MCP server for HTTP requests (API testing, webhook verification). Follow the standard MCP configuration format. | | |
| TASK-028 | Update `gem-devops.agent.md` to include instructions for using the new composite actions (`setup-node-env`, `setup-playwright`) when creating or modifying workflows. Add the workflow validation script (`scripts/validate-workflows.sh`) to the agent's post-change checklist. | | |
| TASK-029 | Update `gem-reviewer.agent.md` to include the CodeQL workflow (`codeql-analysis.yml`) and the PR-triggered security scan (`security-pr.yml`) in its security review checklist. Add instruction to verify that new workflows use pinned action SHAs. | | |
| TASK-030 | Update `Bugfixer.agent.md` to include instructions for running the full CI pipeline locally before submitting fixes: `npm run check-syntax && npm run lint && npm run format:check && npm test`. Add the coverage reporting flag to the test command. | | |
| TASK-031 | Create `.github/agents/ci-optimizer.agent.md` — a new specialized agent for CI/CD pipeline optimization. The agent's role is to: (1) analyze workflow run times and identify bottlenecks, (2) suggest caching improvements, (3) validate workflow security (pinned actions, least-privilege permissions), (4) maintain composite actions. Include the standard `.agent.md` frontmatter with `tools: ["read", "search", "agent"]`. | | |

### Implementation Phase 8 — Monitoring & Observability

- GOAL-008: Add workflow efficiency monitoring and status visibility.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-032 | Add CI status badges to `README.md` for all key workflows: Tests, Playwright E2E, Deploy Pages, Security Audit, and CodeQL. Place them in a new "CI Status" section below the title. Use the standard GitHub Actions badge URL format: `https://github.com/{owner}/{repo}/actions/workflows/{workflow}/badge.svg`. | | |
| TASK-033 | Create `.github/workflows/ci-metrics.yml` workflow that runs weekly (cron) and uses `actions/github-script@v7` to: (1) fetch the last 20 workflow runs for `tests.yml` and `playwright.yml`, (2) calculate average duration, (3) post a summary as a GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`). This provides ongoing visibility into CI efficiency. | | |
| TASK-034 | Add a `timeout-minutes` field to all workflow jobs to prevent stuck jobs from consuming unlimited CI minutes. Recommended values: unit tests = 10 min, Playwright E2E = 15 min, deploy = 10 min, release = 15 min, security = 5 min. | | |
## 3. Alternatives

- **ALT-001**: Instead of composite actions (Phase 1), we considered using reusable workflows (`workflow_call`). Composite actions were chosen because they can be used as steps within any job, while reusable workflows replace entire jobs and are more rigid. Composite actions also live in the same repository without requiring a separate ref.
- **ALT-002**: Instead of consolidating auto-bump and auto-update-docs into a single workflow (Phase 6), we considered keeping them separate but adding a `workflow_run` trigger so `auto-update-docs` runs after `auto-bump` completes. The single workflow approach was chosen because it eliminates the race condition entirely and reduces complexity.
- **ALT-003**: Instead of CodeQL for SAST (Phase 3), we considered ESLint security plugins like `eslint-plugin-security`. CodeQL was chosen because it provides deeper semantic analysis and is natively integrated with GitHub's security tab.
- **ALT-004**: Instead of `actions/stale` for issue management (Phase 5), we considered GitHub's built-in auto-close features. The `actions/stale` approach was chosen because it provides more granular control over exemptions and timing.
- **ALT-005**: For test coverage (TASK-009), we considered adding `c8` or `istanbul` as devDependencies. Node.js built-in `--experimental-test-coverage` was chosen to avoid adding new dependencies, consistent with the project's minimalist approach.

## 4. Dependencies

- **DEP-001**: `actions/checkout@v4` — Git checkout (already in use, to be SHA-pinned)
- **DEP-002**: `actions/setup-node@v4` — Node.js setup (already in use, to be SHA-pinned)
- **DEP-003**: `actions/cache@v4` — Dependency and browser caching (new addition for Playwright)
- **DEP-004**: `actions/upload-artifact@v4` — Artifact upload (already in use, to be SHA-pinned)
- **DEP-005**: `actions/github-script@v7` — Scripted GitHub API calls (new addition for coverage comments and metrics)
- **DEP-006**: `actions/labeler@v5` — PR auto-labeling (new addition)
- **DEP-007**: `actions/stale@v9` — Stale issue/PR management (new addition)
- **DEP-008**: `github/codeql-action` — CodeQL SAST analysis (new addition)
- **DEP-009**: `actions/configure-pages@v5` — Pages configuration (already in use, to be SHA-pinned)
- **DEP-010**: `actions/upload-pages-artifact@v3` — Pages artifact upload (already in use, to be SHA-pinned)
- **DEP-011**: `actions/deploy-pages@v4` — Pages deployment (already in use, to be SHA-pinned)
- **DEP-012**: No new npm runtime dependencies — all additions are GitHub Actions or devDependencies

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

### Modified Files

- **FILE-015**: `.github/workflows/tests.yml` — Add format-check step, concurrency, timeout, use composite action, pin action SHAs
- **FILE-016**: `.github/workflows/playwright.yml` — Add path filters, concurrency, timeout, use composite action, pin action SHAs
- **FILE-017**: `.github/workflows/release.yml` — Use composite action, pin action SHAs, add timeout
- **FILE-018**: `.github/workflows/security.yml` — Use composite action, pin action SHAs, add timeout
- **FILE-019**: `.github/workflows/deploy-pages.yml` — Pin action SHAs, add timeout
- **FILE-020**: `.github/dependabot.yml` — Add labels, commit message prefix, PR limits, groups
- **FILE-021**: `scripts/pre-commit` — Add optional syntax check for staged JS files
- **FILE-022**: `scripts/update-docs.sh` — Add agent roster table generation
- **FILE-023**: `package.json` — Add `lint:actions` and `validate:workflows` scripts
- **FILE-024**: `README.md` — Add CI status badges section, add agent roster auto-generated section markers
- **FILE-025**: `.github/copilot-instructions.md` — Update CI Workflow documentation for new/changed workflows

### Deleted Files

- **FILE-026**: `.github/workflows/auto-bump.yml` — Replaced by `post-merge.yml` (Phase 6, TASK-025)
- **FILE-027**: `.github/workflows/auto-update-docs.yml` — Replaced by `post-merge.yml` (Phase 6, TASK-025)

## 6. Testing

- **TEST-001**: After TASK-003, run `npm run check-syntax && npm run lint && npm test` to verify tests.yml refactoring did not break the CI steps
- **TEST-002**: After TASK-004, trigger a Playwright workflow run and verify browser caching works (check cache hit/miss in logs)
- **TEST-003**: After TASK-007, run `npm run format:check` locally to verify it catches formatting issues
- **TEST-004**: After TASK-009, run `node --test --experimental-test-coverage test/*.test.js` locally and verify coverage output is generated
- **TEST-005**: After TASK-010, push two rapid commits to the same branch and verify the first CI run is cancelled
- **TEST-006**: After TASK-012, verify all workflows still pass after SHA pinning (no typos in SHA hashes)
- **TEST-007**: After TASK-015, verify Dependabot PRs have the expected labels after the next weekly run
- **TEST-008**: After TASK-016, verify pre-commit hook runs syntax check on staged `.js` files: create a file with invalid syntax, stage it, and verify commit is rejected
- **TEST-009**: After TASK-019, run `npm run validate:workflows` and verify it reports on all workflow files
- **TEST-010**: After TASK-024/TASK-025, push a commit to Main and verify the consolidated post-merge workflow runs bump + docs-update sequentially in a single workflow run
- **TEST-011**: After TASK-032, verify README badges render correctly on GitHub
- **TEST-012**: After TASK-034, verify all jobs have `timeout-minutes` set by running `grep -L timeout-minutes .github/workflows/*.yml` — should return no results
- **TEST-013**: Run the existing `config-integrity.test.js` after all phases to verify version sync is still enforced
- **TEST-014**: Run the full CI pipeline (`npm run check-syntax && npm run lint && npm run format:check && npm test`) after all phases to verify no regressions

## 7. Risks & Assumptions

- **RISK-001**: SHA-pinning actions (TASK-012) creates a maintenance burden — new action versions require manual SHA updates. Mitigated by Dependabot's `github-actions` ecosystem monitoring which will auto-create PRs for action updates.
- **RISK-002**: Consolidating auto-bump + auto-update-docs (Phase 6) into a single workflow changes the concurrency behavior. If the single workflow fails mid-way, only the bump (or only the docs update) may have been committed. Mitigated by making the docs-update job depend on bump-version via `needs:` and using atomic commit+push in each job.
- **RISK-003**: CodeQL analysis (TASK-014) may produce false positives on vanilla JS patterns (e.g., `innerHTML` usage). Mitigated by the existing `escHtml()` sanitization pattern and by tuning CodeQL's alert severity thresholds.
- **RISK-004**: Auto-merge Dependabot (TASK-020) could merge a dependency with a subtle regression that passes tests. Mitigated by only auto-merging minor/patch updates and requiring all CI checks to pass first.
- **RISK-005**: Path filters on Playwright (TASK-011) could cause E2E tests to be skipped when a workflow file change affects test behavior. Mitigated by including `playwright.config.js` and `.github/workflows/playwright.yml` in the path filter.
- **ASSUMPTION-001**: The repository owner has GitHub Actions enabled with sufficient minutes for the additional workflows (estimated +20% CI minutes from new workflows).
- **ASSUMPTION-002**: GitHub CodeQL is available for the repository (free for public repos, requires GitHub Advanced Security for private repos).
- **ASSUMPTION-003**: The `actions/labeler@v5`, `actions/stale@v9`, and `github/codeql-action` are stable and available at their current versions at the time of implementation.
- **ASSUMPTION-004**: Node.js `--experimental-test-coverage` is stable enough for CI reporting in Node 22 (it has been available since Node 20).
- **ASSUMPTION-005**: The existing gem-team agent framework (from mubaidr/gem-team) supports the modifications described in Phase 7 without breaking orchestrator delegation.

## 8. Related Specifications / Further Reading

- [GitHub Actions Composite Actions documentation](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action)
- [GitHub Actions Security Hardening guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GitHub CodeQL documentation](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql)
- [Dependabot configuration options](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file)
- [MCP (Model Context Protocol) specification](https://modelcontextprotocol.io/)
- [gem-team multi-agent framework](https://github.com/mubaidr/gem-team)
- [Node.js test runner coverage](https://nodejs.org/api/test.html#collecting-code-coverage)
- Current repository: [dkylepeppers-alt/Comiccreator](https://github.com/dkylepeppers-alt/Comiccreator)
