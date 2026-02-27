# CLAUDE.md

Trust these instructions. Only search the codebase if the information here is incomplete or found to be incorrect.

## Project Summary

AI Comic Creator — a vanilla JavaScript Progressive Web App (PWA) that generates AI-powered comic books with interactive narratives, custom characters, and world-building. Uses the NanoGPT API (OpenAI-compatible) for text and image generation.

- **~4,000 lines of code** across 22 files (10 JS, 1 CSS, 1 HTML, plus config/scripts)
- **Zero dependencies** — no npm, no package.json, no bundler, no transpiler, no frameworks
- **No CI/CD pipelines** — no `.github/workflows`, no pre-commit hooks, no linters configured
- **No automated tests** — validation is manual (see Validation section below)
- **Runtime:** Any modern browser (ES2020+). Server is any static HTTP server.

## Running Locally

Always start the dev server from the repo root:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Verified working with Python 3.11. No install or build step is required.

Alternative servers (all verified working):
```bash
npx serve -s -l 8080      # Node.js
php -S 0.0.0.0:8080       # PHP
```

`server.sh` is a Termux-specific launcher script (shebang: `/data/data/com.termux/files/usr/bin/bash`). It auto-detects available HTTP servers and generates placeholder PNG icons if missing. Use `PORT=3000 ./server.sh` for a custom port.

## Validation

There are no automated tests, linters, or CI checks. Always validate changes manually:

1. **Syntax check** — run `node --check <file.js>` on every JS file you modify. All 10 JS files currently pass.
2. **Serve and load** — start the dev server, open `http://localhost:8080`, and confirm the app loads without console errors.
3. **Service worker** — if you modify any cached file, bump `CACHE_NAME` in `sw.js` to match the new version (e.g. `'comic-creator-v1.3.0'`). Hard-refresh (`Ctrl+Shift+R`) to bypass cache during development.
4. **Page navigation** — click through all 7 pages (Home, Characters, Worlds, Create, Library, Presets, Settings) to verify no render errors.

## Version Management

**Every merge to `master` must bump both of these files:**

1. **`version.json`** — increment the version (semver `MAJOR.MINOR.PATCH`) and update `updated`:
   ```json
   { "version": "1.3.0", "updated": "2026-03-01" }
   ```
2. **`sw.js`** — set `CACHE_NAME` to `'comic-creator-v{new version}'`:
   ```js
   const CACHE_NAME = 'comic-creator-v1.3.0';
   ```

`CACHE_NAME` must always equal `'comic-creator-v' + version.json.version`. This allows `update.sh` to correctly write the matching cache name after `git pull`, forcing users' browsers to load the updated app shell.

## Architecture

### Script Loading Order (Critical)

`index.html` loads scripts via `<script>` tags in this exact order — **all are global IIFEs, not ES modules**:

1. `js/db.js` → global `DB` (IndexedDB wrapper)
2. `js/api.js` → global `API` (NanoGPT client) — depends on `DB`
3. `js/pages/home.js` → global `HomePage`, **also defines shared globals `escHtml()`, `timeAgo()`, `getGenreEmoji()`, `GENRES`** used by all other page modules
4. `js/pages/characters.js` → global `CharactersPage`
5. `js/pages/worlds.js` → global `WorldsPage`
6. `js/pages/create.js` → global `CreatePage`
7. `js/pages/library.js` → global `LibraryPage`
8. `js/pages/presets.js` → global `PresetsPage`
9. `js/pages/settings.js` → global `SettingsPage`
10. `js/app.js` → global `App` (SPA router) — depends on all above

**If you add a new script, it must be added as a `<script>` tag in `index.html` AND to the `STATIC_ASSETS` array in `sw.js`.** If load order matters (e.g., new shared utils), place it before the modules that use it.

### Page Module Pattern

Every page module in `js/pages/` is a global IIFE that returns an object. Required and optional methods:

- `render(param)` — **required** — returns HTML string. Called by `App.navigate()`.
- `postRender(param)` — optional — runs after innerHTML is set (for async init like model fetching).
- `onMount(param)` — optional — runs after postRender (for event binding).
- `onUnmount()` — optional — cleanup when navigating away.

