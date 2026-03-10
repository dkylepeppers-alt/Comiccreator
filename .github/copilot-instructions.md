# Copilot Instructions — AI Comic Creator

## What This Project Is

A fully installable Progressive Web App (PWA) for generating AI-powered comic books. It is a **Vite-powered PWA using TypeScript ES modules**. Vite handles bundling, dev server (with HMR), TypeScript transpilation, and service worker generation via `vite-plugin-pwa` (Workbox). A NanoGPT API key is required for AI generation features.

---

## Repository Layout

```
index.html              Main app shell (SPA, single module entry point)
vite.config.js          Vite configuration (PWA plugin, __APP_VERSION__ define)
vitest.config.ts        Vitest test configuration (extends vite.config.js)
tsconfig.json           TypeScript configuration (strict: false, allowJs: true)
public/
  manifest.json         PWA manifest (served as-is by Vite)
  version.json          Single source of truth for app version
  icons/                App icons (192, 512, SVG)
  .nojekyll             GitHub Pages config
src/
  css/app.css           All styles (dark theme, mobile-first, no preprocessor)
  js/
    global.d.ts         Global type declarations (App, __APP_VERSION__, Window extensions)
    utils.ts            Shared helpers + interfaces (Genre, Timestamped, ImageRef, PageModule)
    db.ts               IndexedDB layer + interfaces (Character, World, Comic, Preset, etc.)
    api.ts              NanoGPT API client + interfaces (ChatMessage, ImageGenOptions, etc.)
    app.ts              SPA router + entry point (imports all modules, sets window globals)
    pages/
      home.ts           Dashboard
      characters.ts     Character CRUD + multi-image upload (up to 20 images per character)
      worlds.ts         World CRUD + multi-image upload (up to 20 images per world)
      create.ts         Comic generation engine
      library.ts        Comic viewer + PDF export
      presets.ts         Prompt preset editor
      image-presets.ts   Image style preset editor (reusable art-style prompt prefixes)
      settings.ts        API config, model params, data management (APP_VERSION injected by Vite define)
test/
  config-integrity.test.js   Version sync across source files
  db.test.js                 IndexedDB layer tests (uses fake-indexeddb)
  api-integration.test.js    API module tests (uses fake-indexeddb)
  api-pure.test.js           Pure API function tests
  pure-functions.test.js     Utility function tests
  utils.test.js              escHtml / utils tests
  e2e/
    smoke.spec.js            Playwright end-to-end smoke tests (Chromium, requires build first)
scripts/
  bump-version.sh        Atomically bumps version in all 3 source files (see Versioning below)
  update-docs.sh         Regenerates auto-generated README sections (directory tree, workflows table)
  install-hooks.sh       Installs git pre-commit hook
  pre-commit-version-check.sh  Pre-commit hook (version consistency check)
dist/                    Vite production build output (not committed)
.github/
  actions/
    setup-node-env/      Composite action: checkout + Node.js 22 setup + npm ci
      action.yml
    setup-playwright/    Composite action: setup-node-env + Playwright browser caching
      action.yml
  agents/                Copilot agent definitions (gem-team + standalone agents)
  copilot-instructions.md  This file — project-wide Copilot instructions
  workflows/             CI/CD workflow definitions
```

---

## ES Module Architecture

`index.html` has a single module entry point:

```html
<script type="module" src="/src/js/app.ts"></script>
```

`app.ts` imports all modules and exposes them on `window` for HTML `onclick` handlers:

```ts
import { escHtml, GENRES, ... } from './utils.js';
import DB from './db.js';
import HomePage from './pages/home.js';
// ... all other pages
window.App = App;
window.HomePage = HomePage;
// etc.
```

**Dependency graph:** `utils.ts` → `db.ts` → `api.ts` → pages → `app.ts`. Vite resolves the import graph automatically — no manual script load order is needed. Import paths use `.js` extensions (TypeScript with `moduleResolution: "bundler"` resolves `.js` to `.ts`).

All source modules use standard ES `import`/`export` with TypeScript type annotations. The `package.json` has `"type": "module"` so tests also use ESM.

