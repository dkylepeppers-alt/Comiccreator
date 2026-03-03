# Copilot Instructions — AI Comic Creator

## Project Overview

AI Comic Creator is a **vanilla JavaScript Progressive Web App (PWA)** that generates AI-powered comic books with interactive narratives, custom characters, and world-building. It uses the NanoGPT API (OpenAI-compatible endpoint at `https://nano-gpt.com/api/v1`) for both text (streaming SSE) and image generation.

**Current version:** 1.6.2

---

## Development Guidelines

- **ES2020+ syntax** is fine (optional chaining `?.`, nullish coalescing `??`, `async/await`, `crypto.randomUUID`).
- **Module pattern:** All JS files use the IIFE module pattern (`const FooModule = (() => { ... return { ... }; })()`). Do **not** convert to ES module `import`/`export` syntax.
- Automated checks exist via npm scripts (`check-syntax`, `test`, `lint`) and a GitHub Actions workflow (`.github/workflows/tests.yml`).

---

## File Structure

```
index.html              App shell — all pages are rendered into <main id="content">
manifest.json           PWA manifest
sw.js                   Service worker (cache-first, CACHE_NAME = 'comic-creator-v1.6.2')
version.json            { "version": "1.6.2", "updated": "..." }
server.sh               Local dev server (python3 -m http.server 8080)
update.sh               Termux update helper (git pull + cache bust)
generate-icons.html     Browser-based icon generator utility
css/app.css             All styles (dark theme, mobile-first, single file)
js/
  db.js                 IndexedDB wrapper — DB module
  api.js                NanoGPT API client — API module
  app.js                SPA router, navigation, modal, toast — App module
  pages/
    home.js             Dashboard — HomePage module
    characters.js       Character CRUD — CharactersPage module
    worlds.js           World CRUD — WorldsPage module
    create.js           Comic generation engine — CreatePage module
    library.js          Comic viewer + PDF export — LibraryPage module
    presets.js          Prompt preset editor — PresetsPage module
    settings.js         API config + data management — SettingsPage module
icons/
  icon.svg, icon-192.png, icon-512.png
```

---

## How to Run Locally

```bash
# Python (easiest)
python3 -m http.server 8080

# Or use the included helper
chmod +x server.sh && ./server.sh

# Node.js alternative
npx serve -s -l 8080
```

Open `http://localhost:8080`. Hard-refresh (`Ctrl+Shift+R`) to bypass the service worker cache during development.

---

## Core Modules

### `js/db.js` — `DB` module

IndexedDB wrapper. All persistence goes through here.

| Method | Description |
|--------|-------------|
| `DB.open()` | Opens the DB (called once at startup) |
| `DB.getAll(storeName)` | Returns all records |
| `DB.get(storeName, id)` | Returns one record by key |
| `DB.put(storeName, data)` | Upserts a record |
| `DB.del(storeName, id)` | Deletes a record |
| `DB.getByIndex(storeName, indexName, value)` | Index query (e.g. pages by comicId) |
| `DB.getSetting(key, default)` | Read from settings store |
| `DB.setSetting(key, value)` | Write to settings store |
| `DB.uuid()` | UUID v4 (uses `crypto.randomUUID` with fallback) |
| `DB.seedDefaults()` | Seeds 3 default presets on first run |
| `DB.fileToDataURL(file)` | Converts `File` object to base64 data URL |

**Object stores:**

| Store | Key | Contents |
|-------|-----|----------|
| `characters` | `id` (uuid) | name, role, description, appearance, backstory, powers, image |
| `worlds` | `id` (uuid) | name, description, era, atmosphere, details, images (up to 3) |
| `comics` | `id` (uuid) | title, genre, genreName, characterIds, worldId, presetId, pageCount, conversationHistory, createdAt, updatedAt, finished |
| `pages` | `id` (uuid), indexed by `comicId` | comicId, pageNum, data (panels+choices+title), createdAt |
| `presets` | `id` (uuid) | name, description, temperature, topP, maxTokens, systemPrompt, createdAt |
| `settings` | `key` (string) | value (any) — stores apiKey, model, imageModel, temperature, topP, maxTokens, enableImages, imageSize, updateRepo, cached model lists |

### `js/api.js` — `API` module

NanoGPT API client. BASE_URL = `https://nano-gpt.com/api/v1`.

