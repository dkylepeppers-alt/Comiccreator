# CLAUDE.md

Trust these instructions. Only search the codebase if the information here is incomplete or found to be incorrect.

## Project Summary

AI Comic Creator — a vanilla JavaScript Progressive Web App (PWA) that generates AI-powered comic books with interactive narratives, custom characters, and world-building. Uses the NanoGPT API (OpenAI-compatible) for text generation and image generation.

- **~5,000 lines of code** across 22+ files (11 JS, 1 CSS, 1 HTML, plus config/scripts)
- **Current version:** `1.6.2`
- **Dependency model:** vanilla browser runtime (`js/api.js` performs runtime API calls); npm dependencies available for Node-side tasks (including `nanogptjs` for tests/tooling)
- **Automated local checks:** npm scripts `check-syntax`, `test`, `lint` and a GitHub Actions workflow (`.github/workflows/tests.yml`)
- **Runtime:** Any modern browser (ES2020+). Server is any static HTTP server — no build step.

---

## Running Locally

Always start the dev server from the repo root:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Verified working with Python 3.11.

Alternative servers (all verified working):
```bash
npx serve -s -l 8080      # Node.js
php -S 0.0.0.0:8080       # PHP
```

`server.sh` is a Termux-specific launcher (shebang: `/data/data/com.termux/files/usr/bin/bash`). It auto-detects available HTTP servers and generates placeholder PNG icons if missing. Use `PORT=3000 ./server.sh` for a custom port.

---

## Validation

Use both automated npm checks and manual browser validation:

1. **Automated checks** — run `npm run check-syntax`, `npm test`, and `npm run lint` when relevant to your change.
2. **Serve and load** — start the dev server, open `http://localhost:8080`, and confirm the app loads without console errors.
3. **Service worker** — if you modify any cached file, bump `CACHE_NAME` in `sw.js` to match the new version (e.g. `'comic-creator-v1.6.2'`). Hard-refresh (`Ctrl+Shift+R`) to bypass cache during development.
4. **Page navigation** — click through all 7 pages (Home, Characters, Worlds, Create, Library, Presets, Settings) to verify no render errors.

---

## Version Management

**Every merge to `master` must bump ALL FIVE of these locations — no exceptions.** CI tests enforce this.

1. **`version.json`** — increment semver and update `updated`:
   ```json
   { "version": "1.6.2", "updated": "2026-03-02" }
   ```
2. **`sw.js`** — set `CACHE_NAME`:
   ```js
   const CACHE_NAME = 'comic-creator-v1.6.2';
   ```
3. **`js/pages/settings.js`** — set `APP_VERSION`:
   ```js
   const APP_VERSION = '1.6.2';
   ```
4. **`package.json`** — set `"version"`:
   ```json
   { "version": "1.6.2" }
   ```
5. **`index.html`** footer text:
   ```html
   <small>v1.6.2 &middot; PWA</small>
   ```

`CACHE_NAME` must always equal `'comic-creator-v' + version.json.version`. `APP_VERSION` must always equal `version.json.version`. A mismatch will cause test failures and wrong UI version display.

---

## Architecture

### Script Loading Order (Critical)

`index.html` loads scripts via `<script>` tags in this exact order — **all are global IIFEs**:

1. `js/utils.js` → shared globals `escHtml()`, `timeAgo()`, `getGenreEmoji()`, `GENRES`
2. `js/db.js` → global `DB` (IndexedDB wrapper) — depends on `js/utils.js`
3. `js/api.js` → global `API` (NanoGPT client) — depends on `DB`
4. `js/pages/home.js` → global `HomePage`
5. `js/pages/characters.js` → global `CharactersPage`
6. `js/pages/worlds.js` → global `WorldsPage`
7. `js/pages/create.js` → global `CreatePage`
8. `js/pages/library.js` → global `LibraryPage`
9. `js/pages/presets.js` → global `PresetsPage`
10. `js/pages/settings.js` → global `SettingsPage`
11. `js/app.js` → global `App` (SPA router) — depends on all above

**If you add a new script, it must be added as a `<script>` tag in `index.html` AND to the `STATIC_ASSETS` array in `sw.js`.** CI tests enforce this. If load order matters (e.g., new shared utils), place it before the modules that use it.

### Page Module Pattern

Every page module in `js/pages/` is a global IIFE that returns an object. Required and optional methods:

