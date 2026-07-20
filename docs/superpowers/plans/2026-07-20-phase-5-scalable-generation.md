# Phase 5 Scalable Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace high-complexity generation and settings orchestration with a strict, strategy-based pipeline and typed services while preserving all runtime behavior.

**Architecture:** Resolve mutable application inputs at a facade, build an immutable continuity plan, execute it with one of two strategy modules, and apply typed results at a single mutation boundary. Move backup import and model catalog loading into strict services while leaving DOM coordination in `settings.ts`.

**Tech Stack:** TypeScript ES modules, Vite, Vitest, IndexedDB abstraction, existing generation-progress and visual-continuity contracts.

## Global Constraints

- Preserve the sequential-batching default and the Seedream output-order contract exactly.
- Preserve prompt text, reference allocation, model routing, progress transitions, warning text, and error behavior.
- Preserve the public `generateContinuityPageImages(ctx, pageData, statusMsg, options)` call signature.
- Preserve current backup compatibility and collection write order; do not introduce a new backup schema version.
- Preserve current model-picker DOM behavior, including caption filtering and fallback status.
- Do not change `db.ts`, `visual-continuity.ts`, or `generation-progress.ts` behavior.
- New strict-core public interfaces must not expose `any`; use `unknown` plus narrowing for opaque legacy values.
- Do not bump the application version.

---

### Task 1: Typed continuity planning core

**Files:**
- Create: `src/js/generation/continuity/types.ts`
- Create: `src/js/generation/continuity/build-plan.ts`
- Create: `test/continuity-pipeline.test.ts`

**Interfaces:**
- Consumes: resolved model capabilities, planned panels, render states, character/world inputs, reference budgets, selected targets, style and negative prompts.
- Produces: `buildContinuityGenerationPlan(input: ContinuityPlanningInput): ContinuityGenerationPlan`.
- `ContinuityGenerationPlan` contains `strategy`, `pageModelId`, `effectiveModelId`, `imageSize`, `requests`, `compiledPrompts`, `panelPrompts`, `referenceManifest`, `warnings`, and `blockedPanels`.
- Every `ContinuityRequest` contains stable `id`, ordered `panelIndexes`, `modelId`, `expectedImageCount`, `prompt`, `imageDataUrls`, and optional `negativePrompt`.

- [ ] **Step 1: Write planner contract tests**

  Add Vitest cases that construct resolved `ContinuityPlanningInput` fixtures and assert:
  - an eligible four-panel page produces one `page-sequence` request with panel indexes `[0, 1, 2, 3]`;
  - an independent plan produces `panel-1`, `panel-2`, ... in panel order;
  - targeted retries exclude untargeted panels and disable sequential routing;
  - allocation errors and blocked panels do not produce requests;
  - compiled prompts, panel prompts, manifests, and warning order match the existing helpers.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `npx vitest run test/continuity-pipeline.test.ts`

  Expected: FAIL because `generation/continuity/build-plan.ts` does not exist.

- [ ] **Step 3: Define strict plan contracts**

  Define discriminated strategy and request/result types in `types.ts`. Model only fields consumed by the pipeline; use `unknown` for opaque API metadata and narrow it before use. Mark plan arrays readonly where executors must not mutate them.

- [ ] **Step 4: Implement the pure planner**

  Move reference allocation, route selection, prompt compilation, request registration data, target filtering, and warning aggregation from `generateContinuityPageImages` into `buildContinuityGenerationPlan`. The function must not read DB, call the API, update progress, mutate panels, or touch the DOM.

- [ ] **Step 5: Verify GREEN and unchanged contracts**

  Run: `npx vitest run test/continuity-pipeline.test.ts test/visual-continuity.test.js`

  Expected: all tests pass with stable ordered request descriptors.

- [ ] **Step 6: Commit**

  Run:
  ```bash
  git add src/js/generation/continuity/types.ts src/js/generation/continuity/build-plan.ts test/continuity-pipeline.test.ts
  git commit -m "refactor: add typed continuity generation planner"
  ```

### Task 2: Strategy execution and result application

**Files:**
- Create: `src/js/generation/continuity/execute-sequential.ts`
- Create: `src/js/generation/continuity/execute-independent.ts`
- Create: `src/js/generation/continuity/apply-results.ts`
- Create: `src/js/generation/continuity/orchestrator.ts`
- Modify: `src/js/generation/image-engine.ts:673-1026`
- Modify: `test/continuity-pipeline.test.ts`

**Interfaces:**
- Consumes: `ContinuityGenerationPlan` from Task 1 plus `ContinuityExecutionDependencies` containing `generateImages`, `persistImage`, progress callbacks, `signal`, `toast`, and `logError`.
- Produces: `executeSequentialPlan(...)` and `executeIndependentPlan(...)`, both returning `Promise<ContinuityExecutionResult>`.
- Produces: `applyContinuityResult(pageData, plan, result, now): void`, the only new pipeline function that mutates page data.
- Produces: `runContinuityGeneration(input, dependencies): Promise<void>`, used by the existing facade.

