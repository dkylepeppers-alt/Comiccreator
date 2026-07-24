import DB from '../db.js';
import API from '../api.js';
import {
  RESULT_DOWNLOAD_TIMEOUT_MS,
  addWarning,
  enterStage,
  finishAttempt,
  registerRequests,
  runWithTimeout,
  setRoute,
  toSafeDiagnostics,
  toSafeGenerationFailure,
  updateRequest,
} from '../generation-progress.js';
import {
  migrateCompanionSettings,
  resolveCompanionModel,
  selectCompatibleImageSize,
} from '../image-generation-config.js';
import { PROMPT_VERSION } from '../visual-continuity.js';
import { sanitizeImagePrompt } from '../utils.js';
import { createReferenceRepository } from '../references/repository.js';
import { resolvePanelReferences } from '../references/resolver.js';
import { modelSupportsImageInput } from '../model-catalog.js';
import type { PanelReferenceRequest } from '../references/types.js';
import { runContinuityGeneration } from './continuity/orchestrator.js';
import type { CreateState, GenerationContext } from './types.js';
import type { GenerateImagesOptions, GeneratedImage, ImageApiProgressEvent, LabeledRef } from '../api.js';
import type {
  ContinuityGeneratedImage,
  ContinuityImageProgressEvent,
  ContinuityImageRequestOptions,
} from './continuity/types.js';

/**
 * Image-generation engine for the create page: preflight model/config
 * resolution, the legacy independent-panel pipeline, and the anchored-
 * continuity pipeline (sequential page or independent panel requests).
 *
 * All page-state access goes through the GenerationContext passed by the
 * caller; this module holds no mutable state of its own.
 */

/** Per-panel request options built by the legacy independent-panel pipeline. */
interface LegacyPanelImageOptions {
  resolution: string;
  negativePrompt?: string;
  imageDataUrl?: string;
  imageDataUrls?: string[];
  labeledRefs?: LabeledRef[];
  signal?: AbortSignal;
  requestId?: string;
  onProgress?: (event: ImageApiProgressEvent) => void;
}

const referenceRepository = createReferenceRepository();

/** Map image-API progress events onto the attempt's request/stage state. */
function reportImageApiProgress(ctx: GenerationContext, event: ImageApiProgressEvent) {
  const progress = ctx.state.generationProgress;
  if (!progress || !event.requestId) return;
  const request = progress.requests.find((item) => item.id === event.requestId);
  if (!request) return;
  const states = {
    'preparing-references': 'preparing',
    submitting: 'pending',
    waiting: 'pending',
    'response-received': 'response-received',
    'response-parsed': 'response-received',
  } as const;
  const stageByPhase = {
    'preparing-references': ['preparing-references', 'Preparing reference images…'],
    submitting: ['submitting-images', 'Submitting image requests…'],
    waiting: ['waiting-for-images', 'Waiting for image generation…'],
    'response-received': ['waiting-for-images', 'Image response received…'],
    'response-parsed': ['persisting-images', 'Saving returned images locally…'],
  } as const;
  const stage = stageByPhase[event.phase];
  const staged = stage ? enterStage(progress, stage[0], stage[1], event.at) : progress;
  ctx.setProgress(
    updateRequest(
      staged,
      event.requestId,
      {
        state: states[event.phase] || request.state,
        startedAt: request.startedAt || (event.phase === 'submitting' ? event.at : undefined),
        receivedImageCount: event.receivedImageCount ?? request.receivedImageCount,
      },
      event.at,
    ),
  );
}

export function generationOutcomeForPage(page, enableImages = true) {
  if (!enableImages) return 'complete';
  const imagePanels = (page?.panels || []).filter(
    (panel) => panel.imagePrompt || panel.generationError || panel.imageUrl,
  );
  const complete = imagePanels.filter((panel) => panel.imageUrl).length;
  return complete === imagePanels.length ? 'complete' : 'partial';
}

export function attachGenerationAttempt(ctx: GenerationContext, page, outcome) {
  if (!page?.generation || !ctx.state.generationProgress) return;
  page.generation.attempt = JSON.parse(toSafeDiagnostics(finishAttempt(ctx.state.generationProgress, outcome)));
}

