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
  utils.js              Shared helpers: escHtml, timeAgo, getGenreEmoji, dedupeByNameLatest, GENRES
  db.js                 IndexedDB layer (DB singleton – open, get, put, del, getAll, getByIndex, uuid, settings helpers)
  api.js                NanoGPT API client (chat streaming, image gen, model fetching, prompt building)
  app.js                SPA router (App.navigate, modal, toast, error log)
  pages/
    home.js             Dashboard
    characters.js       Character CRUD + image upload
    worlds.js           World CRUD + multi-image upload
    create.js           Comic generation engine
    library.js          Comic viewer + PDF export
    presets.js          Prompt preset editor
    settings.js         API config, model params, data management (contains APP_VERSION constant)
test/
  config-integrity.test.js   Version sync and sw.js asset checks
  db.test.js                 IndexedDB layer tests (uses fake-indexeddb)
  api-integration.test.js    API module tests (uses fake-indexeddb)
  api-pure.test.js           Pure API function tests
  pure-functions.test.js     Utility function tests
  utils.test.js              escHtml / utils tests
scripts/
  bump-version.sh        Atomically bumps version in all 5 places (see Versioning below)
  install-hooks.sh       Installs git pre-commit hook
  pre-commit             Pre-commit hook (syntax check + test)
```

---

## Script Load Order (Critical)

`index.html` loads scripts in this exact order — **do not change it**:

```html
<script src="js/utils.js"></script>     <!-- exports globals: escHtml, GENRES, etc. -->
<script src="js/db.js"></script>        <!-- depends on utils globals (dedupeByNameLatest) -->
<script src="js/api.js"></script>       <!-- depends on DB global -->
<script src="js/pages/home.js"></script>
<script src="js/pages/characters.js"></script>
<script src="js/pages/worlds.js"></script>
<script src="js/pages/create.js"></script>
<script src="js/pages/library.js"></script>
<script src="js/pages/presets.js"></script>
<script src="js/pages/settings.js"></script>
<script src="js/app.js"></script>       <!-- depends on all page modules -->
```

All JS files are browser globals (IIFE or `(function(exports){…})(…)` pattern). There is no module bundler. Every new `<script>` tag added to `index.html` **must also be added to `STATIC_ASSETS` in `sw.js`** — the `config-integrity` test enforces this.

---

## Versioning — Must Stay in Sync

The app version appears in **five places** and CI tests enforce that all five match:

| File | Location |
|------|----------|
| `version.json` | `"version": "1.6.2"` |
| `sw.js` | `const CACHE_NAME = 'comic-creator-v1.6.2';` |
| `js/pages/settings.js` | `const APP_VERSION = '1.6.2';` |
| `index.html` | sidebar footer: `v1.6.2 &middot; PWA` |
| `package.json` | `"version": "1.6.2"` |

**Use the bump script** to update all five atomically:

```bash
bash scripts/bump-version.sh patch   # 1.6.2 → 1.6.3
bash scripts/bump-version.sh minor   # 1.6.2 → 1.7.0
bash scripts/bump-version.sh major   # 1.6.2 → 2.0.0
```

If you manually edit the version, update all five files. Failing to do so will break CI.

---

## Development Commands

```bash
# Install dev dependencies (required before running tests)
npm install

# Run all tests (Node built-in test runner)
npm test

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
# or
./server.sh
```

Tests live in `test/*.test.js` and use the Node.js built-in `node:test` / `node:assert` modules. `fake-indexeddb` is used to mock IndexedDB in tests. Always run `npm install` first in a fresh environment.

---

## CI Workflow

`.github/workflows/tests.yml` runs on every push and pull request:

1. `npm ci` — install dependencies
2. `npm run check-syntax` — `node --check` every JS file
3. `npm test` — all test files

Both steps must pass before merging. If CI is red, check the workflow run logs.

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

### IndexedDB (`js/db.js`)

Six object stores: `characters`, `worlds`, `comics`, `pages`, `presets`, `settings`.

- `DB.get(store, id)` / `DB.put(store, obj)` / `DB.del(store, id)` / `DB.getAll(store)`
- `DB.getByIndex(store, indexName, value)` — for indexed queries (e.g., pages by comicId)
- `DB.getSetting(key, default)` / `DB.setSetting(key, value)` — key/value config store
- `DB.uuid()` — generates a UUID
- `DB.open()` is called automatically before every operation; calling it manually is safe (idempotent)

### API Client (`js/api.js`)

All methods are async and read the API key and model settings from IndexedDB automatically.

- `API.chatCompletionStream(messages, onChunk, options)` — streaming SSE; `onChunk(delta, fullText)` is called for each token
- `API.chatCompletion(messages, options)` — non-streaming
- `API.generateImage(prompt, options)` — image generation
- `API.buildSystemPrompt(genre, characters, world, customSystemPrompt)` — assembles the system prompt
- `API.parseComicResponse(text)` — extracts JSON from the LLM response (strips markdown fences, finds `{…}`)
- `API.fetchTextModels()` / `API.fetchImageModels()` — fetched from NanoGPT with 6-hour cache in IndexedDB

### Error Handling

Use `App.logError(context, error, extraDetails)` to record errors to the in-app error log (accessible via the ⚠ button in the top bar). Do not swallow errors silently in page modules.

---

## Adding a New Page

1. Create `js/pages/mypage.js` exporting a `MyPage` object with at minimum a `render()` method.
2. Add `<script src="js/pages/mypage.js"></script>` to `index.html` **before** `js/app.js`.
3. Add `'/js/pages/mypage.js'` to `STATIC_ASSETS` in `sw.js`.
4. Register the page in `app.js`: add to `pages` and `pageTitles` objects.
5. Add navigation links as needed in `index.html`.

---

## Errors Encountered and Workarounds

- **ESLint browser-globals**: `eslint.config.js` declares browser globals manually because the standard `eslint:recommended` config does not include them. If you add a new global (e.g., a new page module name), add it to `eslint.config.js`.
- **`fake-indexeddb` in tests**: `fake-indexeddb` must be `require`d at the top of each test file that exercises IndexedDB. See `test/db.test.js` for the pattern.
- **Service worker caching**: After a version bump, browsers may serve cached old assets. The `CACHE_NAME` change forces the SW activate step to delete the old cache. Always bump the version when deploying asset changes.
- **`node_modules` not present in fresh sandbox**: Run `npm install` before `npm test`. The `fake-indexeddb` devDependency is not installed by default.