---

## Versioning — Must Stay in Sync

The app version appears in **three source files** and CI tests enforce that they match:

| File | Location |
|------|----------|
| `public/version.json` | `"version": "X.Y.Z"` — source of truth, read by `vite.config.js` at build time |
| `package.json` | `"version": "X.Y.Z"` |
| `index.html` | sidebar footer: `vX.Y.Z &middot; PWA` |

`settings.ts` gets `APP_VERSION` via Vite's `define` plugin at build time — `vite.config.js` reads `public/version.json` and injects `__APP_VERSION__` as a global constant. In dev mode it falls back to `'dev'`.

The service worker version is managed automatically by Workbox (`vite-plugin-pwa`) — no manual `CACHE_NAME` update is needed.

**Use the bump script** to update all three atomically:

```bash
bash scripts/bump-version.sh patch   # 1.6.58 → 1.6.59
bash scripts/bump-version.sh minor   # 1.6.58 → 1.7.0
bash scripts/bump-version.sh major   # 1.6.58 → 2.0.0
```

If you manually edit the version, update all three files. Failing to do so will break CI.

---

## Development Commands

```bash
# Install dev dependencies (required before running tests)
npm install

# Start Vite dev server with HMR on port 8080
npm run dev

# Production build to dist/
npm run build

# Preview production build on port 8080
npm run serve

# Run all tests (Vitest)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run coverage

# Run Playwright E2E tests (requires build first)
npm run test:e2e

# Type check (TypeScript, no emit)
npm run typecheck

# Lint TS/JS (ESLint with @typescript-eslint, scoped to src/js/)
npm run lint
npm run lint:fix

# Format (Prettier, scoped to src/)
npm run format
npm run format:check

# Regenerate auto-generated README sections (directory tree, workflows table)
npm run update-docs
```

Tests live in `test/*.test.js` and use Vitest (`describe`/`it`/`expect` API). `fake-indexeddb` is used to mock IndexedDB in tests (imported via `import 'fake-indexeddb/auto'`). Always run `npm install` first in a fresh environment.

---

## CI Workflow

Two **composite actions** eliminate duplicated setup steps across workflows:
- `.github/actions/setup-node-env` — runs `actions/setup-node@v4` (Node.js 22 with npm cache) then `npm ci`. Referenced with `uses: ./.github/actions/setup-node-env` (checkout must happen first in the calling workflow).
- `.github/actions/setup-playwright` — calls `setup-node-env`, then caches Playwright browsers with `actions/cache@v4` (key: `playwright-{os}-{hash(package-lock.json)}`), then installs Chromium only on cache miss.

`.github/workflows/tests.yml` runs on every push and pull request:

