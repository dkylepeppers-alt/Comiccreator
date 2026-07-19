# Repository Guidelines

## Project Structure & Module Organization

This repository is a client-side AI comic creator built with TypeScript ES modules, Vite, and IndexedDB. Application code lives in `src/js/`: `app.ts` owns routing and application setup, `db.ts` handles persistence, `api.ts` wraps NanoGPT requests, and `pages/` contains one module per screen. Shared styles are in `src/css/app.css`; static PWA assets and icons are under `public/`. Unit tests live in `test/*.test.js`, while Playwright smoke tests are in `test/e2e/`. The Capacitor Android wrapper is under `android/`; automation and maintenance helpers are in `scripts/` and `.github/`.

## Build, Test, and Development Commands

- `npm ci` installs the locked dependency set (Node 22 is used in CI).
- `npm run dev` starts the Vite development server with hot reload.
- `npm run build` creates the production PWA in `dist/`; `npm run serve` previews it on port 8080.
- `npm test` runs Vitest once; `npm run test:watch` reruns affected tests during development.
- `npm run test:e2e` runs Playwright smoke tests against a preview build.
- `npm run lint`, `npm run typecheck`, and `npm run format:check` mirror the main static CI checks.

For Android changes, run `npm run build && npx cap sync android`, then `cd android && ./gradlew assembleDebug` with Java 21 and the Android SDK installed.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, semicolons, trailing commas, and ES modules, matching the existing Prettier output. Use `camelCase` for variables and functions, `PascalCase` for types/classes, and kebab-case for page filenames such as `image-presets.ts`. Keep page-specific behavior in `src/js/pages/` and shared helpers in focused top-level modules. Run `npm run format` only on intended source files and resolve ESLint warnings where practical.

## Testing Guidelines

Use Vitest `describe`/`it` blocks and name unit files `*.test.js` or `*.test.ts`. Add Playwright specs as `*.spec.js` under `test/e2e/` for browser workflows. Coverage must remain at least 60% for lines and 55% for branches. Before opening a PR, run build, lint, typecheck, format check, coverage, and relevant E2E tests.

## Commit & Pull Request Guidelines

The available history uses Conventional Commit-style subjects, for example `chore: bump version to v1.6.81`; use a short imperative subject with an appropriate prefix such as `feat:`, `fix:`, `test:`, or `chore:`. Do not bump versions manually—the post-merge workflow handles that. PRs should explain the change and validation performed, link relevant issues, and include screenshots for visible UI changes. Never commit NanoGPT API keys; they belong in browser settings/IndexedDB.
