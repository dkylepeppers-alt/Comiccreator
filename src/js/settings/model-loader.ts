/**
 * Typed, DOM/`API`-free model catalog loader.
 *
 * Extracted from `pages/settings.ts`'s `loadModels()` so the fetch/fallback/caption-derivation
 * decision logic can be unit-tested and strictly typed independently of the status-text/count-el/
 * `renderModelList` DOM concerns, which stay in `settings.ts`. The real `API.fetchTextModels` /
 * `API.fetchImageModels` already catch their own network errors and resolve with a cached-or-
 * fallback value rather than rejecting, so the failure branch below is only reachable in
 * production via a genuinely unexpected rejection — it is exercised directly here via injected
 * dependencies that do reject, which is what makes it testable at all.
 */

import type { TextModel, ImageModel } from '../model-catalog.js';

/** Which catalog to load: the text/chat model list, or the image generation model list. */
export type ModelKind = 'text' | 'image';

/**
 * Everything `loadModelCatalog` needs from the outside world. Deliberately has no DOM or `App`
 * dependency so it can run in a plain unit test.
 */
export interface ModelLoaderDependencies {
  readonly fetchText: (forceRefresh: boolean) => Promise<readonly TextModel[]>;
  readonly fetchImage: (forceRefresh: boolean) => Promise<readonly ImageModel[]>;
  /** Model IDs used to build fallback text-model records when `fetchText` fails. */
  readonly fallbackTextModelIds: readonly string[];
  /** Model IDs used to build fallback image-model records when `fetchImage` fails. */
  readonly fallbackImageModelIds: readonly string[];
}

/** Result of one `loadModelCatalog` call. Has no DOM or `App` dependency. */
export interface ModelLoadResult {
  /** The loaded (or fallback) models for the requested `kind`. */
  readonly models: readonly (TextModel | ImageModel)[];
  /**
   * Vision-capable subset of `models`, only meaningful for `kind === 'text'` (the caption-model
   * picker). Always `[]` for `kind === 'image'` — image models have no `supports_vision` concept
   * and the legacy caller never touched caption state when loading the image catalog.
   */
  readonly captionModels: readonly TextModel[];
  /** `true` when the live fetch failed and the returned models are the static fallback list. */
  readonly usedFallback: boolean;
  /** The error caught from the fetch, present only when `usedFallback` is `true`. */
  readonly error?: unknown;
}

/**
 * Vision-capable subset of a text model list, for the caption-model picker.
 * `supports_vision === false` means explicitly no vision; `undefined`/`true` means attempt it.
 */
function deriveCaptionModels(models: readonly TextModel[]): readonly TextModel[] {
  return models.filter((m) => m.supports_vision !== false);
}

/** Build a minimal fallback model record from a bare model ID, matching the legacy shape exactly. */
function toFallbackModel(id: string): TextModel & ImageModel {
  return { id, name: id, owned_by: '' };
}

/**
 * Load the text or image model catalog, applying the same fallback and caption-derivation rules
 * as the legacy inline `loadModels()`. Never rejects: fetch failures are reported as data
 * (`usedFallback: true`, `error` set) for the caller to log and render.
 */
export async function loadModelCatalog(
  kind: ModelKind,
  forceRefresh: boolean,
  dependencies: ModelLoaderDependencies,
): Promise<ModelLoadResult> {
  if (kind === 'text') {
    try {
      const models = await dependencies.fetchText(forceRefresh);
      return { models, captionModels: deriveCaptionModels(models), usedFallback: false };
    } catch (error) {
      // Fallback text models are treated as ALL caption-capable, per the legacy behavior.
      const fallback = dependencies.fallbackTextModelIds.map(toFallbackModel);
      return { models: fallback, captionModels: fallback, usedFallback: true, error };
    }
  }

  try {
    const models = await dependencies.fetchImage(forceRefresh);
    return { models, captionModels: [], usedFallback: false };
  } catch (error) {
    const fallback = dependencies.fallbackImageModelIds.map(toFallbackModel);
    return { models: fallback, captionModels: [], usedFallback: true, error };
  }
}