- [ ] **Step 1: Write executor and result-application tests**

  Add cases for sequential result-index mapping, short sequential responses, persisted-image warnings, independent per-panel success/failure, allocation failures, targeted retries, non-abort safe failures, and `AbortError` propagation. Assert executors return data and do not mutate the supplied page fixture before `applyContinuityResult` runs.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `npx vitest run test/continuity-pipeline.test.ts`

  Expected: FAIL because the executor, application, and orchestration modules do not exist.

- [ ] **Step 3: Implement sequential execution**

  Move the `page-sequence` request path into `execute-sequential.ts`. Preserve request options, progress phases, result-index mapping, download persistence, missing-result warning/error text, toast behavior, and cancellation propagation.

- [ ] **Step 4: Implement independent execution**

  Move the panel-request path into `execute-independent.ts`. Dispatch requests in plan order, preserve concurrent settlement, per-panel progress and failures, status counts, exact reference options, and cancellation propagation.

- [ ] **Step 5: Implement the mutation boundary and orchestrator**

  `apply-results.ts` applies image URLs, image prompts, generation errors, deduplicated warnings, manifests, compiled prompts, failures, outcome, and timestamps. `orchestrator.ts` selects an executor through a `Record<ContinuityStrategy, ContinuityExecutor>` registry rather than a strategy `if` chain.

- [ ] **Step 6: Replace the monolithic facade body**

  Keep `generateContinuityPageImages` exported from `image-engine.ts`, resolve DB/API/state inputs there, construct strict planner/execution inputs, and delegate to `runContinuityGeneration`. Remove the old inline planning and execution branches.

- [ ] **Step 7: Verify GREEN and integration behavior**

  Run: `npx vitest run test/continuity-pipeline.test.ts test/visual-continuity.test.js test/generation-progress.test.js`

  Expected: all tests pass; the existing public signature and contract behavior remain unchanged.

- [ ] **Step 8: Commit**

  Run:
  ```bash
  git add src/js/generation/continuity src/js/generation/image-engine.ts test/continuity-pipeline.test.ts
  git commit -m "refactor: split continuity generation strategies"
  ```

### Task 3: Enforced strict core typing

**Files:**
- Create: `tsconfig.core.json`
- Modify: `package.json`
- Modify: `src/js/generation/image-engine.ts:1-1026`
- Modify: `src/js/generation/types.ts`
- Modify: `src/js/generation/continuity/*.ts`

**Interfaces:**
- Consumes: the pipeline contracts from Tasks 1-2.
- Produces: `npm run typecheck:core`, compiling `generation/continuity/**` and their explicit boundary types with `strict: true` and `noEmit: true`.

- [ ] **Step 1: Add the strict compiler configuration and script**

  Extend `tsconfig.json` from `tsconfig.core.json`, override `strict` to `true`, and include the continuity directory plus its type-only boundary modules. Add `"typecheck:core": "tsc -p tsconfig.core.json"` to `package.json`.

- [ ] **Step 2: Run strict checking and verify RED**

  Run: `npm run typecheck:core`

  Expected: FAIL on unresolved implicit, nullable, or opaque legacy values in the new pipeline.

- [ ] **Step 3: Remove suppression and close type gaps**

  Remove `@ts-nocheck` from `generation/image-engine.ts`. Replace engine-facing `any` annotations with named types where values cross the new pipeline boundary. Narrow caught errors and DOM elements, and define dependency result types rather than asserting broad shapes.

- [ ] **Step 4: Verify strict and standard typechecks**

  Run: `npm run typecheck:core && npm run typecheck`

  Expected: both commands exit successfully.

- [ ] **Step 5: Run generation tests**

  Run: `npx vitest run test/continuity-pipeline.test.ts test/visual-continuity.test.js test/generation-progress.test.js`

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  Run:
  ```bash
  git add tsconfig.core.json package.json src/js/generation
  git commit -m "refactor: enforce strict generation core types"
  ```

### Task 4: Typed backup import service

**Files:**
- Create: `src/js/settings/backup-import.ts`
- Create: `test/backup-import.test.ts`
- Modify: `src/js/pages/settings.ts:958-990`
- Modify: `tsconfig.core.json`

**Interfaces:**
- Produces: `parseBackup(text: string): BackupPayload` and `importBackup(payload: BackupPayload, dependencies: BackupImportDependencies): Promise<void>`.
- `BackupImportDependencies` supplies store identifiers, `put`, `normalizeCharacter`, and `normalizeWorld`; the service has no DOM or `App` dependency.
- Supported collections remain `characters`, `worlds`, `comics`, `pages`, `presets`, and `imagePresets` in that exact write order.