- `render(param)` — **required** — returns HTML string. Called by `App.navigate()`.
- `postRender(param)` — optional — runs after innerHTML is set (for async init like model fetching).
- `onMount(param)` — optional — runs after `postRender` completes (always called if present, independent of postRender).
- `onUnmount()` — optional — cleanup when navigating away.

The router in `js/app.js` registers all page modules in its `pages` map. Add new pages there and in the navigation HTML in `index.html`.

### Key Globals and Shared Functions

| Global | Defined in | Purpose |
|--------|-----------|---------|
| `DB` | `js/db.js` | IndexedDB CRUD: `getAll`, `get`, `put`, `del`, `getByIndex`, `uuid`, `getSetting`, `setSetting`, `fileToDataURL`, `seedDefaults` |
| `API` | `js/api.js` | `chatCompletion`, `chatCompletionStream`, `generateImage`, `buildSystemPrompt`, `parseComicResponse`, `fetchTextModels`, `fetchImageModels`, `BASE_URL` |
| `App` | `js/app.js` | `navigate(page, param)`, `refreshPage()`, `showModal(html)`, `hideModal()`, `toast(msg, type)` |
| `escHtml(str)` | `js/utils.js` | HTML-escapes a string. **Always use before inserting user data into HTML.** |
| `timeAgo(ts)` | `js/utils.js` | Formats a timestamp as relative time. |
| `GENRES` | `js/utils.js` | Array of genre objects (`{id, name, emoji}`). |

### Data Model

IndexedDB database: `ComicCreatorDB`. Six object stores:

| Store | keyPath | Indexes | Description |
|-------|---------|---------|-------------|
| `characters` | `id` | — | Character profiles (name, role, description, appearance, backstory, powers, imageData) |
| `worlds` | `id` | — | World settings (name, description, era, atmosphere, details, images[]) |
| `comics` | `id` | `createdAt` | Comic metadata (title, genre, character/world/preset refs, pageCount, conversation history) |
| `pages` | `id` | `comicId` | Comic pages (pageNumber, panel data with narration/imagePrompt/dialogue, choices) |
| `presets` | `id` | — | Prompt presets (name, systemPrompt, temperature, topP, maxTokens) |
| `settings` | `key` | — | Key-value pairs (apiKey, model, imageModel, temperature, etc.) |

### API Integration

- Base URL: `https://nano-gpt.com/api/v1`
- Endpoints: `/chat/completions` (text, streaming SSE), `/images/generations` (images), `/models?detailed=true` (text model list), `/image-models?detailed=true`
- Auth: Bearer token from `settings.apiKey`
- Model lists are cached in IndexedDB for 6 hours

---

## File Reference

```
index.html              (114 lines)  App shell — topbar, sidebar nav, bottom nav, modal, toast container, script tags
manifest.json           (32 lines)   PWA manifest — standalone, portrait, dark theme (#0a0a1a)
sw.js                   (82 lines)   Service worker — CACHE_NAME='comic-creator-v1.6.2', cache-first for app shell, network-only for nano-gpt.com
version.json            (4 lines)    {"version":"1.6.2","updated":"2026-03-02"}
server.sh               (111 lines)  Termux dev server launcher (auto-detects python3/npx/php/busybox)
update.sh               (172 lines)  Termux update script (git pull + sw cache bust)
generate-icons.html                  Browser utility to generate PWA PNG icons from the SVG
css/app.css             (944 lines)  All styles — dark theme, mobile-first responsive, component styles
js/utils.js             (62 lines)   Shared pure helpers — escHtml, timeAgo, getGenreEmoji, GENRES
js/db.js                (194 lines)  IndexedDB wrapper — open, CRUD, uuid, settings helpers, seed defaults
js/api.js               (465 lines)  NanoGPT client — streaming SSE, image gen, system prompt builder, JSON parser, model fetching with fallback lists
js/app.js               (294 lines)  SPA router — hash-based navigation, sidebar/bottomnav, modal, toast, SW registration
js/pages/home.js        (93 lines)   Dashboard — stats, recent comics, genre grid
js/pages/characters.js  (198 lines)  Character CRUD — list, create/edit form, image upload, delete
js/pages/worlds.js      (215 lines)  World CRUD — list, create/edit form, multi-image upload, delete
js/pages/create.js      (903 lines)  Comic generation engine — setup wizard, SSE streaming, panel rendering, branching choices
js/pages/library.js     (512 lines)  Comic viewer — list, page reader, PDF export (opens print dialog with styled HTML)
js/pages/presets.js     (214 lines)  Preset editor — list, create/edit form, sampler parameter sliders
js/pages/settings.js    (680 lines)  Settings — API key, model selection modal, image config, sampler defaults, data export/import/clear, update checker
icons/                               icon.svg, icon-192.png, icon-512.png
```

