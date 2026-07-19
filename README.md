# AI Comic Creator

[![Tests](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/tests.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/tests.yml)
[![Playwright E2E Tests](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/playwright.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/playwright.yml)
[![Deploy to GitHub Pages](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/deploy-pages.yml)

A fully client-side Progressive Web App for creating AI-generated comic books:
build characters and worlds, pick a genre, and generate interactive comic pages
with AI text and optional AI artwork. Powered by the
[NanoGPT](https://nano-gpt.com) API.

**Live app:** <https://dkylepeppers-alt.github.io/Comiccreator/>

## Quick start

```bash
npm ci
npm run dev        # Vite dev server
```

Open the app, go to **Settings**, and paste your NanoGPT API key (get one at
[nano-gpt.com](https://nano-gpt.com)). The key is stored in your browser's
IndexedDB and sent only to the NanoGPT API — there is no backend, no server
secrets, and the key is never needed in CI or repository settings.

## Commands

| Command                | What it does                              |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | Dev server with hot reload                |
| `npm run build`        | Production build to `dist/`               |
| `npm run serve`        | Preview the production build on port 8080 |
| `npm test`             | Unit tests (Vitest)                       |
| `npm run test:e2e`     | Browser smoke tests (Playwright)          |
| `npm run typecheck`    | TypeScript check (`tsc --noEmit`)         |
| `npm run lint`         | ESLint                                    |
| `npm run format:check` | Prettier check                            |

## Architecture

No framework — plain TypeScript ES modules bundled by Vite, with a hash-based
page router and IndexedDB for all persistence (characters, worlds, comics,
presets, settings). `vite-plugin-pwa` generates the service worker and
precache manifest, making the app installable and offline-capable.

```
src/js/
  app.ts          router, modals, toasts, error log, SW registration
  db.ts           IndexedDB wrapper (ComicCreatorDB) + seed defaults
  api.ts          NanoGPT API client: chat completions (streaming), image
                  generation, model lists, embeddings
  utils.ts        shared helpers (escHtml, etc.)
  pages/          one module per page: home, characters, worlds, create,
                  library, presets, image-presets, settings
test/             Vitest unit tests + test/e2e/ Playwright smoke tests
```

All AI calls go directly from the browser to `https://nano-gpt.com/api/v1`.

## Android app

The same codebase ships as a native Android app via [Capacitor](https://capacitorjs.com)
— the web build is bundled inside the APK, so the app works fully offline and
doesn't depend on the hosted site.

**Install it:** download `comic-creator-v*-debug.apk` from the
[android-latest release](https://github.com/dkylepeppers-alt/Comiccreator/releases/tag/android-latest)
on your phone, allow installs from your browser when prompted, and open the
app. Enter your NanoGPT API key in Settings, same as the web version. CI
rebuilds this APK on every merge to `main` (`android-build.yml`).

It's a **debug-signed build**: fine for personal sideloading, not for the Play
Store. Publishing would need a release keystore and a Play developer account.

Local Android development (requires the Android SDK + Java 21):

```bash
npm run build && npx cap sync android   # copy web assets into android/
cd android && ./gradlew assembleDebug   # or open in Android Studio
```

The Android `versionName`/`versionCode` are derived from `package.json` at
build time, so the auto-version-bump flows into the APK automatically.

## Deployment

Merging to the default branch runs the **Post-Merge Pipeline** (auto version
bump), and its completion triggers **Deploy to GitHub Pages**, which builds
and publishes `dist/`. The deploy intentionally waits for the version-bump
commit so the published `version.json` always matches the repo. A manual
deploy can be started from the Actions tab (`workflow_dispatch`).

## Repo conventions

- Versioning is automated: every merge to the default branch bumps the patch
  version (`scripts/bump-version.sh`) across `package.json`, `version.json`,
  and the `index.html` footer. Don't bump versions by hand.
- `scripts/validate-workflows.sh` sanity-checks the GitHub Actions workflows
  (pinned action SHAs, permissions blocks, concurrency groups).
- Dependabot keeps dependencies fresh; `security-pr.yml` runs
  `npm audit --audit-level=high` on every PR.