- [ ] **Step 1: Write backup service tests**

  Test a complete backup, missing collections, empty collections, an invalid non-array collection, entries without truthy IDs, character/world normalization, unknown top-level properties, malformed JSON, a normalizer failure, and a write failure. Assert sequential collection and record write order.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `npx vitest run test/backup-import.test.ts`

  Expected: FAIL because `settings/backup-import.ts` does not exist.

- [ ] **Step 3: Implement descriptor-driven validation/import**

  Define one readonly descriptor per supported collection with its payload key, store, and optional normalizer. Validate every present collection before performing any write, then import sequentially in descriptor order. Preserve current error messages such as `Invalid characters data`.

- [ ] **Step 4: Integrate the page wrapper**

  Keep file selection, `file.text()`, logging, toast, and refresh behavior in `settings.ts`. Replace its validation/write loops with `parseBackup` and `importBackup` using DB-backed dependencies.

- [ ] **Step 5: Verify GREEN and type safety**

  Run: `npx vitest run test/backup-import.test.ts && npm run typecheck:core && npm run typecheck`

  Expected: all commands pass.

- [ ] **Step 6: Commit**

  Run:
  ```bash
  git add src/js/settings/backup-import.ts src/js/pages/settings.ts test/backup-import.test.ts tsconfig.core.json
  git commit -m "refactor: extract typed backup import service"
  ```

### Task 5: Typed model catalog loader

**Files:**
- Create: `src/js/settings/model-loader.ts`
- Create: `test/model-loader.test.ts`
- Modify: `src/js/pages/settings.ts:446-501`
- Modify: `tsconfig.core.json`

**Interfaces:**
- Produces: `loadModelCatalog(kind: 'text' | 'image', forceRefresh: boolean, dependencies: ModelLoaderDependencies): Promise<ModelLoadResult>`.
- `ModelLoadResult` contains `models`, `captionModels`, `usedFallback`, and optional `error`; the service has no DOM or `App` dependency.
- Text caption models exclude only entries with `supports_vision === false`; fallback text models are caption-capable.

- [ ] **Step 1: Write model-loader tests**

  Cover text success and caption filtering, image success, force-refresh forwarding, text failure fallback, image failure fallback, normalized fallback fields, and preservation of the caught error in the result.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `npx vitest run test/model-loader.test.ts`

  Expected: FAIL because `settings/model-loader.ts` does not exist.

- [ ] **Step 3: Implement the catalog loader**

  Select the correct fetch function by kind, construct fallback records as `{ id, name: id, owned_by: '' }`, derive caption models for text results, and return failures as data for the page to log and render.

- [ ] **Step 4: Integrate the page wrapper**

  Keep loading/status DOM changes and `renderModelList` calls in `settings.ts`. Replace fetch/fallback branching with the service result, update text/image/caption module arrays, preserve exact status text, and remove obsolete loading flags if they remain write-only.

- [ ] **Step 5: Verify GREEN and type safety**

  Run: `npx vitest run test/model-loader.test.ts && npm run typecheck:core && npm run typecheck && npm run lint`

  Expected: tests and both typechecks pass; lint has no new warnings.

- [ ] **Step 6: Commit**

  Run:
  ```bash
  git add src/js/settings/model-loader.ts src/js/pages/settings.ts test/model-loader.test.ts tsconfig.core.json
  git commit -m "refactor: extract typed model catalog loader"
  ```

### Task 6: Phase verification

**Files:**
- Modify only if a verification failure reveals a Phase 5 regression.

**Interfaces:**
- Consumes: all Phase 5 deliverables.
- Produces: a verified branch ready for final review.

- [ ] **Step 1: Run all repository gates**

  Run:
  ```bash
  npm run check-syntax
  npm run typecheck:core
  npm run lint
  npm run format:check
  npm test
  npm run coverage
  npm run build
  ```

  Expected: all commands pass; coverage remains at least 60% lines and 55% branches.

- [ ] **Step 2: Audit architectural outcomes**

  Confirm `generateContinuityPageImages` is a thin facade, strategy modules do not mutate page data, `applyContinuityResult` is the single new pipeline mutation boundary, no `@ts-nocheck` remains under `src/js/generation/`, and no new core public interface exposes `any`.

- [ ] **Step 3: Record the local E2E limitation**

  Run `npm run test:e2e`. If Chromium still cannot launch because `libnspr4.so` is unavailable, record the environment failure and require the unchanged Playwright suite in CI before merge; do not modify application code for the missing system library.

- [ ] **Step 4: Preserve the live Seedream contract gate**

  Review `scripts/seedream-order-contract-test.mjs` and `.github/workflows/seedream-order-contract-test.yml` against the unchanged ordered `panelIndexes` contract. Do not invoke the paid live probe locally without an explicitly provided API key; require that workflow before merge.