---

## Why No Build Step?

The "no build step" constraint is a deliberate, load-bearing architectural decision — not an oversight or laziness. Here is why it exists and why it should be preserved:

1. **Primary environment is Termux on Android.** The app is explicitly designed to run on resource-constrained Android phones using Termux. Running a full build pipeline (webpack, Vite, Parcel, etc.) requires significant CPU, memory, and disk I/O that a phone may struggle with. The install and update workflow (`install.sh`, `update.sh`) only requires `git` and a basic HTTP server — both trivially available in Termux via `pkg install git python`.

2. **`git pull` → serve is the entire update workflow.** `update.sh` performs `git pull`, bumps the service worker cache name, and restarts the server. Inserting a build step here means mobile users must also wait for `npm install && npm run build` on a phone CPU — a frustrating experience that breaks the self-update model.

3. **Any static HTTP server is sufficient.** `python3 -m http.server 8080`, `npx serve`, `php -S`, and `busybox httpd` can all serve this app identically. This maximizes portability across environments (Termux, GitHub Pages, any CDN, any home server) without needing a Node.js toolchain present at the serving host.

4. **Immediate edit-refresh cycle.** Contributors can change any `.js` or `.css` file and see the result with a single browser refresh — no re-bundling, no source map confusion, no stale cache from a build artifact. This is especially valuable when working on a phone.

5. **ES2020+ is broadly supported.** Modern browsers support optional chaining, nullish coalescing, `async/await`, `crypto.randomUUID`, and ES modules natively. There is no transpilation required for the target runtime (Chrome/Brave on Android, released 2020+), so a bundler adds friction without adding capability.

**When would a build step be justified?** If the codebase grows to a size where HTTP/2 multiplexing no longer compensates for script count, or if TypeScript type safety becomes necessary for reliability, a build step could be introduced. That decision should be explicit and deliberate — not a side-effect of adopting a library that happens to require one.

---

## Why Vanilla JavaScript?

The "no framework" constraint is a deliberate choice with real benefits, and also real tradeoffs. Here is an honest account of both, and where the line sits.

### Why it's the right call for this project

1. **Zero runtime dependency surface.** There is no React, Vue, or Angular to version-bump, patch for security advisories, or break on a major release. The app's only external runtime dependency is the browser itself — which is already present on every target device.

2. **Instant load, no framework bootstrap cost.** Frameworks carry initialization overhead (virtual DOM setup, reactivity system wiring, hydration, etc.). On a mid-range Android phone — the primary target device — eliminating that overhead produces a measurably faster first-meaningful-paint.

3. **Total transparency.** Every line of code that runs in the browser is code a contributor wrote. There is no intermediate layer to reason through when debugging. When something breaks in `create.js`, the stack trace points to `create.js` — not to a framework internal.

4. **Trivial offline caching.** The service worker caches a fixed list of known static files. With a framework, bundled filenames are often content-hashed (e.g., `main.a1b2c3.js`), which complicates the cache manifest. Vanilla JS files have stable, human-readable names that the service worker list in `sw.js` can reference directly.

5. **Aligned with the no-build-step constraint.** Virtually every popular JavaScript framework assumes a build pipeline. Adopting one would immediately pull in bundler requirements, defeating the Termux-friendly update workflow described in "Why No Build Step?" above.

### Honest tradeoffs

Vanilla JS genuinely does make some things harder as the codebase grows:

- **State management** — Without a reactive system, keeping the UI in sync with app state requires careful manual DOM updates. The current `CreatePage` state machine in `js/pages/create.js` already shows the strain of managing complex state by hand. If the page count or branching logic grows significantly, a lightweight reactive approach (even a hand-rolled one) will become necessary.
- **Component reuse** — The current HTML-string templating pattern (`render()` returning a string) makes it awkward to share UI fragments across pages without copy-pasting. Adding a small shared-template helper to `js/utils.js` is the appropriate response — not adopting a framework.
- **Type safety** — No TypeScript means type errors surface at runtime rather than at edit time. JSDoc annotations can provide editor intelligence without a build step and are worth adding to public module APIs.

