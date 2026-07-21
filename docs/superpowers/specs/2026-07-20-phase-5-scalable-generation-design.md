# Phase 5 Scalable Generation Design

## Objective

Replace the remaining high-complexity orchestration with typed, independently testable boundaries that support additional generation strategies, providers, retries, diagnostics, and backup/model growth without expanding page modules or a central engine function.

This is a behavior-preserving refactor. It must not change the sequential-batching default, Seedream image ordering, prompt text, reference allocation, progress semantics, error messages, backup compatibility, or model-picker behavior.

## Generation architecture

The continuity pipeline becomes four explicit stages:

1. Resolve runtime inputs from settings, model metadata, and create-page state.
2. Build an immutable `ContinuityGenerationPlan` containing the selected strategy, ordered request descriptors, prompts, references, warnings, and blocked panels.
3. Execute the plan through either the sequential-page or independent-panels strategy and return a typed `ContinuityExecutionResult` without mutating page data.
4. Apply the execution result at one boundary that owns panel images, failures, warnings, and `pageData.generation` metadata.

`generateContinuityPageImages` remains the public compatibility facade used by `create.ts`. It coordinates the four stages but does not contain strategy-specific branching.

The plan is the scaling seam. Request order, model choice, expected image count, panel mapping, compiled prompt, and reference images are explicit data. Adding a future strategy requires another executor implementing the same contract rather than another branch in the orchestrator.

## Type boundary

New pipeline and settings service modules are compiled under a dedicated strict TypeScript configuration. The existing application configuration remains unchanged because turning on repository-wide strictness is a separate migration.

`@ts-nocheck` is removed from `generation/image-engine.ts`. Legacy data entering the new strict core is normalized into named interfaces at the facade. New core public interfaces must not expose `any`; genuinely opaque legacy payloads use `unknown` and are narrowed at their boundary.

## Settings architecture

Backup importing moves to a typed service with a descriptor for each supported collection. It validates the current unversioned format, preserves collection write order, normalizes character and world records, ignores unknown properties, and accepts backups produced by all current releases. No new backup schema version is introduced in this refactor.

Model loading moves to a typed catalog service. It owns remote fetch selection, fallback construction, and the vision-capable caption subset. `settings.ts` continues to own DOM status updates, module state assignment, rendering, toasts, and logging.

## Error and cancellation behavior

- `AbortError` always propagates from both generation strategies.
- Other request errors become safe generation failures and retain current progress/failure reporting.
- Sequential partial responses map by returned result index and mark missing panels.
- Independent requests retain per-panel isolation and targeted retry filtering.
- Backup parse, validation, normalization, or write failures continue to produce the existing invalid-backup UI path.
- Model-loading failures return fallback models and the original error so the page can retain its current log/status behavior.

## Testing strategy

- Planner tests assert stable request order, strategy selection, target-panel filtering, blocked-panel exclusion, prompts, and references without network or IndexedDB.
- Executor tests assert sequential index mapping, partial results, independent per-panel failures, cancellation, warnings, and progress callbacks.
- Existing visual-continuity and Seedream order contracts remain mandatory.
- Backup tests cover every collection, invalid collection shapes, legacy normalization, missing collections, unknown properties, and write order.
- Model-loader tests cover text/image success, caption filtering, fallbacks, and error preservation.
- The strict core typecheck, standard typecheck, unit tests, coverage thresholds, lint, formatting, and production build all gate completion.

## Non-goals

- A persistent workflow/state-machine runtime.
- Cross-session generation resumption.
- A new backup format or migration system.
- Repository-wide strict TypeScript.
- Changes to `db.ts`, `visual-continuity.ts`, or `generation-progress.ts` behavior.