export function ensureFailureGenerationMetadata(ctx: GenerationContext, page, error) {
  const failure = toSafeGenerationFailure(error, 'image-request');
  (page?.panels || []).forEach((panel) => {
    if (!panel.imageUrl) panel.generationError = panel.generationError || failure.message;
  });
  page.generation ||= {
    schemaVersion: 2,
    strategy: ctx.state.generationProgress?.strategy || 'independent-panels',
    modelId: ctx.state.imageGenerationConfig?.pageModelId || 'unknown',
    singleImageModelId: ctx.state.imageGenerationConfig?.companionModelId,
    resolution: ctx.state.imageGenerationConfig?.imageSize,
    promptVersion: PROMPT_VERSION,
    compiledPrompts: [],
    referenceManifest: [],
    generatedAt: Date.now(),
    outcome: 'partial',
    failures: [{ panelIndexes: (page?.panels || []).map((_, index) => index), ...failure }],
  };
}

/** Convert an image API result (url or b64) to a persistent data URL when possible. */
async function imageResultToDataUrl(
  value: string,
  source: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ value: string; persisted: boolean; warning?: string }> {
  if (!value) return { value: '', persisted: false };
  if (source === 'b64_json' || (!value.startsWith('http') && !value.startsWith('data:'))) {
    return { value: value.startsWith('data:') ? value : `data:image/png;base64,${value}`, persisted: true };
  }
  if (value.startsWith('data:')) return { value, persisted: true };
  // Remote URLs may be signed and expire — persist as data URL before commit
  try {
    const persisted = await runWithTimeout(
      async (signal) => {
        const resp = await fetch(value, { signal });
        if (!resp.ok) throw new Error(`Image download failed (HTTP ${resp.status})`);
        const blob = await resp.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error || new Error('Could not store returned image'));
          reader.readAsDataURL(blob);
        });
      },
      { signal: options.signal, timeoutMs: options.timeoutMs ?? RESULT_DOWNLOAD_TIMEOUT_MS, phase: 'result-download' },
    );
    return { value: persisted, persisted: true };
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    return {
      value,
      persisted: false,
      warning: 'A returned image could not be saved locally; its temporary URL may expire.',
    };
  }
}

/**
 * Cross-page continuity reference: the previous page's last panel that has a
 * locally stored image. Optional — omitted when it would displace an anchor.
 */
function getPreviousFrameRef(state: CreateState) {
  for (let p = state.pages.length - 1; p >= 0; p--) {
    const page = state.pages[p];
    const panels = page?.panels || [];
    for (let i = panels.length - 1; i >= 0; i--) {
      const url = panels[i]?.imageUrl;
      if (url && url.startsWith('data:')) {
        return { dataUrl: url, sourcePageId: state.pageIds[p], sourcePanelIndex: i };
      }
    }
  }
  return null;
}

/**
 * Resolve the image model configuration for this attempt: page model,
 * companion model, compatible size, and any warnings. Caches the result on
 * state.imageGenerationConfig; returns null when images are disabled.
 */
export async function preflightImageGeneration(ctx: GenerationContext) {
  const progress = ctx.state.generationProgress;
  if (progress) ctx.setProgress(enterStage(progress, 'checking-settings', 'Checking image model and settings…'));
  const enableImages = await DB.getSetting('enableImages', true);
  if (!enableImages) {
    ctx.state.imageGenerationConfig = null;
    return null;
  }
  const pageModelId = (await DB.getSetting('imageModel', '')) || 'gpt-image-1';
  const models = await API.fetchImageModels(false, { signal: ctx.signal() });
  const source = API.getImageModelSource();
  const pageModel = models.find((model) => model.id === pageModelId) || null;
  if (!pageModel && source === 'live') throw new Error(`The selected image model "${pageModelId}" is not available.`);
  const pageModelWarning =
    !pageModel && (source === 'cache-fresh' || source === 'cache-degraded')
      ? `The selected image model "${pageModelId}" was not found in the cached model list; generation will continue but may fail if the model is unavailable.`
      : null;

  const companionSettings = migrateCompanionSettings(
    await DB.getSetting('singleImageCompanionMode', null),
    await DB.getSetting('singleImageModel', ''),
  );
  if (companionSettings.migrated) await DB.setSetting('singleImageCompanionMode', companionSettings.mode);
  const companion = resolveCompanionModel({
    pageModelId,
    mode: companionSettings.mode,
    configuredModelId: companionSettings.configuredModelId,
    models,
  });
  if (companion.error && (source === 'live' || companion.errorCode === 'blank-custom'))
    throw new Error(companion.error);
  // Availability could not be verified live, so demote the companion error to a
  // non-blocking warning (blank custom was already thrown above).
  const companionWarning = companion.error && source !== 'live' ? companion.error : null;
  const companionModel = models.find((model) => model.id === companion.modelId) || null;
  const sequentialSaved = await DB.getSetting('enableSequentialPages', false);
  const savedSize = await DB.getSetting('imageSize', '1024x1024');
  const size = selectCompatibleImageSize({
    savedSize,
    pageModel,
    companionModel,
    sequentialEnabled: sequentialSaved,
  });
  if (size.corrected) await DB.setSetting('imageSize', size.size);
  const warnings = [
    pageModelWarning,
    companionWarning,
    companion.warning,
    size.warning,
    source === 'cache-degraded'
      ? 'Live image-model metadata could not be fetched; using cached model data that may be stale.'
      : null,
    source === 'fallback'
      ? 'Live image-model metadata is unavailable; generation will continue with conservative model defaults.'
      : null,
  ].filter(Boolean);
  ctx.state.imageGenerationConfig = {
    pageModelId,
    pageModel,
    companionModelId: companion.modelId,
    companionModel,
    companionMode: companionSettings.mode,
    imageSize: size.size,
    sequentialEnabled: size.sequentialEnabled,
    warnings,
  };
  if (progress) {
    let next = setRoute(progress, {
      pageModelId,
      effectiveImageModelId: companion.modelId,
      resolution: size.size,
    });
    for (const warning of warnings) next = addWarning(next, warning);
    ctx.setProgress(next);
  }
  for (const warning of warnings) ctx.toast(warning, 'info');
  return ctx.state.imageGenerationConfig;
}

