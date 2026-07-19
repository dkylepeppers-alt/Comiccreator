# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

AI Comic Creator: a fully client-side Progressive Web App (Vite + TypeScript ES modules, no framework) that generates
interactive AI comic books. There is no backend — all AI calls go directly from the browser to the NanoGPT API
(`https://nano-gpt.com/api/v1`), and all persistence is IndexedDB. The API key lives only in the user's browser and
must never be needed in CI or committed to the repo. The same build also ships as a native Android app via Capacitor.

## Commands

```bash
npm ci                  # install locked deps (Node 22 in CI)
npm run dev              # Vite dev server with hot reload
npm run build             # production build to dist/
npm run serve             # preview production build on port 8080
npm test                  # Vitest run (unit tests)
npm run test:watch         # Vitest watch mode
npm run coverage           # Vitest with coverage (60% lines / 55% branches minimum)
npm run test:e2e            # Playwright smoke tests (test/e2e/*.spec.js) against a preview build
npm run lint                # ESLint on src/js/
npm run lint:fix
npm run typecheck            # tsc --noEmit
npm run format / format:check # Prettier on src/**/*.{js,ts,css}
npm run check-syntax          # typecheck + build (quick CI-equivalent check)
```

Run a single Vitest file: `npx vitest run test/db.test.js`. Run a single Playwright spec:
`npx playwright test test/e2e/smoke.spec.js`.

Before opening a PR: build, lint, typecheck, format check, coverage, and relevant E2E tests should all pass — this
mirrors the required CI checks.

### Android

```bash
npm run build && npx cap sync android   # copy web assets into android/
cd android && ./gradlew assembleDebug    # requires Java 21 + Android SDK
```

`android/`'s `versionName`/`versionCode` are derived from `package.json` at build time. CI rebuilds the debug APK on
every merge to `main` (`android-build.yml`); it is a debug-signed build, not Play Store-ready.

## Versioning — do not bump manually

Every merge to `main` auto-bumps the patch version (`scripts/bump-version.sh`) across `package.json`,
`public/version.json`, and the `index.html` footer, via the Post-Merge Pipeline workflow. A pre-commit hook
(installed by `npm ci`'s `prepare` script via `scripts/install-hooks.sh`) blocks commits where these three version
strings disagree, and also `node --check`s staged `.js` files. Never edit version numbers by hand; if the hook
blocks you, run `scripts/bump-version.sh patch|minor|major`.

Deploy to GitHub Pages is triggered by completion of the Post-Merge Pipeline (so the published `version.json` always
matches what's deployed), not directly by the merge.

## Architecture

```
src/js/
  app.ts                    hash-based router, sidebar/bottom nav, modals, toasts, global error log, SW registration
  db.ts                      IndexedDB wrapper (DB singleton) — characters, worlds, comics, pages, presets,
                              imagePresets, settings stores; record migration/normalization; seeded defaults
  api.ts                     NanoGPT API client: chat completions (streaming), image generation, model listing
  visual-continuity.ts        pure domain module for anchored character/location identity across comic pages
  image-generation-config.ts  companion-model resolution and image-size compatibility for Seedream sequential mode
  generation-progress.ts      request timeouts and progress-event plumbing for image generation
  utils.ts                    shared helpers (escHtml, ID generation, image ref normalization, etc.)
  pages/                      one module per screen: home, characters, worlds, create, library, presets,
                              image-presets, settings — each exports render()/postRender()/onMount()/onUnmount()
```

`src/js/app.ts` owns a `pages` registry (`Record<string, PageModule>`) and a `navigate(page, param)` function that
awaits `render()`, injects the HTML into `#content`, then calls `postRender()` and `onMount()` on the incoming page
and `onUnmount()` on the outgoing one. Page modules are also attached to `window` (e.g. `window.CreatePage`) so
inline HTML `onclick` handlers in template strings can reach them — `src/js/global.d.ts` declares these globals.

**DB layer (`db.ts`)**: a single `IDBDatabase` behind a module-level `open()` promise; all reads/writes go through
`get`/`put`/`del`/`getAll`/`getByIndex` against named `STORES`. Schema upgrades happen in `onupgradeneeded`; the
current version (4) rewrites existing character/world records in-place during the versionchange transaction to
assign stable per-image UUIDs and explicit identity/location anchors (`normalizeCharacterRecord` /
`normalizeWorldRecord`) — this must stay synchronous IDB-cursor code, not promise-based, because it runs inside the
upgrade transaction. `commitPageAndComic()` writes a comic page and its parent comic record in one atomic
multi-store transaction so continuity state can never diverge from the page it describes.

**Visual continuity (`visual-continuity.ts`)**: pure, DB/network-free domain logic (fully unit-testable) governing
how character/location identity stays consistent across generated panels — an anchor image, a per-comic
`ComicVisualContinuity` ledger of mutable per-character state (wardrobe, hair, carried items, injuries), and
deterministic prompt compilation. `image-generation-config.ts` builds on this to resolve which image model handles
independent per-panel requests (`resolveCompanionModel`) and which image size both the sequential and companion
models support (`selectCompatibleImageSize`).

**Image generation is model-routing-sensitive**: `seedream-v4.5-sequential` batches multiple panels in one
request (shares reference images across a page); `seedream-v4.5` generates panels independently. Sequential batching
is disabled by default — do not change that default casually. There is a pinned output-order contract test for this
path (`scripts/seedream-order-contract-test.mjs`, run by `.github/workflows/seedream-order-contract-test.yml`); avoid
changes that weaken that guarantee. See `plan/` for design docs on continuity and generation-liveness/timeout
behavior when touching image generation — these describe intended behavior in more depth than inline comments do.

**No backend**: everything under `src/js/` runs in the browser. Anything that looks like it needs a server-side
secret or endpoint is out of scope for this app — the NanoGPT API key is entered in Settings and stored in
IndexedDB.

## Coding style

- Two-space indent, single quotes, semicolons, trailing commas, 120 col width (Prettier-enforced, see `.prettierrc`).
- `camelCase` for variables/functions, `PascalCase` for types/classes, kebab-case for page filenames
  (`image-presets.ts`).
- Keep page-specific logic in `src/js/pages/`; shared logic in focused top-level modules under `src/js/`.
- `tsconfig.json` has `strict: false` and `pages/*.ts` files are commonly `@ts-nocheck` — this codebase favors
  pragmatic incremental typing over strict end-to-end typing; domain modules (`visual-continuity.ts`,
  `image-generation-config.ts`, `db.ts`) are the more strictly-typed exception and should stay that way.

## Testing

- Unit tests: Vitest, `describe`/`it`, files named `*.test.js`/`*.test.ts` under `test/`. `fake-indexeddb` is used to
  test `db.ts` without a real browser.
- E2E: Playwright specs as `*.spec.js` under `test/e2e/`, run against a preview build on port 8080.
- Coverage floor: 60% lines / 55% branches (`vitest.config.ts`); CI enforces this.

## Commit conventions

Conventional Commit-style subjects (`feat:`, `fix:`, `test:`, `chore:`, etc.), short and imperative. Never commit
NanoGPT API keys or other secrets — they belong only in the browser's IndexedDB, never in code, workflow files, or
repo settings.