| Method | Description |
|--------|-------------|
| `API.chatCompletion(messages, options)` | Non-streaming POST to `/chat/completions` |
| `API.chatCompletionStream(messages, onChunk, options)` | SSE streaming; `onChunk(chunk, fullText)` called per delta |
| `API.generateImage(prompt, options)` | POST to `/images/generations`; returns URL or base64 |
| `API.buildSystemPrompt(genre, characters, world, customPrompt)` | Assembles the LLM system prompt |
| `API.parseComicResponse(text)` | Parses LLM JSON output into `{title, panels[], choices[]}` — handles markdown fences and missing fields |
| `API.fetchTextModels(forceRefresh)` | Lists text models from `/models?detailed=true`; 6-hour IndexedDB cache |
| `API.fetchImageModels(forceRefresh)` | Lists image models from `/image-models?detailed=true`; 6-hour cache |
| `API.getApiKey()` | Reads from settings |
| `API.getModel()` | Reads from settings (default: `gpt-4o-mini`) |
| `API.FALLBACK_TEXT_MODELS` | Array of fallback model IDs used when API is unreachable |
| `API.FALLBACK_IMAGE_MODELS` | Array of fallback image model IDs |

**Comic page JSON schema** (returned by `parseComicResponse`):
```json
{
  "title": "Page title",
  "panels": [
    {
      "narration": "...",
      "imagePrompt": "...",
      "dialogue": [{ "speaker": "Name", "text": "..." }]
    }
  ],
  "choices": [{ "text": "...", "summary": "..." }]
}
```

### `js/app.js` — `App` module

SPA router and global UI helpers.

| Method | Description |
|--------|-------------|
| `App.navigate(page, param)` | Renders a page module; calls `onUnmount` on previous, `render(param)`, `postRender(param)`, `onMount(param)` |
| `App.refreshPage()` | Re-renders the current page |
| `App.showModal(html)` | Displays the global modal |
| `App.hideModal()` | Hides the modal |
| `App.toast(message, type)` | Shows a 3-second toast (`'info'`, `'success'`, `'error'`) |

Valid page names: `home`, `characters`, `worlds`, `create`, `library`, `presets`, `settings`.

**Page module interface** (all optional except `render`):
```js
const FooPage = (() => {
  async function render(param) { return '<html string>'; }
  function onMount(param) {}      // called after DOM update
  function postRender(param) {}   // called after DOM update (legacy)
  function onUnmount() {}         // called before navigating away
  return { render, onMount, onUnmount };
})();
```

### `js/pages/create.js` — `CreatePage` module

The core comic generation state machine. State transitions: `setup` → `generating` → `reading`.

Key state fields: `step`, `genre`, `selectedCharacters[]`, `selectedWorld`, `selectedPreset`, `comicId`, `title`, `pages[]`, `conversationHistory[]`, `isGenerating`, `overrideTemp`, `overrideTopP`, `overrideTokens`, `overrideSystem`.

Key methods exposed: `selectGenre(id)`, `toggleCharacter(id)`, `selectWorld(id)`, `selectPreset(id)`, `startGenerating()`, `makeChoice(idx)`, `continueStory()`, `finishComic()`, `resetState()`, `toggleAdvanced(el)`.

### `js/pages/settings.js` — `SettingsPage` module

Handles API key, model selection (dynamic model picker with search), default sampler params, image settings, data export/import/clear, and in-app version check.

Settings keys used: `apiKey`, `model`, `imageModel`, `temperature`, `topP`, `maxTokens`, `enableImages`, `imageSize`, `updateRepo`.

---

## Coding Conventions

1. **IIFE modules only** — `const ModuleName = (() => { ... return { publicApi }; })();`
2. **Template literals for HTML** — page `render()` returns an HTML string; no virtual DOM.
3. **Inline event handlers** — `onclick="ModuleName.method()"` in the HTML string is standard. Do not switch to `addEventListener` unless the existing code already uses it in that context.
4. **`escHtml(str)`** — A global XSS-prevention helper available everywhere (defined in `js/pages/home.js`). Always use it before inserting user data into HTML strings.
5. **`async/await`** throughout — no `.then()` chains unless the existing code uses them.
6. **No `var`** — use `const` / `let`.
7. **Dark theme CSS** — all styles live in `css/app.css`. Use existing CSS custom properties (`--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-hover`, etc.). Do not add `style` attributes for colors; use existing classes.

---

## Service Worker Cache