/**
 * Generate images for all panels in pageData that have an imagePrompt.
 * Reads settings and state internally; updates panel.imageUrl in place.
 * @param {Object} ctx - generation context supplied by the create page
 * @param {Object} pageData - page object with panels array
 * @param {HTMLElement|null} uiMsg   - optional element for status message updates
 */
export async function generatePanelImages(ctx: GenerationContext, pageData: any, uiMsg): Promise<void> {
  const imageResolution = await DB.getSetting('imageSize', '1024x1024');
  const dynamicSizesEnabled = await DB.getSetting('dynamicImageSizes', false);
  const includeAppearance = await DB.getSetting('includeAppearanceText', true);
  const imagePresetData = ctx.state.selectedImagePreset
    ? await DB.get(DB.STORES.imagePresets, ctx.state.selectedImagePreset)
    : null;
  const imagePromptPrefix = imagePresetData?.promptPrefix || (await DB.getSetting('imagePromptPrefix', ''));
  const maxRefImages = await DB.getSetting('maxRefImages', 4);
  const refSettingEnabled = await DB.getSetting('useRefImages', true);
  // The legacy pipeline sends panel requests without a model override, so the
  // configured image model is the one that must accept reference images.
  const imageModelId = await DB.getSetting('imageModel', 'gpt-image-1');
  const imageModelMeta = await API.getImageModelMeta(imageModelId, { signal: ctx.signal() });
  const modelAcceptsReferences = modelSupportsImageInput(imageModelMeta) !== false;
  if (refSettingEnabled && !modelAcceptsReferences) {
    ctx.toast(`${imageModelId} does not accept reference images — generating without them`, 'info');
  }
  const useReferenceImages = refSettingEnabled && modelAcceptsReferences;
  const enrichEnabled = await DB.getSetting('enrichImagePrompts', false);
  const negativePrompt = await DB.getSetting('negativePrompt', '');
  const worldId = ctx.state.selectedWorld || ctx.state.world?.id || '';
  const referenceAssets = useReferenceImages && worldId ? await referenceRepository.listByWorld(worldId) : [];
  const preferredReferenceIds = Object.fromEntries(
    ctx.state.characters.flatMap((character) =>
      character.preferredIdentityReferenceId ? [[character.id, character.preferredIdentityReferenceId]] : [],
    ),
  );
  if (ctx.state.world?.preferredStyleReferenceId) {
    preferredReferenceIds.style = ctx.state.world.preferredStyleReferenceId;
  }
  const pinnedReferenceIds = ctx.state.visualContinuity?.pinnedReferenceIds || {};
  const previousFrame = getPreviousFrameRef(ctx.state);
  // Cache enriched prompts within this page generation to avoid duplicate LLM calls
  const promptEnrichmentCache = new Map();

  // Check if a character name appears in a panel prompt using word-boundary matching
  function nameInPrompt(name, text) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'i').test(text);
  }

  // Build per-panel image options through the canonical deterministic resolver.
  async function buildPanelImageOpts(panel): Promise<LegacyPanelImageOptions> {
    // Use AI-picked size when dynamic sizing is enabled and the AI provided a valid WxH value
    let resolution = imageResolution;
    if (dynamicSizesEnabled && panel.imageSize) {
      const trimmed = panel.imageSize.trim();
      if (/^\d+x\d+$/i.test(trimmed)) {
        resolution = trimmed.toLowerCase();
      }
    }
    const opts: LegacyPanelImageOptions = { resolution };
    if (negativePrompt) opts.negativePrompt = negativePrompt;
    if (!useReferenceImages || !worldId) return opts;

    const fallbackCharacterIds = ctx.state.characters
      .filter((character) => nameInPrompt(character.name, panel.imagePrompt))
      .map((character) => character.id);
    const request: PanelReferenceRequest = panel.referenceRequest || {
      worldId,
      characterIds: fallbackCharacterIds,
      locationId: null,
      characterStates: {},
      interaction: null,
      facets: {},
      propNames: [],
    };
    const resolutionResult = resolvePanelReferences({
      request: { ...request, worldId },
      assets: referenceAssets,
      budget: maxRefImages,
      preferredReferenceIds,
      pinnedReferenceIds,
      manualReferenceIds: panel.manualReferenceIds || [],
      previousFrame,
    });
    if (resolutionResult.error) throw new Error(resolutionResult.error.detail);

    panel.referenceManifest = resolutionResult.manifest;
    if (resolutionResult.dataUrls.length > 0) {
      opts.imageDataUrls = [...resolutionResult.dataUrls];
      opts.labeledRefs = resolutionResult.manifest.map((item, index) => ({
        dataUrl: resolutionResult.dataUrls[index],
        label: item.label,
        description: item.role,
        type: item.role,
      }));
    }
    return opts;
  }

  // Build enhanced image prompt: sanitize narrative noise, prepend prefix, append
  // appearance text, and (when enrichment is enabled) expand via LLM.
  async function buildEnhancedImagePrompt(panel) {
    let prompt = sanitizeImagePrompt(panel.imagePrompt);
    // Only prepend the prefix if the LLM didn't already include it (the system
    // prompt now instructs the LLM to start imagePrompts with the preset text).
    if (imagePromptPrefix && !prompt.toLowerCase().startsWith(imagePromptPrefix.toLowerCase())) {
      prompt = `${imagePromptPrefix}, ${prompt}`;
    }
    if (includeAppearance) {
      const panelAppearances = ctx.state.characters
        .filter((c) => c.appearance && c.appearance.trim() && nameInPrompt(c.name, panel.imagePrompt))
        .map((c) => `${c.name}: ${c.appearance.trim()}`)
        .join('; ');
      if (panelAppearances) prompt = `${prompt}. Characters in scene: ${panelAppearances}`;
    }
    if (enrichEnabled) {
      // promptEnrichmentCache is scoped to this generatePanelImages() call and
      // cleared on each invocation, so enrichEnabled is stable for its lifetime.
      if (promptEnrichmentCache.has(prompt)) return promptEnrichmentCache.get(prompt);
      const genre = ctx.state.genre === 'custom' ? ctx.state.customGenre || '' : ctx.state.genre || '';
      const enriched = await API.enrichImagePrompt(prompt, { genre });
      promptEnrichmentCache.set(prompt, enriched);
      return enriched;
    }
    return prompt;
  }

  const panelsWithImages = pageData.panels.filter((p) => p.imagePrompt).length;
  const legacyModel =
    ctx.state.imageGenerationConfig?.companionModelId || (await DB.getSetting('imageModel', 'gpt-image-1'));
  if (ctx.state.generationProgress) {
    let next = setRoute(ctx.state.generationProgress, {
      strategy: 'independent-panels',
      pageModelId: legacyModel,
      effectiveImageModelId: legacyModel,
      resolution: imageResolution,
      expectedImageCount: panelsWithImages,
    });
    next = registerRequests(
      next,
      pageData.panels
        .map((panel, index) =>
          panel.imagePrompt
            ? { id: `panel-${index + 1}`, panelIndexes: [index], modelId: legacyModel, expectedImageCount: 1 }
            : null,
        )
        .filter(Boolean),
    );
    ctx.setProgress(enterStage(next, 'preparing-references', 'Preparing reference images…'));
  }
  let doneCount = 0;
  await Promise.all(
    pageData.panels.map(async (panel, panelIndex) => {
      if (!panel.imagePrompt) return;
      try {
        const panelOpts = await buildPanelImageOpts(panel);
        panelOpts.signal = ctx.signal();
        panelOpts.requestId = `panel-${panelIndex + 1}`;
        panelOpts.onProgress = (event) => reportImageApiProgress(ctx, event);
        const enhancedPrompt = await buildEnhancedImagePrompt(panel);
        const imageData = await API.generateImage(enhancedPrompt, panelOpts);
        if (imageData) {
          if (imageData.startsWith('http')) {
            const saved = await imageResultToDataUrl(imageData, 'url', { signal: ctx.signal() });
            panel.imageUrl = saved.value;
            if (saved.warning) pageData.generationWarnings = [...(pageData.generationWarnings || []), saved.warning];
          } else if (imageData.startsWith('data:')) {
            panel.imageUrl = imageData;
          } else {
            panel.imageUrl = `data:image/png;base64,${imageData}`;
          }
          if (ctx.state.generationProgress)
            ctx.setProgress(
              updateRequest(ctx.state.generationProgress, `panel-${panelIndex + 1}`, {
                state: 'complete',
                receivedImageCount: 1,
                completedAt: Date.now(),
              }),
            );
        }
      } catch (imgErr) {
        if (imgErr?.name === 'AbortError') throw imgErr;
        ctx.logError('Image generation (panel)', imgErr);
        const failure = toSafeGenerationFailure(imgErr, 'image-request');
        panel.generationError = failure.message;
        if (ctx.state.generationProgress)
          ctx.setProgress(
            updateRequest(ctx.state.generationProgress, `panel-${panelIndex + 1}`, {
              state: failure.code === 'GENERATION_TIMEOUT' ? 'timed-out' : 'failed',
              failure,
              completedAt: Date.now(),
            }),
          );
        ctx.toast(`Panel image failed: ${failure.message}`, 'error');
      }
      doneCount++;
      if (uiMsg) uiMsg.textContent = `Generating images (${doneCount} / ${panelsWithImages})...`;
    }),
  );
  pageData.generation = {
    schemaVersion: 2,
    strategy: 'independent-panels',
    modelId: legacyModel,
    resolution: imageResolution,
    generatedAt: Date.now(),
    outcome: generationOutcomeForPage(pageData),
    failures: pageData.panels
      .map((panel, panelIndex) =>
        panel.generationError ? { panelIndexes: [panelIndex], message: panel.generationError } : null,
      )
      .filter(Boolean),
  };
}

