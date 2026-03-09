# Copilot Instructions — AI Comic Creator

## What This Project Is

A fully installable Progressive Web App (PWA) for generating AI-powered comic books. It is **pure vanilla HTML/CSS/JavaScript** with no frontend build step. The app runs directly in a browser as static files served by any HTTP server. A NanoGPT API key is required for AI generation features.

---

## Repository Layout

```
index.html              Main app shell (SPA, all pages rendered into #content)
manifest.json           PWA manifest
sw.js                   Service worker (offline cache-first for shell, network-only for API)
version.json            Single source of truth for app version
css/app.css             All styles (dark theme, mobile-first, no preprocessor)
js/
  utils.js              Shared helpers: escHtml, timeAgo, getGenreEmoji, dedupeByNameLatest,
                        cosineSimilarity, sanitizeImagePrompt, GENRES
  db.js                 IndexedDB layer (DB singleton – open, get, put, del, getAll, getByIndex,
                        uuid, settings helpers, fileToDataURL, migrateCharacter, migrateWorld,
                        seedDefaults, dedupePresets)
  api.js                NanoGPT API client (chat streaming, image gen, embeddings, model fetching,
                        image compression, prompt building, reference image variations)
  app.js                SPA router (App.navigate, modal, toast, error log)
  pages/
    home.js             Dashboard
    characters.js       Character CRUD + multi-image upload (up to 20 images per character)
    worlds.js           World CRUD + multi-image upload (up to 20 images per world)
    create.js           Comic generation engine
    library.js          Comic viewer + PDF export
    presets.js          Prompt preset editor
    image-presets.js    Image style preset editor (reusable art-style prompt prefixes)
    settings.js         API config, model params, data management (contains APP_VERSION constant)
test/
  config-integrity.test.js   Version sync and sw.js asset checks
  db.test.js                 IndexedDB layer tests (uses fake-indexeddb)
  api-integration.test.js    API module tests (uses fake-indexeddb)
  api-pure.test.js           Pure API function tests
  pure-functions.test.js     Utility function tests
  utils.test.js              escHtml / utils tests
  e2e/
    smoke.spec.js            Playwright end-to-end smoke tests (Chromium, requires local server)
scripts/
  bump-version.sh        Atomically bumps version in all 5 places (see Versioning below)
  update-docs.sh         Regenerates auto-generated README sections (directory tree, workflows table)
  install-hooks.sh       Installs git pre-commit hook
  pre-commit             Pre-commit hook (version consistency check only — does NOT run syntax checks or tests)
.github/
  agents/                Copilot agent definitions (gem-team + standalone agents)
  copilot-instructions.md  This file — project-wide Copilot instructions
  workflows/             CI/CD workflow definitions
```

---

## Script Load Order (Critical)

`index.html` loads scripts in this exact order — **do not change it**:

```html
<script src="js/utils.js"></script>           <!-- exports globals: escHtml, GENRES, etc. -->
<script src="js/db.js"></script>              <!-- depends on utils globals (dedupeByNameLatest) -->
<script src="js/api.js"></script>             <!-- depends on DB global -->
<script src="js/pages/home.js"></script>
<script src="js/pages/characters.js"></script>
<script src="js/pages/worlds.js"></script>
<script src="js/pages/create.js"></script>
<script src="js/pages/library.js"></script>
<script src="js/pages/presets.js"></script>
<script src="js/pages/image-presets.js"></script>
<script src="js/pages/settings.js"></script>
<script src="js/app.js"></script>             <!-- depends on all page modules -->
```

All JS files are browser globals (IIFE or `(function(exports){…})(…)` pattern). There is no module bundler. Every new `<script>` tag added to `index.html` **must also be added to `STATIC_ASSETS` in `sw.js`** — the `config-integrity` test enforces this.

---

## Versioning — Must Stay in Sync

The app version appears in **five places** and CI tests enforce that all five match:

| File | Location |
|------|----------|
| `version.json` | `"version": "1.6.30"` |
| `sw.js` | `const CACHE_NAME = 'comic-creator-v1.6.30';` |
| `js/pages/settings.js` | `const APP_VERSION = '1.6.30';` |
| `index.html` | sidebar footer: `v1.6.30 &middot; PWA` |
| `package.json` | `"version": "1.6.30"` |

**Use the bump script** to update all five atomically:

```bash
bash scripts/bump-version.sh patch   # 1.6.30 → 1.6.31
bash scripts/bump-version.sh minor   # 1.6.30 → 1.7.0
bash scripts/bump-version.sh major   # 1.6.30 → 2.0.0
```

If you manually edit the version, update all five files. Failing to do so will break CI.

---

## Development Commands