### Will it hold the project back?

Not at the current scale (~5,000 lines, 11 JS modules, one app). The IIFE module pattern, strict use of `escHtml()`, and the `render()` / `postRender()` / `onMount()` lifecycle convention give the codebase the structure of a framework without the dependency weight.

The point where vanilla JS becomes a genuine ceiling is if the project needs to:
- Support **concurrent/parallel rendering** (multiple independent comic panels rendering simultaneously)
- Introduce **real-time collaboration** (shared state across users)
- Scale to **dozens of page modules** where tracking load order in `index.html` by hand becomes error-prone

None of those apply today. When one does, the migration path is **native ES modules** (supported in every target browser, no bundler required) rather than a framework — this preserves the no-build-step constraint while unlocking proper dependency graphs and tree-shaking.

---

## Code Style

- **Vanilla browser runtime** — the app runs directly in the browser with no build step
- **ES2020+ syntax** — optional chaining (`?.`), nullish coalescing (`??`), `async/await`
- **Global IIFE pattern** — all files use `const X = (() => { ... })()` for encapsulation and script-tag compatibility. Do **not** use ES module `import`/`export`.
- **HTML escaping** — always use `escHtml()` (defined in `js/utils.js`) when interpolating user data into HTML strings
- **Inline event handlers** — `onclick="ModuleName.method()"` in template literals is standard. Do not switch to `addEventListener` unless the existing code already uses it in that context.
- **`async/await`** throughout — no `.then()` chains unless existing code uses them
- **No `var`** — use `const` / `let`
- **Self-contained pages** — each `js/pages/*.js` handles its own rendering, event binding, and data operations
- Keep the `render()` function returning an HTML template string; put post-DOM logic in `postRender()`/`onMount()`
- **Dark theme CSS** — all styles live in `css/app.css`. Use existing CSS custom properties (`--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-hover`, etc.). Do not add inline `style` attributes for colors.

---

## Testing

Automated test infrastructure:
- `npm run check-syntax` — JS syntax check across all source files
- `npm test` — `node --test test/*.test.js` — unit and integrity tests
- `npm run lint` — ESLint
- GitHub Actions `Tests` workflow (`.github/workflows/tests.yml`) on every push/PR

Test files in `test/`: `api-integration.test.js`, `api-pure.test.js`, `config-integrity.test.js`, `db.test.js`, `pure-functions.test.js`, `utils.test.js`.

**Manual QA steps:**
1. Start the server: `python3 -m http.server 8080`
2. Open `http://localhost:8080` in Chrome/Brave
3. Set your NanoGPT API key in Settings
4. Exercise all pages: Characters, Worlds, Presets, Create, Library
5. Generate a full comic end-to-end (at least 2 pages)
6. Test PDF export from the Library page
7. Verify offline mode: disconnect network, reload, confirm app loads from cache

---

## Common Patterns

### Adding a new page

1. Create `js/pages/newpage.js` with the IIFE pattern exporting at minimum `render(param)`.
2. Add a `<script src="js/pages/newpage.js"></script>` tag in `index.html` (before `js/app.js`).
3. Register in `app.js`: add to the `pages` object and `pageTitles` object.
4. Add navigation links in `index.html` (sidebar `<li>` and/or bottom nav `<button>`).
5. Add the new JS file to `STATIC_ASSETS` in `sw.js` and bump the version across all five locations.

### Adding a new IndexedDB store

1. Increment `DB_VERSION` in `js/db.js`.
2. Add the store name to the `STORES` constant.
3. Add `d.createObjectStore(...)` in the `onupgradeneeded` handler.

### Modifying the system prompt

Edit `API.buildSystemPrompt()` in `js/api.js`. The function is pure and has no side effects.

### Adding a new setting

Use `DB.setSetting('myKey', value)` to write and `DB.getSetting('myKey', defaultValue)` to read. No schema change needed — the settings store uses a flexible key-value design.

---

## Environment & Deployment

- Designed for **Termux on Android** as primary environment, but works in any modern browser.
- No environment variables, no secrets in source. API key is entered by the user at runtime and stored in IndexedDB.
- Static files only — deploy to any HTTP server, CDN, or GitHub Pages.
- To update: `./update.sh` (bumps the service worker cache name automatically after `git pull`).
