# Test Coverage Analysis: AI Comic Creator

## Current State

The codebase has automated checks and tests:
- `npm run check-syntax`
- `npm run lint`
- `npm test` (`node --test test/*.test.js`)
- `npm run test:e2e` (Playwright; automatically starts or reuses a local server via `python3 -m http.server 8080` — requires Python 3)
- GitHub Actions workflows: `tests.yml` (push + pull_request), `playwright.yml` (push + pull_request)

Remaining quality gaps are primarily richer browser-level integration and end-to-end scenario coverage beyond the existing smoke tests.

---

## Priority 1: Pure Functions (Highest Value, Easiest to Test)

These functions have no side effects and no DOM dependencies. They can be tested with any runner, including plain Node.js assertions.

### `parseComicResponse()` — `js/api.js:218-256`

Parses unpredictable LLM output into structured comic page JSON. Handles markdown code fences, JSON boundary detection, missing fields, and malformed responses. A regression here silently breaks all comic generation.

**Test cases needed:**
- Valid JSON with all fields populated
- JSON wrapped in `` ```json ... ``` `` code fences
- JSON with extra text before/after the object
- Response using `image_prompt` instead of `imagePrompt` (alternate field name, line 242)
- Missing `title`, `panels`, `choices`, `dialogue` fields (default value handling)
- Completely unparseable text → should return `null`
- Empty string input
- Nested objects with missing `speaker`/`text` fields

### `buildSystemPrompt()` — `js/api.js:166-213`

Constructs multi-section prompts from characters, worlds, and genres. String assembly bugs produce subtly wrong AI behavior.

**Test cases needed:**
- No characters, no world
- Multiple characters with all optional fields
- Character with only name and description
- World with and without `details` field
- Custom system prompt override (should replace base, not append)

### `escHtml()` — `js/utils.js`

XSS prevention function used on every user-facing string. A bug here is a **security vulnerability**. (Previously defined in `js/pages/home.js`; moved to `js/utils.js`.)

**Test cases needed:**
- Strings containing `<`, `>`, `&`, `"`, `'`
- Empty string / null / undefined input
- Strings with nested HTML tags
- Script injection attempts

### `timeAgo()` — `js/utils.js`

Relative time formatting with boundary conditions. (Previously defined in `js/pages/home.js`; moved to `js/utils.js`.)

**Test cases needed:**
- Timestamps < 1 minute ago → "just now"
- Timestamps at 1 minute, 59 minutes → "Xm ago"
- Timestamps at 1 hour, 23 hours → "Xh ago"
- Timestamps at 1 day, 29 days → "Xd ago"
- Timestamps at 30+ days → formatted date
- `null` / `undefined` / `0` input

### `extractProvider()` — `js/pages/settings.js`

20+ prefix-matching rules to classify model IDs into provider names.

**Test cases needed:**
- Models with `owned_by` field set
- Models with slash-separated IDs (e.g., `openai/gpt-4o`)
- Each prefix rule: `gpt-*`, `claude*`, `gemini*`, `llama*`, etc.
- Unknown model ID → "Other"

### `uuid()` — `js/db.js:89-95`

Fallback UUID generation when `crypto.randomUUID` is unavailable.

**Test cases needed:**
- Output matches UUID v4 format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
- The version nibble is always `4`
- The variant bits are correct (8, 9, a, or b)
- Uniqueness over multiple calls

---

## Priority 2: Data Layer (`js/db.js`)

The IndexedDB wrapper is the foundation of all persistence. Use `fake-indexeddb` to test in Node.js.

| Function | What to Test |
|---|---|
| `getAll()` | Returns all records; empty store returns `[]` |
| `get()` | Returns record by ID; missing ID returns `undefined` |
| `put()` | Creates and updates records; returns the key |
| `del()` | Removes records; deleting nonexistent key doesn't throw |
| `getByIndex()` | Queries pages by `comicId`; returns `[]` for unknown values |
| `seedDefaults()` | Creates exactly 3 presets on first run; is idempotent |
| `getSetting()` | Returns default value for missing keys |
| `setSetting()` | Stores and retrieves key-value pairs correctly |