```bash
# Install dev dependencies (required before running tests)
npm install

# Run all tests (Node built-in test runner)
npm test

# Run Playwright E2E tests (auto-starts/reuses a local server on port 8080 via python3; requires Python 3)
npm run test:e2e

# Syntax check all JS files
npm run check-syntax

# Lint JS (ESLint)
npm run lint
npm run lint:fix

# Format (Prettier)
npm run format
npm run format:check

# Serve locally on port 8080
npm run serve

# Regenerate auto-generated README sections (directory tree, workflows table)
npm run update-docs
```

Tests live in `test/*.test.js` and use the Node.js built-in `node:test` / `node:assert` modules. `fake-indexeddb` is used to mock IndexedDB in tests. Always run `npm install` first in a fresh environment.

---

## CI Workflow

`.github/workflows/tests.yml` runs on every push and pull request:

1. `npm ci` — install dependencies
2. `npm run check-syntax` — `node --check` every JS file
3. `npm run lint` — ESLint checks
4. `npm test` — all unit/integration test files

`.github/workflows/playwright.yml` also runs on every push and pull request and executes Playwright E2E tests (`npm run test:e2e`) in Chromium. E2E test artifacts (reports) are uploaded with 14-day retention.

Additional workflows:
- `.github/workflows/auto-bump.yml` — auto-bumps the patch version on every push to `Main` (skips bot commits)
- `.github/workflows/auto-update-docs.yml` — regenerates auto-generated README sections on every push to `Main` (skips bot commits); runs `scripts/update-docs.sh`
- `.github/workflows/deploy-pages.yml` — deploys to GitHub Pages on push to `Main` or manual trigger
- `.github/workflows/release.yml` — manual `workflow_dispatch` release: runs checks, bumps version, tags, creates GitHub Release
- `.github/workflows/security.yml` — weekly `npm audit --audit-level=high` security scan

`auto-bump.yml` and `auto-update-docs.yml` share a concurrency group (`auto-main-push`) to serialize bot pushes and avoid non-fast-forward failures.

All steps must pass before merging. If CI is red, check the workflow run logs.

---

## App Architecture Patterns

### SPA Router (`js/app.js`)

`App.navigate(page, param)` is the only way to change pages:
1. Calls `previousPage.onUnmount()` if present
2. Calls `pages[page].render(param)` → sets `#content` innerHTML
3. Calls `pages[page].postRender(param)` if present — called without `await` (fire-and-forget); may be async but its Promise is not awaited by the router
4. Calls `await pages[page].onMount(param)` if present

Each page module exposes: `render(param)` (required), optionally `postRender(param)`, `onMount(param)`, `onUnmount()`.

### HTML Safety

**Always use `escHtml(str)`** (from `js/utils.js`) when inserting user-controlled or API-returned data into HTML strings. Never use `.innerHTML = userInput` directly. The function escapes `&`, `<`, `>`, `"`, and `'`.

### Utility Helpers (`js/utils.js`)

- `escHtml(str)` — HTML-escapes a string (see HTML Safety above)
- `timeAgo(ts)` — formats a timestamp as a human-readable relative string (e.g., "3h ago")
- `getGenreEmoji(genre)` — returns the emoji for a genre ID
- `dedupeByNameLatest(list)` — deduplicates an array of objects by name (case-insensitive), keeping the most recently updated/created entry
- `cosineSimilarity(a, b)` — computes cosine similarity between two numeric arrays; returns 0 for null/empty/mismatched inputs
- `sanitizeImagePrompt(rawPrompt)` — strips narrative noise (dialogue, story text, internal states) from an image prompt so only visual descriptors remain
- `GENRES` — array of `{ id, name, emoji }` genre objects

### IndexedDB (`js/db.js`)

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

### API Client (`js/api.js`)

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

1. Create `js/pages/mypage.js` exporting a `MyPage` object with at minimum a `render()` method.
2. Add `<script src="js/pages/mypage.js"></script>` to `index.html` **before** `js/app.js`.
3. Add `'/js/pages/mypage.js'` to `STATIC_ASSETS` in `sw.js`.
4. Register the page in `app.js`: add to `pages` and `pageTitles` objects.
5. Add navigation links as needed in `index.html`.
6. Add the new global name (`MyPage`) to `eslint.config.js` globals to avoid `no-undef` lint errors.

---

## Errors Encountered and Workarounds

- **ESLint browser-globals**: `eslint.config.js` declares browser globals manually because the standard `eslint:recommended` config does not include them. If you add a new global (e.g., a new page module name), add it to `eslint.config.js`.
- **`fake-indexeddb` in tests**: `fake-indexeddb` must be `require`d at the top of each test file that exercises IndexedDB. See `test/db.test.js` for the pattern.
- **Service worker caching**: After a version bump, browsers may serve cached old assets. The `CACHE_NAME` change forces the SW activate step to delete the old cache. Always bump the version when deploying asset changes.
- **`node_modules` not present in fresh sandbox**: Run `npm install` before `npm test`. The `fake-indexeddb` devDependency is not installed by default.

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