// ── Compile-time drift guard ─────────────────────────────────────────────
// `continuity/types.ts` hand-mirrors these three api.ts shapes so the strict
// continuity core (tsconfig.core.json) never depends on the loosely-typed
// api.ts. Nothing else re-checks that the mirrors and the real shapes stay in
// sync (api.ts is deliberately excluded from the strict program, and this
// loose file's call-site checks alone wouldn't fail on drift) — if either side
// changes shape without the other, these lines turn red instead of the
// mismatch silently reaching runtime through the wiring below.
/* eslint-disable @typescript-eslint/no-unused-vars -- type-level assertions only, never referenced at runtime */
type AssertAssignable<_T extends _U, _U> = void;
type _CheckGenerateImagesOptionsMirror = AssertAssignable<ContinuityImageRequestOptions, GenerateImagesOptions>;
type _CheckGeneratedImageMirror = AssertAssignable<GeneratedImage, ContinuityGeneratedImage>;
type _CheckImageProgressEventMirror = AssertAssignable<ContinuityImageProgressEvent, ImageApiProgressEvent>;
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Anchored-continuity image generation for a planned page.
 * Requires pageData.planned and pageData.renderStates (set by generatePage,
 * or reused verbatim for whole-page image regeneration). Chooses between one
 * sequential page request and independent panel requests from live model
 * metadata, compiles deterministic prompts, and records generation metadata.
 */