The router in `js/app.js` references page modules by name in its `pages` map (line 8). If adding a new page, register it there and in the navigation HTML in `index.html`.

### Key Globals and Shared Functions

| Global | Defined in | Purpose |
|--------|-----------|---------|
| `DB` | `js/db.js` | IndexedDB CRUD: `getAll`, `get`, `put`, `del`, `getByIndex`, `uuid`, `getSetting`, `setSetting`, `fileToDataURL`, `seedDefaults` |
| `API` | `js/api.js` | `chatCompletion`, `chatCompletionStream`, `generateImage`, `buildSystemPrompt`, `parseComicResponse`, `fetchTextModels`, `fetchImageModels`, `BASE_URL` |
| `App` | `js/app.js` | `navigate(page, param)`, `refreshPage()`, `showModal(html)`, `hideModal()`, `toast(msg, type)` |
| `escHtml(str)` | `js/pages/home.js:105` | HTML-escapes a string. Used throughout all page modules. |
| `timeAgo(ts)` | `js/pages/home.js:112` | Formats a timestamp as relative time. |
| `GENRES` | `js/pages/home.js:92` | Array of 9 genre objects (`{id, name, emoji, desc}`). |

### Data Model

IndexedDB database: `ComicCreatorDB`, version `1`. Six object stores:

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
- Endpoints: `/chat/completions` (text, streaming via SSE), `/images/generations` (images), `/models?detailed=true` (model list, no auth), `/image-models?detailed=true`
- Auth: Bearer token from `settings.apiKey`
- Model responses are cached in IndexedDB for 6 hours

## File Reference

```
index.html              (97 lines)   App shell — topbar, sidebar nav, bottom nav, modal, toast container, script tags
manifest.json           (32 lines)   PWA manifest — standalone, portrait, dark theme (#0a0a1a)
sw.js                   (79 lines)   Service worker — CACHE_NAME='comic-creator-v4', caches STATIC_ASSETS, cache-first for app shell, network-only for nano-gpt.com
version.json            (4 lines)    {"version":"1.2.0","updated":"2026-02-27"}
server.sh               (111 lines)  Termux dev server launcher (auto-detects python3/npx/php/busybox)
update.sh               (172 lines)  Termux update script (git pull + sw cache bust)
generate-icons.html                  Browser utility to generate PWA PNG icons from the SVG
css/app.css             (811 lines)  All styles — dark theme, mobile-first responsive, component styles
js/db.js                (171 lines)  IndexedDB wrapper — open, CRUD, uuid, settings helpers, seed defaults
js/api.js               (376 lines)  NanoGPT client — streaming SSE, image gen, system prompt builder, JSON parser, model fetching with fallback lists
js/app.js               (197 lines)  SPA router — hash-based navigation, sidebar/bottomnav, modal, toast, SW registration
js/pages/home.js        (128 lines)  Dashboard — stats, recent comics, genre grid. Also: escHtml, timeAgo, GENRES globals
js/pages/characters.js  (196 lines)  Character CRUD — list, create/edit form, image upload, delete
js/pages/worlds.js      (213 lines)  World CRUD — list, create/edit form, multi-image upload, delete
js/pages/create.js      (576 lines)  Comic generation engine — setup wizard, SSE streaming, panel rendering, branching choices
js/pages/library.js     (239 lines)  Comic viewer — list, page reader, PDF export (opens print dialog with styled HTML)
js/pages/presets.js     (208 lines)  Preset editor — list, create/edit form, sampler parameter sliders
js/pages/settings.js    (591 lines)  Settings — API key, model selection modal, image config, sampler defaults, data export/import/clear, update checker
icons/                               icon.svg, icon-192.png, icon-512.png
```

## Code Style Rules

- **Vanilla JS only** — no frameworks, no libraries, no CDN imports, no npm packages
- **ES2020+ syntax** — optional chaining (`?.`), nullish coalescing (`??`), `async/await`
- **No ES modules** — all files use global IIFE pattern (`const X = (() => { ... })()`)
- **HTML escaping** — always use `escHtml()` when interpolating user data into HTML strings
- **Self-contained pages** — each `js/pages/*.js` handles its own rendering, event binding, and data operations
- Keep the `render()` function returning an HTML template string; put post-DOM logic in `postRender()`/`onMount()`