`sw.js` caches the app shell under `CACHE_NAME = 'comic-creator-v1.6.2'`. **Whenever you modify any cached asset** (any file listed in `STATIC_ASSETS`), bump the `CACHE_NAME` version string to match the new `version.json` version (e.g. `'comic-creator-v1.6.2'`) to force cache invalidation on existing installs.

**Every merge to `master` must bump both of these files:**
1. **`version.json`** — increment `version` (semver `MAJOR.MINOR.PATCH`) and update the `updated` date.
2. **`sw.js`** — set `CACHE_NAME` to `'comic-creator-v{new version}'` (e.g. `'comic-creator-v1.6.2'`).

`CACHE_NAME` must always equal `'comic-creator-v' + version.json.version`. This allows `update.sh` to correctly write the matching cache name after `git pull`, forcing users' browsers to load the updated app shell.

---

## Testing

Automated test infrastructure exists:
- `npm run check-syntax`
- `npm test` (`node --test test/*.test.js`)
- GitHub Actions `Tests` workflow (`.github/workflows/tests.yml`) on push/PR

The `TEST_COVERAGE_ANALYSIS.md` file now focuses on remaining coverage gaps and next-priority test areas.

**Manual QA steps:**
1. Start the server: `python3 -m http.server 8080`
2. Open `http://localhost:8080` in Chrome/Brave
3. Set your NanoGPT API key in Settings
4. Exercise all pages: Characters, Worlds, Presets, Create, Library
5. Generate a full comic end-to-end (at least 2 pages)
6. Test PDF export from the Library page
7. Verify offline mode: disconnect network, reload, confirm app loads from cache

**Suggested next automation improvements (optional):**
1. Add a dedicated lint workflow job once the current browser-global ESLint config issues are resolved.
2. Add an end-to-end browser smoke test workflow (Playwright) for setup → create → library navigation.
3. Enable Dependabot and a weekly `npm audit` workflow for dependency hygiene.

---

## Known Bugs (from `TEST_COVERAGE_ANALYSIS.md`)

These exist in the codebase and should be kept in mind when making changes:

1. **`js/app.js` — Conditional execution bug**: `onMount` is gated inside the `typeof pages[page].postRender === 'function'` check, so pages without `postRender` never have `onMount` called.

2. **`js/api.js` — Duplicate `fetchTextModels`**: The function is defined twice; the second definition (with caching) shadows the first (dead code). The cached version is the one that actually runs.

3. **`js/pages/settings.js` — Dual `return` statement**: Two `return` statements exist at the bottom of the module. Only the first executes. The newer API surface (`onMount`, `onUnmount`, `togglePicker`, `filterModels`, `selectModel`, `refreshModels`) is not exported unless the first `return` is removed or merged.

4. **`js/pages/create.js` `generatePage()` — Falsy zero bug**: Inside `generatePage()`, code uses `if (!state.overrideTemp)` which treats a temperature of `0` as falsy, silently replacing it with the preset value.

---

## Common Patterns

### Adding a new page

1. Create `js/pages/newpage.js` with the IIFE pattern exporting at minimum `render(param)`.
2. Add a `<script src="js/pages/newpage.js"></script>` tag in `index.html` (before `js/app.js`).
3. Register in `app.js`: add to the `pages` object and `pageTitles` object.
4. Add navigation links in `index.html` (sidebar `<li>` and/or bottom nav `<button>`).
5. Add the new JS file to `STATIC_ASSETS` in `sw.js` and bump `CACHE_NAME`.

### Adding a new IndexedDB store

1. Increment `DB_VERSION` in `js/db.js`.
2. Add the store name to the `STORES` constant.
3. Add `d.createObjectStore(...)` in the `onupgradeneeded` handler.

### Modifying the system prompt

Edit `API.buildSystemPrompt()` in `js/api.js`. The function is pure and has no side effects.

### Adding a new setting

Use `DB.setSetting('myKey', value)` to write and `DB.getSetting('myKey', defaultValue)` to read. No schema change is needed — the settings store uses a flexible key-value design.

---

## Environment & Deployment

- Designed for **Termux on Android** as primary environment, but works in any browser.
- No environment variables, no secrets in source. API key is entered by the user at runtime and stored in IndexedDB.
- Static files only — deploy to any HTTP server, CDN, or GitHub Pages.
- To update: `./update.sh` (bumps the service worker cache name automatically).