export async function generateContinuityPageImages(
  ctx: GenerationContext,
  pageData: any,
  statusMsg: any,
  options: { panelIndexes?: number[] } = {},
): Promise<void> {
  const planned = pageData.planned;
  const renderStates = pageData.renderStates || [];
  const config = ctx.state.imageGenerationConfig || (await preflightImageGeneration(ctx));
  const modelId = config?.pageModelId || (await DB.getSetting('imageModel', '')) || 'gpt-image-1';
  const pageModel = config?.pageModel || (await API.getImageModelMeta(modelId, { signal: ctx.signal() }));
  const companionModelId = config?.companionModelId || modelId;
  const companionModel =
    config?.companionModel ||
    (companionModelId === modelId
      ? pageModel
      : await API.getImageModelMeta(companionModelId, { signal: ctx.signal() }));
  const imageSize = config?.imageSize || (await DB.getSetting('imageSize', '1024x1024'));
  const imagePresetData = ctx.state.selectedImagePreset
    ? await DB.get(DB.STORES.imagePresets, ctx.state.selectedImagePreset)
    : null;
  const charactersById = Object.fromEntries(ctx.state.characters.map((character) => [character.id, character]));
  const worldId = ctx.state.selectedWorld || ctx.state.world?.id || '';
  const referenceAssets = worldId ? await referenceRepository.listByWorld(worldId) : [];
  const preferredReferenceIds = Object.fromEntries(
    ctx.state.characters.flatMap((character) =>
      character.preferredIdentityReferenceId ? [[character.id, character.preferredIdentityReferenceId]] : [],
    ),
  );
  if (ctx.state.world?.preferredStyleReferenceId) {
    preferredReferenceIds.style = ctx.state.world.preferredStyleReferenceId;
  }
  const pinnedReferenceIds =
    pageData.continuityBefore?.pinnedReferenceIds || ctx.state.visualContinuity?.pinnedReferenceIds || {};
  const manualReferenceIdsByPanel = Object.fromEntries(
    planned.panels.flatMap((panel, panelIndex) =>
      panel.manualReferenceIds ? [[panelIndex, panel.manualReferenceIds]] : [],
    ),
  );
  const signal = ctx.signal();

  await runContinuityGeneration(
    {
      pageData,
      planningInput: {
        pageModelId: modelId,
        pageModel,
        companionModelId,
        companionModel,
        imageSize,
        sequentialEnabled: config?.sequentialEnabled ?? (await DB.getSetting('enableSequentialPages', false)),
        panels: planned.panels,
        renderStates,
        charactersById,
        selectedCharacterIds: ctx.state.selectedCharacters,
        world: ctx.state.world,
        worldId,
        referenceAssets,
        preferredReferenceIds,
        pinnedReferenceIds,
        manualReferenceIdsByPanel,
        referenceBudget: await DB.getSetting('refBudget', 'auto'),
        useReferenceImages: await DB.getSetting('useRefImages', true),
        previousFrame: getPreviousFrameRef(ctx.state),
        ...(options.panelIndexes ? { targetPanelIndexes: options.panelIndexes } : {}),
        stylePreset: imagePresetData?.promptPrefix || (await DB.getSetting('imagePromptPrefix', '')),
        negativePrompt: await DB.getSetting('negativePrompt', ''),
        warnings: config?.warnings || [],
      },
    },
    {
      generateImages: (prompt, generateOptions) => API.generateImages(prompt, generateOptions),
      persistImage: (value, source, persistOptions) => imageResultToDataUrl(value, source, persistOptions),
      startProgress: (plan, expectedImageCount) => {
        const progress = ctx.state.generationProgress;
        if (!progress) return;
        let next = setRoute(progress, {
          strategy: plan.strategy,
          pageModelId: plan.pageModelId,
          effectiveImageModelId: plan.effectiveModelId,
          resolution: plan.imageSize,
          expectedImageCount,
        });
        next = enterStage(next, 'preparing-references', 'Preparing reference images…');
        next = registerRequests(
          next,
          plan.requests.map(({ id, panelIndexes, modelId: requestModelId, expectedImageCount: requestCount }) => ({
            id,
            panelIndexes: [...panelIndexes],
            modelId: requestModelId,
            expectedImageCount: requestCount,
          })),
        );
        ctx.setProgress(next);
      },
      enterStage: (stage, message) => {
        if (ctx.state.generationProgress) {
          ctx.setProgress(enterStage(ctx.state.generationProgress, stage, message));
        }
      },
      updateRequest: (requestId, update) => {
        if (ctx.state.generationProgress) {
          ctx.setProgress(updateRequest(ctx.state.generationProgress, requestId, update));
        }
      },
      reportApiProgress: (event) => reportImageApiProgress(ctx, event),
      setStatus: (message) => {
        if (statusMsg) statusMsg.textContent = message;
      },
      signal,
      toast: (message, type) => ctx.toast(message, type),
      logError: (context, error) => ctx.logError(context, error),
    },
  );
}