---

## Priority 3: API Client (`js/api.js`)

Requires `fetch` mocking.

### SSE Stream Parsing (`chatCompletionStream`, lines 95-127)

The manual `ReadableStream` + line-based SSE parser has subtle edge cases:
- Partial chunks split across reads
- `[DONE]` sentinel handling
- Non-JSON frames (pricing metadata) — must not throw
- Empty lines between data frames
- Multiple `data:` lines in a single chunk

### Error Handling Paths

Lines 51-53, 90-93, 154-157 each handle API errors. The `res.json().catch(() => ({}))` pattern could mask useful error messages.

### Model Caching (`fetchTextModels` / `fetchImageModels`)

6-hour TTL cache with expired-cache-fallback. Test all four paths:
1. Cache hit (fresh) → return cached
2. Cache miss → fetch + cache
3. Cache expired + API success → fetch + update cache
4. Cache expired + API failure → return stale cache
5. No cache + API failure → return fallback list

### Parameter Merging

`chatCompletion()` uses nullish coalescing (`??`) to merge options with defaults. Verify that explicit `0` values are preserved (not replaced by defaults).

---

## Priority 4: State Management (`js/pages/create.js`)

### State Machine Transitions

The comic creation flow has three states (`setup` → `generating` → `reading`) with several transitions. Test that:
- `startGenerating()` validates genre is selected
- `resetState()` clears all 11 state properties completely
- `toggleCharacter()` correctly adds/removes from the array
- `makeChoice()` appends correct user message to conversation history
- `renderResume()` handles comics with no pages or missing conversation history

### Parameter Override Bug

In `generatePage()` (lines 410-413), truthy checks like `if (!state.overrideTemp)` treat `0` as falsy. A temperature of `0` would be silently replaced by the preset value. **This is a real bug.**

---

## Priority 5: Data Import/Export (`js/pages/settings.js`)

| Function | What to Test |
|---|---|
| `exportData()` | Output JSON contains all 5 stores + timestamp |
| `importData()` | Handles missing stores, extra fields, empty arrays, malformed JSON |
| `confirmClear()` | Deletes from 5 stores; verify settings store is/isn't included (API key preservation) |

---

## Priority 6: Navigation & Lifecycle (`js/app.js`)

| Area | What to Test |
|---|---|
| `navigate()` | Routes to valid pages; ignores invalid page names |
| Deep linking | Handles `#create`, empty hash, and unknown hash values |
| `onUnmount` error isolation | Navigation continues even if `onUnmount` throws |
| Page lifecycle ordering | `onUnmount(old)` → render → `postRender` → `onMount` |

---

## Bugs Found During Analysis

All three bugs identified in the original analysis have since been fixed.

### ~~1. Missing Brace in `js/app.js`~~ *(Fixed)*

The `onMount` block is now correctly outside the `postRender` check, so pages without `postRender` still have `onMount` called.

### ~~2. Duplicate `fetchTextModels` in `js/api.js`~~ *(Fixed)*

The duplicate definition has been removed. There is now a single `fetchTextModels` implementation with caching.

### ~~3. Dual `return` in `js/pages/settings.js`~~ *(Fixed)*

The settings module now has a single return statement exporting all public API surface.

---

## Recommended Test Infrastructure

Existing infrastructure:
1. **Unit/integration tests**: `test/*.test.js` with Node.js built-in `node:test` / `node:assert`
2. **IndexedDB mocking**: `fake-indexeddb` (dev dependency)
3. **E2E tests**: Playwright in `test/e2e/smoke.spec.js` using Chromium, served via `python3 -m http.server 8080`

Still needed:
4. **Fetch mocking in unit tests**: Simple stub function for deeper API client coverage
5. **DOM testing**: `jsdom` or a browser-based test page for page-level rendering assertions
