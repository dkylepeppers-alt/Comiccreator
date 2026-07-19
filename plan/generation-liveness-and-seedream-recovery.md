# Generation Liveness and Seedream Configuration Recovery

**Status:** Proposed
**Repository baseline:** Comiccreator 1.6.79 (`d98f4f4`)
**Related change:** [PR #231 — Anchored visual continuity + Seedream sequential page generation](https://github.com/dkylepeppers-alt/Comiccreator/pull/231)
**Last updated:** 2026-07-19

## 1. Summary

Comiccreator will make every post-prompt generation phase visibly active, place a hard upper bound on image-provider and result-download waits, preserve completed work when only part of a page fails, and repair stale Seedream configuration without requiring the user to revisit Settings.

This patch addresses a specific failure mode in 1.6.79: after the story model finishes streaming, the UI hides the only spinner and status message while image work continues. An independent Seedream fallback can then issue several requests in parallel, and any request that never settles keeps the whole page waiting indefinitely. The screen looks finished or frozen even though the browser is still awaiting the provider.

The patch also corrects two upgrade hazards:

- A comic configured before 1.6.79 may still have a blank single-image companion, causing independent requests to use `seedream-v4.5-sequential` with `n: 1` instead of the intended `seedream-v4.5` companion.
- A six-hour image-model cache created before capability fields were added can be returned unchanged, hiding the Seedream reference and output limits until the cache expires or the user manually refreshes it.

Sequential page batching remains disabled by default. This patch must not enable it or weaken the live output-order contract-test gate established by PR #231.

## 2. Confirmed current behavior

The baseline implementation behaves as follows:

1. `renderGenerating()` renders a loading block containing `#gen-status-msg` and a second, initially hidden, story-stream block.
2. After 500 ms, `generatePage()` hides the loading block and shows the story-stream block.
3. Once story streaming ends, the story-stream title changes, but `#gen-status-msg` remains inside the hidden loading block.
4. The structured planner then loads model metadata, allocates references, compresses them, sends image requests, downloads signed result URLs, converts results to data URLs, and saves the page.
5. With sequential batching disabled, a four-panel page normally uses four independent image requests.
6. When `imageModel` is `seedream-v4.5-sequential` and `singleImageModel` is blank, those independent requests use the sequential model itself with `n: 1`.
7. `generateImages()`, `fetchImageModels()`, and `imageResultToDataUrl()` do not impose hard timeouts.
8. Independent requests are joined by `Promise.all()`. Rejected panel requests are caught, but a request that remains pending prevents the join from finishing.
9. The outer image-generation catch preserves the parsed story plan after a rejection, but it cannot run while a request remains pending.
10. A failed sequential request exits before `pageData.generation` is populated, reducing the usefulness of post-failure diagnostics.

Therefore, remaining on the completed story/prompt screen is most consistent with a pending post-prompt operation. It is not proof of a swallowed rejection, and it is not possible for the current UI to distinguish a slow provider from an indefinitely pending request.

## 3. Goals

The implementation must:

- Keep one visible generation status surface from the start of preflight through the final page save.
- Show the active phase, effective image model, request strategy, request count, completed count, image count, and elapsed time.
- Warn when an image request is unusually slow without pretending that the provider reports percentage progress.
- End every provider image request after a configurable hard timeout.
- End every remote result download after a shorter hard timeout.
- Distinguish user cancellation, provider/API failure, invalid configuration, and timeout.
- Allow one independent panel request to fail or time out without discarding images returned for other panels.
- Commit the story plan, continuity snapshots, successful images, and useful failure metadata after an image failure or timeout.
- Offer an explicit retry for only missing or failed panel images; never retry paid image requests automatically.
- Resolve the recommended standard Seedream companion automatically for upgraded configurations whose companion setting is blank.
- Normalize or invalidate pre-1.6.79 image-model cache entries before using them for routing and reference budgets.
- Validate the effective models and image size before paying for the story request when live or cached capability data makes validation possible.
- Preserve cancellation behavior for new pages, re-rolls, and image-only regeneration.
- Keep the existing legacy prompt pipeline functional.

## 4. Non-goals

This patch does not:

- Enable `enableSequentialPages` by default.
- Claim that NanoGPT guarantees sequential response ordering.
- Run or waive the live Seedream Sequential output-order contract test.
- Redesign the continuity ledger, identity-anchor allocator, prompt compiler, or structured story schema from PR #231.
- Guarantee that aborting a browser request cancels work already accepted by the provider. A timed-out request may still finish or be billed upstream.
- Automatically retry image generation. Automatic retries can duplicate cost and can race a provider job that is still running.
- Add a backend job queue, server-side polling, or cross-device generation recovery.
- Persist in-flight network requests across navigation, browser reload, or app termination.
- Introduce provider telemetry or send diagnostics to a third party.
- Promise a provider latency service level. The timeout values below are application safety bounds, not NanoGPT performance guarantees.
- Change reference-image resolution policy beyond reusing already-prepared references within the same generation attempt.

## 5. Product decisions

### 5.1 One persistent progress surface

The app will render one progress card for the entire generation attempt. Story text may appear in a collapsible details area, but it must never replace or hide the progress card.

The progress card is authoritative for liveness. A toast may supplement it, but a toast must not be the only indication of a failure, timeout, partial result, or correction made during preflight.

### 5.2 Honest progress, not a fabricated percentage

NanoGPT image generation does not expose fine-grained progress. Comiccreator will report only facts it knows:

- Current application phase.
- Time elapsed.
- Whether requests have been submitted.
- Number of provider requests completed out of the total.
- Number of usable images received out of the expected total.
- Whether the soft-stall threshold has passed.

The UI must not display a percentage bar that implies knowledge of provider-side progress.

### 5.3 Slow and failed are different states

At 120 seconds without provider activity, a pending image request becomes **slow**. It remains active and is not failed.

At 10 minutes, that request becomes **timed out**. Comiccreator aborts its client-side fetch, records a retryable timeout, and continues finalizing the page with any work already completed.

The user may cancel at any time. Cancellation is not presented or persisted as a provider failure.

### 5.4 Partial completion is a valid page outcome

A page with a valid story plan and only some successful images is a valid saved page. It must remain readable, preserve continuity state, identify missing panels, and offer a targeted retry.

Image failures must not cause the story model to be called again. The already-parsed plan and stored render-state snapshots remain authoritative for retries.

### 5.5 No automatic paid retry

Comiccreator will not automatically repeat a timed-out or failed image request. The timeout only proves that the browser stopped waiting; it does not prove that the provider stopped processing the first request.

Retries require an explicit user action and the UI must warn that a previous provider job may still complete or incur cost.

### 5.6 Companion selection is explicit but migration-safe

The single-image companion setting becomes a three-mode setting:

| Mode     | Meaning                                                             |
| -------- | ------------------------------------------------------------------- |
| `auto`   | Use the known companion for a sequential page model when available. |
| `same`   | Deliberately use the selected page model for independent requests.  |
| `custom` | Use the exact model ID chosen by the user for independent requests. |

For `seedream-v4.5-sequential`, `auto` resolves to `seedream-v4.5` only when that exact model is present in the normalized model list. Comiccreator must not guess a companion by loosely editing an arbitrary model ID.

If the recommended model is unavailable, `auto` falls back to the page model and emits a visible warning. A missing `custom` model is a blocking configuration error.

### 5.7 Sequential batching stays gated

The setting `enableSequentialPages` retains its current default of `false`. Cache repair, companion migration, timeout handling, or successful independent generation must not flip it.

Only the separately defined live output-order contract test may justify changing that default in a later patch.

## 6. User experience

### 6.1 Progress card

During generation, the page shows a card with:

- A spinner while the attempt is active.
- A stable title such as **Generating page** or **Regenerating images**.
- A phase message.
- The effective image route once known.
- The effective provider model once known.
- `Requests: completed / total` once image requests are planned.
- `Images: received / expected` once images are requested.
- An elapsed timer in `mm:ss` or `h:mm:ss`.
- A persistent Cancel button.
- A collapsed **Story response** disclosure while or after story text streams.
- A **Copy details** action once routing is known, the request is slow, or an error occurs.

Example after story planning:

> Waiting for panel images
> Model: seedream-v4.5 · Independent panels
> Requests: 1 / 4 · Images: 1 / 4 · Elapsed: 02:17

Example for sequential batching when the user has explicitly enabled it:

> Waiting for page sequence
> Model: seedream-v4.5-sequential · One request for 4 images
> Requests: 0 / 1 · Images: 0 / 4 · Elapsed: 01:08

### 6.2 Phase messages

The following phases are user-visible:

| Phase                  | Default message                    |
| ---------------------- | ---------------------------------- |
| `checking-settings`    | Checking image model and settings… |
| `writing-story`        | Writing story…                     |
| `parsing-story`        | Parsing story plan…                |
| `preparing-references` | Preparing reference images…        |
| `submitting-images`    | Submitting image requests…         |
| `waiting-for-images`   | Waiting for image generation…      |
| `persisting-images`    | Saving returned images locally…    |
| `saving-page`          | Saving page…                       |
| `complete`             | Page ready                         |
| `failed`               | Generation stopped                 |
| `cancelled`            | Generation cancelled               |

Re-image attempts skip the story phases. Text-only generation skips all image phases.

### 6.3 Soft-stall presentation

When any submitted image request has produced no activity for 120 seconds, the card adds an amber notice:

> NanoGPT is taking longer than usual. The request is still active and will time out after 10 minutes unless it completes or you cancel it.

The notice includes the affected panel numbers or says `page sequence` for the batched route. It does not change the spinner to an error icon.

Activity means a phase transition observable by Comiccreator, such as submission, response headers received, response body parsed, result download started, or result persistence completed. It does not claim provider-side rendering activity.

### 6.4 Timeout and partial-result presentation

When one or more requests time out, the app finishes the attempt and navigates to the reading view. The page shows a persistent summary above the panels:

> 3 of 4 images were created. Panel 4 timed out after 10:00. Completed images and the story were saved.

Actions:

- **Retry missing images** — regenerates only panels with no usable image.
- **Copy details** — copies redacted attempt diagnostics.
- Existing **Re-images** — deliberately regenerates the entire page and keeps its current semantics.

Panel placeholders continue to show `generationError`, but timeout copy must be concise and must not include the full prompt.

### 6.5 Configuration correction presentation

If preflight changes an invalid saved size or migrates a blank Seedream companion, the progress card records what happened. A non-blocking informational toast may also be shown.

Examples:

- `Using seedream-v4.5 for independent panel requests (Auto companion).`
- `Image size changed from 1024x1024 to 1920x1920 because the selected route does not support the saved size.`

The effective model and size must remain visible in the final page's generation details.

## 7. Generation progress model

Add a pure module at `src/js/generation-progress.ts`. It owns progress types, timeout classification, elapsed-time formatting, redacted diagnostic serialization, and immutable progress-state transitions. It must not read the DOM or IndexedDB.

Recommended public types:

```ts
export type GenerationContext = 'new-page' | 'continue' | 'reroll' | 'reimage';

export type GenerationStage =
  | 'checking-settings'
  | 'writing-story'
  | 'parsing-story'
  | 'preparing-references'
  | 'submitting-images'
  | 'waiting-for-images'
  | 'persisting-images'
  | 'saving-page'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type GenerationOutcome = 'active' | 'complete' | 'partial' | 'failed' | 'cancelled';

export type ImageRequestState =
  | 'queued'
  | 'preparing'
  | 'pending'
  | 'response-received'
  | 'persisting'
  | 'complete'
  | 'failed'
  | 'timed-out'
  | 'cancelled';

export interface ImageRequestProgress {
  id: string;
  panelIndexes: number[];
  modelId: string;
  state: ImageRequestState;
  startedAt?: number;
  lastActivityAt: number;
  completedAt?: number;
  receivedImageCount: number;
  expectedImageCount: number;
  failure?: SafeGenerationFailure;
}

export interface GenerationProgress {
  attemptId: string;
  context: GenerationContext;
  stage: GenerationStage;
  outcome: GenerationOutcome;
  message: string;
  startedAt: number;
  stageStartedAt: number;
  lastActivityAt: number;
  strategy?: 'sequential-page' | 'independent-panels';
  pageModelId?: string;
  effectiveImageModelId?: string;
  resolution?: string;
  expectedImageCount?: number;
  requests: ImageRequestProgress[];
  warnings: string[];
  failure?: SafeGenerationFailure;
}
```

`elapsedMs`, completed-request counts, received-image counts, and soft-stall state are derived selectors. They must not be rewritten once per second into IndexedDB.

### 7.1 Progress controller

The module exposes transition functions or a small controller with these operations:

- `startAttempt(context, now)`
- `enterStage(progress, stage, message, now)`
- `setRoute(progress, routeDetails, now)`
- `registerRequests(progress, requests, now)`
- `markRequestSubmitted(progress, requestId, now)`
- `markRequestResponse(progress, requestId, receivedCount, now)`
- `markRequestPersisting(progress, requestId, now)`
- `markRequestComplete(progress, requestId, receivedCount, now)`
- `markRequestFailure(progress, requestId, failure, now)`
- `finishAttempt(progress, outcome, now)`
- `getSoftStalledRequests(progress, now, thresholdMs)`
- `toSafeDiagnostics(progress)`

Every update carries `attemptId`. `create.ts` ignores updates whose attempt ID is no longer current. This prevents a late completion from an aborted request from changing the next attempt's UI.

### 7.2 DOM integration

`create.ts` stores the current progress object in page state and updates the mounted progress card through one renderer. It must not call `App.refreshPage()` for every timer tick or network event.

A one-second interval updates only the elapsed label and soft-stall notice. The interval is cleared on completion, failure, cancellation, unmount, and before a new attempt starts.

The existing `statusMsg` DOM parameter is removed from `generateContinuityPageImages()` and `generatePanelImages()`. Those functions receive a progress reporter instead. Business logic must not depend on whether a particular DOM element is mounted.

## 8. Timeout and cancellation semantics

### 8.1 Default bounds

Define named constants in one place:

```ts
export const MODEL_METADATA_TIMEOUT_MS = 20_000;
export const IMAGE_REQUEST_SOFT_STALL_MS = 120_000;
export const IMAGE_REQUEST_TIMEOUT_MS = 600_000;
export const RESULT_DOWNLOAD_TIMEOUT_MS = 30_000;
```

`IMAGE_REQUEST_TIMEOUT_MS` is exposed in Settings as **Image request timeout** with choices of 2, 5, 10, 15, and 20 minutes. The default is 10 minutes. Existing users receive the default without a migration prompt.

The metadata and result-download limits are implementation constants in this patch, not user settings.

### 8.2 Timeout scope

- The model-metadata timer covers the `/image-models?detailed=true` fetch and response-body parsing.
- The image-request timer starts immediately before the `/images/generations` fetch and covers upload, response wait, and response-body parsing.
- The result-download timer covers each signed URL fetch, blob read, and data-URL conversion.
- Reference compression occurs before the provider timer. Its progress remains visible as `preparing-references`.
- Result URLs are persisted concurrently, so four result downloads do not create a four-times-30-second serial tail.

### 8.3 Signal composition

The fetch layer must compose the caller's cancellation signal with an internal timeout controller. Do not rely exclusively on `AbortSignal.any()` because the supported WebView/browser matrix may not implement it consistently.

The helper returns a signal, a timeout-origin predicate, and a cleanup function. All event listeners and timers are removed in `finally`.

### 8.4 Error classification

Add a typed timeout error:

```ts
export class GenerationTimeoutError extends Error {
  readonly code = 'GENERATION_TIMEOUT';
  readonly retryable = true;
  phase: 'model-metadata' | 'image-request' | 'result-download';
  timeoutMs: number;
  elapsedMs: number;
  modelId?: string;
  panelIndexes?: number[];
}
```

Classification rules:

1. If the caller's signal was aborted, surface `AbortError` and classify the outcome as `cancelled`.
2. If the internal timer fired, throw `GenerationTimeoutError` even though the underlying fetch also reports an abort.
3. If the provider returned a non-2xx response, preserve HTTP status and provider message in a safe structured failure.
4. If response parsing or local persistence failed, classify the exact phase.
5. Never infer timeout solely from an error-message string.

### 8.5 Result-download fallback

When a generated image is returned as a remote URL, Comiccreator still tries to persist it as a data URL because signed URLs may expire.

If persistence times out or fails:

- Keep the returned remote URL as the panel's temporary `imageUrl`.
- Record a warning that local persistence failed and the URL may expire.
- Mark the provider image request successful; do not pay to regenerate an image that was already returned.
- Offer a later persistence retry separately from image regeneration if the URL is still reachable.

## 9. Image request orchestration

### 9.1 Pre-register all requests

After routing is resolved but before network submission, `generateContinuityPageImages()` registers the complete request set with the progress controller.

- Sequential route: one request whose `panelIndexes` contains every image-bearing panel.
- Independent route: one request per unblocked image-bearing panel.
- Capacity-blocked panels are recorded as failures but are not counted as submitted provider requests.

This makes the displayed denominator stable before requests begin.

### 9.2 Independent panels

Independent generation uses one bounded operation per panel and joins them with `Promise.allSettled()` or equivalent explicit settlement logic.

For each panel:

1. Reuse its precomputed prompt, render-state snapshot, and allocated references.
2. Submit one request to the resolved companion model with `n: 1`.
3. Apply the per-request hard timeout.
4. Persist the returned result with the result-download timeout.
5. Store the image immediately on success.
6. Store `generationError` and a structured failure on failure or timeout.
7. Mark the request terminal in the progress model.

One timed-out request must not prevent successful requests from being retained. Once all requests are terminal, the page proceeds to `saving-page`.

### 9.3 Sequential page

Sequential generation remains one request with `n` equal to the number of image-bearing panels. Response index mapping remains strict:

- `data[0]` maps only to `IMAGE 1`.
- `data[1]` maps only to `IMAGE 2`.
- Missing entries leave their matching panels empty.
- Extra entries are dropped and logged.

The request has the same hard timeout. If it times out before returning a usable body, every still-empty target panel receives a retryable timeout failure. If a short response returns, received images are retained and only missing indexes are marked failed.

This patch does not reinterpret or reorder results.

### 9.4 Reference preparation reuse

An independent page often sends the same identity anchor in several panel requests. The current implementation recompresses that data URL for every request.

Create an attempt-scoped compression cache keyed by the original data URL and maximum dimension. Cache the in-flight `Promise<string>` so concurrent panels share one decode/compress operation. Clear the cache when the attempt finishes.

The cache is memory-only. It does not alter reference order, reference count, allocation priority, or the 2048-pixel identity-anchor limit.

### 9.5 Finalization must always run

Generation metadata is assembled in `finally`-style finalization after the route is known. A timeout or provider error must not skip:

- `pageData.generation` creation.
- Deduplicated generation warnings.
- Per-panel terminal state assignment.
- Progress outcome calculation.
- Page save for non-cancelled attempts with a valid story plan.

User cancellation remains the exception: a cancelled new-page attempt is not committed as a new page. Re-roll and re-image cancellation retain their existing backup-restoration behavior.

## 10. API changes

### 10.1 `generateImages()`

Extend `GenerateImagesOptions` without breaking existing callers:

```ts
export interface GenerateImagesOptions extends ImageGenOptions {
  count: number;
  exactReferences?: boolean;
  refMaxDimension?: number;
  timeoutMs?: number;
  requestId?: string;
  compressionCache?: Map<string, Promise<string>>;
  onProgress?: (event: ImageApiProgressEvent) => void;
}

export interface ImageApiProgressEvent {
  requestId?: string;
  phase: 'preparing-references' | 'submitting' | 'waiting' | 'response-received' | 'response-parsed';
  at: number;
  receivedImageCount?: number;
}
```

Requirements:

- Default `timeoutMs` to the saved image timeout, falling back to 600,000 ms.
- Preserve the caller's `AbortSignal`.
- Emit progress events only for observable client-side transitions.
- Keep the existing `generateImage()` compatibility wrapper.
- Preserve exact reference validation and strict `data[]` index mapping.
- Do not include the API key, Authorization header, base64 references, or full compiled prompt in a user-facing error message.
- Preserve structured fields such as HTTP status, model, resolution, count, and provider message for diagnostics.

### 10.2 Model metadata fetch

Keep the existing boolean `fetchImageModels(forceRefresh)` call compatible. It may gain a second optional options argument:

```ts
interface FetchImageModelOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
```

`getImageModelMeta()` accepts the same signal/timeout options and continues returning `null` when neither live nor cached metadata can be used.

### 10.3 Remote result persistence

Replace the unbounded `imageResultToDataUrl(value, source)` signature with:

```ts
async function imageResultToDataUrl(
  value: string,
  source: GeneratedImage['source'],
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ value: string; persisted: boolean; warning?: string }>;
```

The function returns the original remote URL with `persisted: false` on a result-download timeout. A caller cancellation still throws `AbortError`.

## 11. Image-model cache migration

### 11.1 Cache schema

Add:

```ts
const IMAGE_MODEL_CACHE_SCHEMA_VERSION = 2;
const IMAGE_MODEL_CACHE_MIGRATION_RETRY_MS = 5 * 60 * 1000;
```

Continue using the existing `cachedImageModels` and `cachedImageModelsAt` settings for compatibility, and add:

- `cachedImageModelsSchemaVersion`
- `cachedImageModelsMigrationRetryAt`

### 11.2 Read behavior

Every cache read must pass every entry through `normalizeImageModel()`, including reads from `getModelSizes()`. `_modelSizesCache` receives normalized entries only.

When the stored schema version is current and the TTL is valid, return the normalized cache normally.

When the schema version is absent or older:

1. Normalize the legacy entries so they remain usable as fallback data.
2. Ignore their TTL for one remote refresh attempt.
3. Bound that refresh by `MODEL_METADATA_TIMEOUT_MS`.
4. On success, write normalized entries, timestamp, and schema version 2.
5. On failure, return the normalized legacy entries and set a five-minute migration retry time.
6. Do not mark the legacy cache as schema version 2 after a failed refresh.

This prevents repeated 20-second delays while offline without allowing a stale pre-capability cache to remain trusted for six hours.

### 11.3 Capability absence

Schema version 2 means the entries were normalized from a current fetch; it does not mean every provider reports every field. Missing fields in a current cache retain the existing conservative routing behavior.

The app must not repeatedly refresh a current cache merely because one model legitimately omits `maxInputImages` or `maxOutputImages`.

## 12. Companion-model migration and resolution

Add a pure configuration helper at `src/js/image-generation-config.ts`.

Recommended interface:

```ts
export type CompanionMode = 'auto' | 'same' | 'custom';

export interface ResolvedImageConfig {
  pageModelId: string;
  companionMode: CompanionMode;
  companionModelId: string;
  resolution: string;
  sequentialEnabledForAttempt: boolean;
  warnings: string[];
  corrections: Array<{
    setting: string;
    from: unknown;
    to: unknown;
    reason: string;
  }>;
}
```

### 12.1 Lazy setting migration

When `singleImageModelMode` does not exist:

- If `singleImageModel` is non-empty, migrate to `custom` and preserve its exact value.
- If `singleImageModel` is empty, migrate to `auto`.

This migration runs during generation preflight as well as Settings mount. The user must not have to open and save Settings for it to take effect.

### 12.2 Resolver

Use an explicit companion map:

```ts
const AUTO_COMPANION_MODELS: Record<string, string> = {
  'seedream-v4.5-sequential': 'seedream-v4.5',
};
```

Resolution rules:

1. For a non-sequential page model, the effective independent model is the page model regardless of a stale custom companion value.
2. `same` resolves to the page model.
3. `custom` resolves to the exact configured ID and blocks preflight if a successful live model fetch proves it is unavailable.
4. `auto` resolves through `AUTO_COMPANION_MODELS` only when the mapped model exists.
5. If the mapped model is unavailable or model availability could not be verified, fall back to the page model and show the exact fallback.
6. Resolution never changes `enableSequentialPages`.

### 12.3 Settings UI

Replace the ambiguous optional text field with:

- A companion mode select containing **Auto (recommended)**, **Same as page model**, and **Custom**.
- A searchable model picker shown only for Custom.
- Read-only effective-route text under the control.

For Seedream Sequential in Auto mode, display:

> Independent panels use seedream-v4.5 when available. Sequential pages still require the separate opt-in above.

## 13. Generation preflight

Run preflight before `chatCompletionStream()` for new-page, continue, and reroll attempts when image generation is enabled. Run the same preflight before an image-only regeneration or missing-image retry.

Preflight must:

1. Read image pipeline settings.
2. Migrate companion mode if needed.
3. Load normalized model metadata with the 20-second bound.
4. Resolve the page and companion models.
5. Determine which models can be used during this attempt.
6. Validate or correct the page-wide image size.
7. Return a resolved configuration object that is passed into image generation; do not re-resolve settings halfway through the attempt.

### 13.1 Required model set

- Non-sequential page model: validate only the page model.
- Sequential page model with sequential disabled: validate the resolved companion.
- Sequential page model with sequential enabled: validate the sequential page model and the companion because reference or output capacity may still require independent fallback.

### 13.2 Image-size selection

If the saved size is supported by every model that may be used, retain it.

If it is not supported:

1. Prefer `1920x1920` when it exists in the required models' size intersection.
2. Otherwise choose the first size from the page model's advertised order that exists in the intersection.
3. Persist the corrected `imageSize` setting and record the correction.

If sequential mode is enabled but the sequential model and companion have no common size:

- Disable sequential batching for this attempt only.
- Choose a companion-supported size for independent panels.
- Record a visible warning.
- Do not change the saved `enableSequentialPages` preference.

If a successful live fetch proves that no usable size or selected custom model exists, block before the story request and link the user to Settings.

If metadata is unavailable because the fetch timed out or the app is offline, continue with normalized cache or conservative behavior and show a warning. Lack of metadata is not treated as proof that a model or size is unsupported.

### 13.3 Preflight reuse

`generateContinuityPageImages()` receives the resolved configuration. It must not fetch the same model list again for each allocation or request. `generateImages()` may still perform defensive validation against the in-memory normalized cache.

## 14. Persistence and diagnostics

### 14.1 Generation record

Increment the stored generation metadata to schema version 2 while preserving the existing prompt and reference fields:

```ts
interface StoredGenerationAttempt {
  schemaVersion: 2;
  attemptId: string;
  context: GenerationContext;
  outcome: 'complete' | 'partial' | 'failed';
  strategy: 'sequential-page' | 'independent-panels';
  modelId: string;
  singleImageModelId?: string;
  companionMode?: CompanionMode;
  resolution: string;
  promptVersion: string;
  compiledPrompts: string[];
  referenceManifest: unknown[];
  startedAt: number;
  completedAt: number;
  elapsedMs: number;
  requestSummary: Array<{
    requestId: string;
    panelIndexes: number[];
    modelId: string;
    outcome: 'complete' | 'failed' | 'timed-out';
    elapsedMs: number;
    receivedImageCount: number;
    expectedImageCount: number;
    failure?: SafeGenerationFailure;
  }>;
  warnings: string[];
}
```

Do not persist active timer handles, abort controllers, raw response bodies, or the API key.

### 14.2 Safe failure shape

```ts
interface SafeGenerationFailure {
  code:
    | 'GENERATION_TIMEOUT'
    | 'HTTP_ERROR'
    | 'INVALID_CONFIGURATION'
    | 'INVALID_RESPONSE'
    | 'LOCAL_PERSISTENCE_ERROR'
    | 'UNKNOWN_ERROR';
  phase: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  modelId?: string;
  resolution?: string;
  panelIndexes?: number[];
  providerRequestId?: string;
  elapsedMs?: number;
}
```

Capture a provider request ID only when it is explicitly returned in a known response header or body field. Do not invent one.

### 14.3 Redaction

`Copy details` includes:

- App version.
- Attempt ID.
- Context and stage/outcome.
- Model IDs and resolution.
- Strategy and counts.
- Timing.
- Safe failures and warnings.
- Whether model metadata came from live data, current cache, legacy fallback, or static fallback.

It excludes:

- NanoGPT API key or Authorization header.
- Base64 image or reference data.
- Signed result URL query strings.
- Full compiled prompts.
- Full story response.
- Character or world image data URLs.

The stored page may continue containing compiled prompts as required by the continuity spec; the copyable diagnostic bundle is deliberately narrower.

## 15. Targeted retry

Add **Retry missing images** when a saved page has at least one image-bearing panel without a usable `imageUrl`.

The retry:

1. Reuses the page's stored `planned` data and `renderStates`.
2. Targets only missing or explicitly failed panel indexes.
3. Runs current configuration preflight.
4. Uses independent panel requests through the resolved companion model, even if the original attempt used sequential batching.
5. Does not call the story model.
6. Does not alter narration, dialogue, choices, `continuityBefore`, or `continuityAfter`.
7. Updates only the targeted panels and appends or replaces their retry attempt metadata.
8. Commits the modified page record after all targeted requests become terminal.
9. Leaves existing successful images unchanged.

Before submission, show:

> This retries 1 image request. A timed-out provider job from the previous attempt may still complete or incur cost.

The action requires explicit confirmation when the preceding failure was a timeout. Ordinary immediate HTTP failures may proceed after the button click without an additional modal.

## 16. Failure and cancellation behavior

| Situation                              | Required behavior                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| User cancels during story streaming    | Abort, restore prior state as today, do not save a new page.                        |
| User cancels during image generation   | Abort all active requests, ignore late events, preserve re-roll/re-image backups.   |
| One independent panel returns HTTP 500 | Keep other panels, mark one failed, save a partial page.                            |
| One independent panel never settles    | Time it out, keep other panels, save a partial page.                                |
| Sequential request times out           | Mark all missing target panels timed out and save the story plan.                   |
| Sequential response is short           | Keep index-mapped results and mark only absent indexes failed.                      |
| Result URL download times out          | Keep the remote URL, warn that it may expire, do not regenerate automatically.      |
| Model metadata times out               | Use normalized fallback data, warn, and route conservatively.                       |
| Live metadata proves custom model gone | Block before story generation and direct the user to Settings.                      |
| Saved image size is invalid            | Select and persist the deterministic supported replacement before story generation. |
| Story JSON cannot be parsed            | Stop before images, retain a persistent failure summary, allow a story retry.       |
| IndexedDB page save fails              | Show a persistent save failure; do not report the page as complete.                 |

The top-level UI must never return to setup or reading with only a disappearing toast as the record of a failure.

## 17. Implementation plan

### Phase 1 — Progress state and persistent UI

- Add `generation-progress.ts` and pure transition tests.
- Replace the mutually exclusive loading/stream blocks with one progress card.
- Put streamed story output in a disclosure inside the card.
- Add elapsed-time and soft-stall rendering.
- Guard all updates by attempt ID.
- Preserve Cancel in every active phase.

### Phase 2 — Bounded network operations

- Add timeout/cancellation signal composition.
- Bound image model metadata, image generation, response parsing, and signed URL persistence.
- Add typed timeout classification.
- Add progress callbacks to the image API.
- Persist remote URLs as a fallback when local conversion fails.

### Phase 3 — Resilient orchestration

- Pre-register image requests.
- Replace independent `Promise.all()` completion dependency with explicit settled results.
- Persist sequential short responses and independent partial results.
- Ensure generation metadata finalization runs after failures and timeouts.
- Reuse compressed references per attempt.

### Phase 4 — Configuration repair and preflight

- Version and normalize image-model cache reads.
- Add migration refresh and retry throttling.
- Add companion mode, lazy migration, and exact resolver.
- Add model/size preflight before story generation.
- Pass one resolved config through the entire attempt.

### Phase 5 — Recovery and diagnostics

- Store schema-version-2 attempt summaries.
- Add persistent page failure summaries.
- Add redacted Copy details.
- Add Retry missing images.
- Preserve whole-page Re-images as a separate deliberate action.

### Phase 6 — Verification and release

- Run unit, integration, type, lint, build, and browser tests.
- Perform one controlled live independent Seedream request with `n: 1`.
- Verify slow-state and hard-timeout UI with a local mocked hanging fetch, not by intentionally paying for a ten-minute live request.
- Keep sequential default off regardless of these results.

## 18. File-level impact

| File                                     | Change                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/js/generation-progress.ts`          | New pure progress model, timeout error, selectors, formatting, redacted diagnostics.  |
| `src/js/image-generation-config.ts`      | New pure companion migration/resolution and image-size preflight helpers.             |
| `src/js/api.ts`                          | Bounded fetches, cache migration, progress callbacks, safe errors, compression reuse. |
| `src/js/pages/create.ts`                 | Persistent progress UI, preflight wiring, settled orchestration, partial save, retry. |
| `src/js/pages/settings.ts`               | Companion modes, effective route, image timeout setting, corrected size behavior.     |
| `src/css/app.css`                        | Progress card, slow notice, terminal summary, responsive detail rows.                 |
| `test/generation-progress.test.js`       | Progress transitions, timer selectors, stale attempt guards, redaction.               |
| `test/image-generation-config.test.js`   | Companion migration/resolution and deterministic size selection.                      |
| `test/api-images.test.js`                | Image timeout, cancellation distinction, progress events, partial/short results.      |
| `test/api-integration.test.js`           | Legacy cache normalization, refresh, fallback, and retry throttling.                  |
| `test/e2e/smoke.spec.js` or new E2E file | Persistent post-story progress, slow notice, timeout recovery, targeted retry.        |

No IndexedDB object-store version bump is required because new settings and page metadata are additive. Existing pages with generation schema version 1 remain readable.

## 19. Test requirements

### 19.1 Progress model

- Every attempt starts with a unique ID and an active outcome.
- Stage transitions update `stageStartedAt` and `lastActivityAt` correctly.
- Elapsed formatting handles seconds, minutes, and hours.
- Soft stall begins at the exact threshold and clears after observable activity.
- Terminal requests no longer count as soft-stalled.
- Late events from a previous attempt are ignored.
- Diagnostics redact data URLs, signed query strings, prompts, and secret-like fields.

### 19.2 Timeout behavior

- A fetch that never resolves rejects with `GenerationTimeoutError` at the configured bound.
- User abort before the timer remains `AbortError` and is classified as cancelled.
- Timer abort is not misclassified as user cancellation.
- Timeout listeners and timers are cleaned up after success, failure, and abort.
- Metadata timeout returns normalized cache or static fallback.
- Result-download timeout returns the original URL and a warning.
- Concurrent result downloads finish within one timeout window, not one window per image.

Use fake timers and fetch doubles; unit tests must not wait in real time.

### 19.3 Independent partial completion

- Four successful requests produce four images and a complete outcome.
- Three successes plus one HTTP failure produce three images and a partial outcome.
- Three successes plus one hanging request finish after the hard timeout and save a partial page.
- A failed panel stores a concise `generationError` and structured safe failure.
- Successful panels remain unchanged when the failed panel is retried.
- No automatic retry occurs.

### 19.4 Sequential behavior

- One request is registered for an eligible page.
- A four-entry response maps strictly by index.
- A short response keeps returned indexes and marks missing indexes failed.
- A timed-out request marks every still-empty target panel timed out.
- Sequential remains disabled when the setting is missing or false.
- No test in this patch changes the default to true.

### 19.5 Cache migration

- A legacy cache entry is normalized on read.
- A legacy cache bypasses its old TTL for one bounded refresh attempt.
- Successful refresh writes schema version 2.
- Failed refresh returns normalized legacy data without marking migration complete.
- Failed migration refresh is not repeated before the five-minute retry time.
- A current schema cache with legitimately missing fields does not refresh repeatedly.
- `getModelSizes()` reads normalized cache data.

### 19.6 Companion migration

- Missing mode plus non-empty companion becomes `custom` without changing the model ID.
- Missing mode plus blank companion becomes `auto`.
- Auto maps `seedream-v4.5-sequential` to `seedream-v4.5` when available.
- Auto falls back visibly when the standard model is unavailable.
- Same mode deliberately keeps `seedream-v4.5-sequential` for `n: 1` requests.
- A stale companion never hijacks a non-sequential page model.
- A missing custom model blocks only when a successful live fetch proves it missing.

### 19.7 Preflight

- A valid saved size remains unchanged.
- An invalid size chooses `1920x1920` when it is in the required-model intersection.
- Otherwise, selection follows advertised order deterministically.
- No common sequential/companion size disables sequential for that attempt only.
- The corrected size is persisted before the story request.
- Metadata unavailability warns and continues; confirmed invalid configuration blocks.
- Image-only retries run preflight without calling the story model.

### 19.8 UI and browser behavior

- The progress card remains visible when the story stream opens.
- The active stage changes after story completion.
- Model, route, request count, image count, and elapsed time render after routing.
- The soft-stall notice appears without changing the attempt to failed.
- A hard timeout ends the attempt and reaches the reading view with a partial page.
- Copy details contains no API key, base64 payload, full prompt, or signed query string.
- Cancel remains usable in every active phase.
- Mobile layout does not overflow on long model IDs or error messages.

## 20. Acceptance criteria

The patch is complete only when all of the following are true:

1. There is no point during a normal generation attempt when both the spinner/status and a terminal result are absent from the visible UI.
2. Once the story response finishes, the UI identifies the exact active post-prompt phase.
3. Once routing is known, the UI shows the effective model, sequential-versus-independent strategy, request count, and image count.
4. A pending image request shows a slow warning after 120 seconds.
5. No image provider request remains awaited beyond the configured hard timeout plus normal event-loop cleanup.
6. No signed result URL download remains awaited beyond 30 seconds plus normal event-loop cleanup.
7. One hanging independent panel cannot keep the page in generating state forever.
8. Successful panel images survive sibling request failures and timeouts.
9. A valid story plan and continuity snapshots are saved after a non-cancel image failure or timeout.
10. Sequential failures and timeouts still produce schema-version-2 generation metadata.
11. A saved partial page exposes Retry missing images and Copy details.
12. Retry missing images does not call the story model or replace successful images.
13. A pre-1.6.79 image-model cache cannot bypass normalization or suppress a one-time bounded capability refresh.
14. An upgraded blank companion resolves to `seedream-v4.5` for independent Seedream 4.5 panels when that model is available.
15. The effective companion is shown to the user before image requests are submitted.
16. Confirmed invalid model/size configuration is caught before the story request.
17. Diagnostics contain no API key, Authorization value, base64 reference, full prompt, or signed URL query string.
18. Existing generation-schema-1 pages remain readable.
19. Legacy image generation and character/world image generation continue to work through `generateImage()`.
20. `enableSequentialPages` still defaults to `false`.
21. Unit tests, typecheck, production build, and browser smoke tests pass. Lint has no new warnings.

## 21. Manual verification matrix

| Case | Page model                     | Sequential toggle | Companion mode | Expected route and result                                      |
| ---- | ------------------------------ | ----------------- | -------------- | -------------------------------------------------------------- |
| A    | `seedream-v4.5-sequential`     | Off               | Auto           | Independent requests through `seedream-v4.5`.                  |
| B    | `seedream-v4.5-sequential`     | Off               | Same           | Independent `n: 1` requests through the sequential model.      |
| C    | `seedream-v4.5-sequential`     | On                | Auto           | One sequence only when current routing constraints allow it.   |
| D    | `seedream-v4.5-sequential`     | On                | Auto           | Independent standard-model fallback when constraints require.  |
| E    | `seedream-v4.5`                | Either            | Stale custom   | Standard model; stale companion ignored.                       |
| F    | Any supported image model      | Off               | Auto           | Current non-sequential behavior with visible bounded progress. |
| G    | Sequential, one request hangs  | On                | Auto           | Timeout, story saved, missing panels retryable.                |
| H    | Sequential, one short response | On                | Auto           | Returned indexes kept; missing indexes shown and retryable.    |
| I    | Independent, one request hangs | Off               | Auto           | Other panels saved; only hanging panel timed out.              |
| J    | Any, result URL download hangs | Either            | Any            | Remote URL retained with expiry warning; no paid retry.        |

Cases C and D verify application routing only. They do not satisfy the live sequential output-order release gate.

## 22. Release gates

This patch may ship when:

- All acceptance criteria pass.
- The timeout and partial-result paths are tested with deterministic mocked fetches.
- One controlled live `seedream-v4.5` independent request confirms that the companion route still works through NanoGPT.
- The version is bumped according to the repository's patch-release workflow.

The following remain separate gates before sequential generation can ever become the default:

- Live proof that `data[i]` consistently corresponds to `IMAGE i + 1` for `seedream-v4.5-sequential` through the actual NanoGPT route.
- The visual benchmark defined by the continuity specification.
- An explicit later product decision to change the default.

Until those gates pass, the honest default remains structured anchored continuity with bounded, observable independent panel generation through the standard Seedream 4.5 companion.