1. `npm ci` — install dependencies (via `setup-node-env` composite action)
2. `npm run build` — Vite production build (also serves as a syntax/import check)
3. `npm run lint` — ESLint checks (with `@typescript-eslint`)
4. `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
5. `npm run format:check` — Prettier formatting enforcement
6. `npm run coverage:ci` — all unit/integration tests with Vitest + `@vitest/coverage-v8`
7. Coverage artifact upload (14-day retention) and optional Codecov upload

`.github/workflows/playwright.yml` runs on pushes and PRs that change relevant files (`src/**`, `index.html`, `vite.config.js`, `test/e2e/**`, `playwright.config.js`, `.github/workflows/playwright.yml`, `.github/actions/setup-playwright/**`). Steps: `npm run build` then `npm run test:e2e` (Playwright uses the Vite preview server). E2E test artifacts (reports) are uploaded with 14-day retention.

Additional workflows:
- `.github/workflows/post-merge.yml` — consolidated post-merge pipeline triggered on every push to `main` (skips bot commits); runs two sequential jobs: `bump-version` (runs `scripts/bump-version.sh patch`, commits and pushes the version bump) then `update-docs` (checks out the updated `main`, runs `scripts/update-docs.sh`, commits and pushes README changes if any). Uses concurrency group `post-merge-main` with `cancel-in-progress: true`.
- `.github/workflows/deploy-pages.yml` — deploys to GitHub Pages on push to `main` or manual trigger; runs `npm run build` and deploys from `dist/`
- `.github/workflows/release.yml` — manual `workflow_dispatch` release: runs `npm run build && npm run lint && npm test`, bumps version, tags, creates GitHub Release
- `.github/workflows/security.yml` — weekly `npm audit --audit-level=high` security scan
- `.github/workflows/security-pr.yml` — runs `npm audit --audit-level=high` on every pull request to catch new vulnerabilities before merge
- `.github/workflows/codeql-analysis.yml` — CodeQL SAST analysis for JavaScript/TypeScript, runs on push to `main` and on pull requests
- `.github/workflows/auto-merge-dependabot.yml` — automatically approves and merges Dependabot minor and patch update PRs; runs on every pull request but only acts when `github.actor == 'dependabot[bot]'`
- `.github/workflows/pr-labeler.yml` — labels pull requests automatically based on changed file paths (uses `actions/labeler`); runs on every pull request
- `.github/workflows/stale.yml` — marks issues and PRs as stale after 30 days of inactivity and closes them after a further 7 days; runs daily via cron
- `.github/workflows/ci-metrics.yml` — weekly CI metrics report; fetches the last 20 runs of `tests.yml` and `playwright.yml`, calculates average/min/max duration and success rate, posts summary to the GitHub Actions job summary

All steps must pass before merging. If CI is red, check the workflow run logs.

---

## App Architecture Patterns

### SPA Router (`src/js/app.ts`)

`App.navigate(page, param)` is the only way to change pages:
1. Calls `previousPage.onUnmount()` if present
2. Calls `pages[page].render(param)` → sets `#content` innerHTML
3. Calls `pages[page].postRender(param)` if present — called without `await` (fire-and-forget); may be async but its Promise is not awaited by the router
4. Calls `await pages[page].onMount(param)` if present

Each page module uses ES `export` to expose its page object (e.g., `export const HomePage: PageModule = { render() {…} }`). Page objects must implement the `PageModule` interface from `utils.ts`: `render(param)` (required), and optionally `postRender(param)`, `onMount(param)`, `onUnmount()`.

`app.ts` imports all page modules and assigns them to `window` (e.g., `window.HomePage = HomePage`) so that HTML `onclick` handlers in rendered templates can reference them.

### HTML Safety

**Always use `escHtml(str)`** (import from `src/js/utils.ts`) when inserting user-controlled or API-returned data into HTML strings. Never use `.innerHTML = userInput` directly. The function escapes `&`, `<`, `>`, `"`, and `'`.

### Utility Helpers (`src/js/utils.ts`)

- `escHtml(str)` — HTML-escapes a string (see HTML Safety above)
- `timeAgo(ts)` — formats a timestamp as a human-readable relative string (e.g., "3h ago")
- `getGenreEmoji(genre)` — returns the emoji for a genre ID
- `dedupeByNameLatest(list)` — deduplicates an array of objects by name (case-insensitive), keeping the most recently updated/created entry
- `cosineSimilarity(a, b)` — computes cosine similarity between two numeric arrays; returns 0 for null/empty/mismatched inputs
- `sanitizeImagePrompt(rawPrompt)` — strips narrative noise (dialogue, story text, internal states) from an image prompt so only visual descriptors remain
- `GENRES` — array of `{ id, name, emoji }` genre objects

### IndexedDB (`src/js/db.ts`)

Seven object stores: `characters`, `worlds`, `comics`, `pages`, `presets`, `imagePresets`, `settings`.

- `DB.get(store, id)` / `DB.put(store, obj)` / `DB.del(store, id)` / `DB.getAll(store)`
- `DB.getByIndex(store, indexName, value)` — for indexed queries (e.g., pages by comicId)
- `DB.getSetting(key, default)` / `DB.setSetting(key, value)` — key/value config store
- `DB.uuid()` — generates a UUID
- `DB.open()` is called automatically before every operation; calling it manually is safe (idempotent)
- `DB.fileToDataURL(file)` — converts a `File` object to a base64 data URL (Promise)
- `DB.migrateCharacter(char)` — upgrades a legacy single-`imageData` character to the `images[]` format in-memory (does NOT persist; call `DB.put()` to save)
- `DB.migrateWorld(world)` — upgrades a legacy `images: string[]` world to the `images: [{dataUrl, tag, description}]` format in-memory (does NOT persist)
- `DB.seedDefaults()` — inserts the three built-in prompt presets on first run (idempotent)
- `DB.dedupePresets()` — removes duplicate presets by name, keeping the most recently updated one

### API Client (`src/js/api.ts`)

All methods are async and read the API key and model settings from IndexedDB automatically.

- `API.chatCompletionStream(messages, onChunk, options)` — streaming SSE; `onChunk(delta, fullText)` is called for each token; pass `options.signal` (AbortSignal) to support cancellation
- `API.chatCompletion(messages, options)` — non-streaming
- `API.generateImage(prompt, options)` — image generation; supports `options.imageDataUrls` (array of reference image data URLs), `options.labeledRefs` (typed references with label/description/type), and `options.resolution`; caps reference images to DB setting `maxRefImages` (default 4)
- `API.generateEmbedding(text, options)` — generates a text embedding via NanoGPT embeddings API; reads `embeddingModel` from settings (default: `text-embedding-3-small`); returns a number array or `null` on failure
- `API.generateImageCaption(dataUrl, contextHints, options)` — calls a vision-capable LLM to produce a text description of a reference image; `contextHints.type` can be `'character'`, `'character-in-world'`, `'character-interaction'`, or `'world'`
- `API.generateRefVariation(sourceDataUrl, prompt, options)` — generates a single reference image variation from a source image and a prompt string (used by the Generate References flow)
- `API.CHARACTER_REF_VARIATIONS` / `API.WORLD_REF_VARIATIONS` / `API.CHARACTER_WORLD_VARIATIONS` — arrays of `{ tag, prompt }` objects that define the variation types produced by the Generate References button
- `API.buildSystemPrompt(genre, characters, world, customSystemPrompt, options)` — assembles the system prompt
- `API.parseComicResponse(text)` — extracts JSON from the LLM response (strips markdown fences, finds `{…}`)
- `API.fetchTextModels()` / `API.fetchImageModels()` — fetched from NanoGPT with 6-hour cache in IndexedDB
- `API.getModelSizes(modelId)` — returns supported image sizes for a model from live cache or `KNOWN_IMAGE_SIZES` static fallback; returns `null` if unknown (caller should allow free-form entry)
- `API.compressDataUrl(dataUrl, maxDim, quality)` — resizes and re-encodes an image data URL as JPEG to reduce payload size (browser-only, uses Canvas)

### Error Handling

Use `App.logError(context, error, extraDetails)` to record errors to the in-app error log (accessible via the ⚠ button in the top bar). Do not swallow errors silently in page modules.

---

## Adding a New Page

1. Create `src/js/pages/mypage.ts` exporting a `MyPage` object implementing the `PageModule` interface (import from `'../utils.js'`). At minimum provide a `render()` method.
2. Import it in `src/js/app.ts` (e.g., `import MyPage from './pages/mypage.js';`).
3. Register the page in `app.ts`: add to `pages` and `pageTitles` objects.
4. Add `window.MyPage = MyPage;` in `app.ts` so HTML `onclick` handlers can reference it.
5. Add navigation links as needed in `index.html`.

---

## Errors Encountered and Workarounds

- **`__APP_VERSION__` Vite define**: `vite.config.js` reads `public/version.json` and injects `__APP_VERSION__` at build time via `define`. In dev mode or tests where Vite's define is unavailable, `settings.ts` falls back to `'dev'`. The type is declared in `src/js/global.d.ts`.
- **`fake-indexeddb` in tests**: Import `'fake-indexeddb/auto'` at the top of each test file that exercises IndexedDB. Use dynamic `await import()` for source modules to ensure the polyfill is active before DB initialization. See `test/db.test.js` for the pattern.
- **`node_modules` not present in fresh sandbox**: Run `npm install` before `npm test`. The `fake-indexeddb`, `vitest`, `typescript`, and `vite` devDependencies are not installed by default.
- **Service worker**: The service worker is auto-generated by Workbox via `vite-plugin-pwa`. Old hand-written `comic-creator-*` caches are cleaned up automatically on activation. No manual cache versioning is needed.
- **TypeScript `@ts-nocheck`**: Page modules (`src/js/pages/*.ts`) use `// @ts-nocheck` at the top because they contain extensive DOM manipulation that would require many type assertions. Core modules (`utils.ts`, `db.ts`, `api.ts`, `app.ts`) are fully type-checked.

---

## Multi-Agent Workflow (Gem Team)

This repository uses the [gem-team](https://github.com/mubaidr/gem-team) multi-agent orchestration framework. Agent definitions live in `.github/agents/` and follow the `.agent.md` naming convention.

### Agent Roster

| Agent | File | Role |
|-------|------|------|
| `gem-orchestrator` | `gem-orchestrator.agent.md` | Team Lead — detects phase, delegates to workers, synthesizes results. Never executes directly (`disable-model-invocation: true`). |
| `gem-researcher` | `gem-researcher.agent.md` | Explores codebase, maps dependencies, delivers structured YAML findings. |
| `gem-planner` | `gem-planner.agent.md` | Creates DAG-based `plan.yaml` with task decomposition, pre-mortem analysis, and wave assignment. |
| `gem-implementer` | `gem-implementer.agent.md` | Writes code using TDD (Red → Green). Follows plan specifications. |
| `gem-browser-tester` | `gem-browser-tester.agent.md` | Runs E2E scenarios in browser, verifies UI/UX and accessibility. |
| `gem-devops` | `gem-devops.agent.md` | Manages CI/CD, containers, and infrastructure deployment with approval gates. |
| `gem-reviewer` | `gem-reviewer.agent.md` | Security gatekeeper — OWASP scanning, secrets detection, PRD compliance. |
| `gem-documentation-writer` | `gem-documentation-writer.agent.md` | Writes technical docs, generates diagrams, maintains code-documentation parity. |

### Workflow Phases

1. **Research** — Orchestrator delegates to `gem-researcher` (up to 4 concurrent) to gather codebase context per focus area.
2. **Planning** — Orchestrator delegates to `gem-planner` to create `docs/plan/{plan_id}/plan.yaml`.
3. **Execution** — Orchestrator reads `plan.yaml`, dispatches tasks by wave (dependencies first, up to 4 concurrent agents per wave).
4. **Summary** — Orchestrator delegates to `gem-documentation-writer` to produce a walkthrough and finalize `docs/prd.yaml`.

### Generated Artifacts

| Artifact | Path | Producer |
|----------|------|----------|
| Task DAG + state | `docs/plan/{plan_id}/plan.yaml` | `gem-planner` |
| Research findings | `docs/plan/{plan_id}/research_findings_{focus}.yaml` | `gem-researcher` |
| Walkthrough / PRD | `docs/plan/{plan_id}/walkthrough-*.md`, `docs/prd.yaml` | `gem-documentation-writer` |
| Failure logs | `docs/plan/{plan_id}/logs/{agent}_{task_id}_{ts}.yaml` | Any agent on failure |

### Delegation Protocol

The orchestrator passes `base_params` (task_id, plan_id, plan_path, task_definition, contracts) plus agent-specific parameters to each worker. Each worker returns a JSON response with `status`, `task_id`, `plan_id`, `summary`, and an `extra` object containing agent-specific details.

### Additional Agents

The repository also includes non-gem agents in `.github/agents/`:

- `Bugfixer.agent.md` — Bug detection and targeted fixes.
- `Docs-agent.agent.md` — Repository documentation specialist.
- `Readme.agent.md` — README file maintenance.
- `my-agent.agent.md` — General-purpose planning specialist.

These agents operate independently from the gem-team workflow.
