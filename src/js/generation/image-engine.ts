// @ts-nocheck — extracted from pages/create.ts, which is typed the same way;
// incremental typing of the engine internals is planned follow-up work.
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
import {
  PROMPT_VERSION,
  collectPageCast,
  collectPanelCast,
  collectLocationKeys,
  allocateReferences,
  effectiveReferenceBudget,
  resolveImageGenerationPlan,
  compileSequentialPagePrompt,
  compileIndependentPanelPrompt,
  compilePanelDescription,
} from '../visual-continuity.js';
import { sanitizeImagePrompt, cosineSimilarity } from '../utils.js';
import type { CreateState, GenerationContext } from './types.js';

/**
 * Image-generation engine for the create page: preflight model/config
 * resolution, the legacy independent-panel pipeline, and the anchored-
 * continuity pipeline (sequential page or independent panel requests).
 *
 * All page-state access goes through the GenerationContext passed by the
 * caller; this module holds no mutable state of its own.
 */

// Keyword-to-tag affinity map used for fallback ref image selection when embeddings are unavailable
const TAG_KEYWORDS = {
  'front-view': ['front', 'facing', 'standing', 'full body', 'looking at'],
  'side-view': ['profile', 'side view', 'side-on', 'looking away'],
  'back-view': ['behind', 'back view', 'from behind', 'walking away', 'rear'],
  'close-up': ['close-up', 'closeup', 'face', 'portrait', 'headshot', 'expression', 'eyes'],
  'action-pose': [
    'doing',
    'performing',
    'reaching',
    'picking up',
    'working',
    'walking',
    'moving',
    'gesturing',
    'carrying',
    'running',
    'jumping',
    'sitting',
    'turning',
    'action',
    'activity',
    'task',
    'mid-action',
  ],
  'alternate-outfit': ['casual', 'civilian', 'disguise', 'formal', 'armor', 'costume change'],
  expression: ['angry', 'sad', 'happy', 'shocked', 'scared', 'crying', 'laughing', 'smiling'],
  'character-sheet': [
    'character sheet',
    'turnaround',
    'model sheet',
    'reference sheet',
    'multiple angles',
    'multiple poses',
    'multi-angle',
    'multi-pose',
    'full rotation',
    '360',
    'orthographic',
  ],
  'character-in-world': [
    'in the world',
    'in the city',
    'in the setting',
    'environment',
    'landscape',
    'outdoors',
    'indoors',
    'location',
  ],
};

/** Map image-API progress events onto the attempt's request/stage state. */
function reportImageApiProgress(ctx: GenerationContext, event) {
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
  };
  const stageByPhase = {
    'preparing-references': ['preparing-references', 'Preparing reference images…'],
    submitting: ['submitting-images', 'Submitting image requests…'],
    waiting: ['waiting-for-images', 'Waiting for image generation…'],
    'response-received': ['waiting-for-images', 'Image response received…'],
    'response-parsed': ['persisting-images', 'Saving returned images locally…'],
  };
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

/** Panel cast IDs in stable comic selected-character order. */
function orderedPanelCast(state: CreateState, panel) {
  const cast = new Set(collectPanelCast(panel));
  const ordered = state.selectedCharacters.filter((id) => cast.has(id));
  const extras = [...cast].filter((id) => !ordered.includes(id)).sort();
  return [...ordered, ...extras];
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
    !pageModel && source === 'cache'
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
    source === 'cache'
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
  const charRefMode = await DB.getSetting('charRefMode', 'auto');
  const maxRefImages = await DB.getSetting('maxRefImages', 4);
  const enrichEnabled = await DB.getSetting('enrichImagePrompts', false);
  const negativePrompt = await DB.getSetting('negativePrompt', '');

  // Normalize world refs (plain strings and labeled objects)
  const worldRefs = ctx.state.referenceImages
    .map((item) => (typeof item === 'string' ? { dataUrl: item, label: '', type: 'world' } : item))
    .filter((r) => r.type === 'world');

  // Cache panel prompt embeddings within this page generation
  const promptEmbeddingCache = new Map();
  // Cache enriched prompts within this page generation to avoid duplicate LLM calls
  const promptEnrichmentCache = new Map();

  async function getPromptEmbedding(promptText) {
    if (!promptText) return null;
    if (promptEmbeddingCache.has(promptText)) return promptEmbeddingCache.get(promptText);
    const emb = await API.generateEmbedding(promptText).catch(() => null);
    promptEmbeddingCache.set(promptText, emb);
    return emb;
  }

  // Check if a character name appears in a panel prompt using word-boundary matching
  function nameInPrompt(name, text) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'i').test(text);
  }

  // Select the best image from a character's images[] using hybrid cascading strategy
  async function selectBestImage(charImages, panelPromptText, charName, primaryImageIndex) {
    const valid = (charImages || []).filter((img) => img && img.dataUrl);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];

    const panelLower = panelPromptText.toLowerCase();
    const promptSnippet = panelPromptText.slice(0, 80);

    // 1. Embedding-based selection (unless mode is 'keyword')
    if (charRefMode !== 'keyword') {
      const withEmb = valid.filter((img) => img.embedding?.length);
      if (withEmb.length > 0) {
        const panelEmb = await getPromptEmbedding(panelPromptText);
        if (panelEmb) {
          let best = withEmb[0];
          let bestScore = cosineSimilarity(panelEmb, withEmb[0].embedding);
          for (let i = 1; i < withEmb.length; i++) {
            const score = cosineSimilarity(panelEmb, withEmb[i].embedding);
            if (score > bestScore) {
              bestScore = score;
              best = withEmb[i];
            }
          }
          return best;
        }
        // Embedding fetch failed — fall through to keyword
        ctx.logError(
          'selectBestImage',
          new Error('Embedding fallback'),
          `Embedding unavailable for panel prompt, falling back to keyword matching. Character: ${charName}, prompt: "${promptSnippet}..."`,
        );
      } else {
        // No stored embeddings — fall through to keyword
        ctx.logError(
          'selectBestImage',
          new Error('Embedding fallback'),
          `No stored embeddings for character "${charName}", falling back to keyword matching. Prompt: "${promptSnippet}..."`,
        );
      }
    }

    // 2. Keyword tag matching (unless mode is 'semantic')
    if (charRefMode !== 'semantic') {
      let bestScore = 0,
        bestImg = null;
      for (const img of valid) {
        const keywords = TAG_KEYWORDS[img.tag] || [];
        const score = keywords.filter((kw) => panelLower.includes(kw)).length;
        if (score > bestScore) {
          bestScore = score;
          bestImg = img;
        }
      }
      if (bestScore > 0 && bestImg) return bestImg;
      // No keyword match — fall through to primary
      ctx.logError(
        'selectBestImage',
        new Error('Keyword fallback'),
        `No keyword/tag match for character "${charName}", falling back to primary image. Prompt: "${promptSnippet}..."`,
      );
    }

    // 3. Fall back to primary image using configured primaryImageIndex
    const primaryIdx = typeof primaryImageIndex === 'number' ? primaryImageIndex : 0;
    const primary = (charImages || [])[primaryIdx];
    return primary && primary.dataUrl ? primary : valid[0];
  }

  // Build a composite character sheet canvas when multiple chars share budget
  async function buildCompositeSheet(charMatches) {
    const n = charMatches.length;
    if (n === 0) return null;

    const cellSize = 256;
    const cols = Math.min(n, 2);
    const rows = Math.ceil(n / cols);
    const canvas = document.createElement('canvas');
    canvas.width = cols * cellSize;
    canvas.height = rows * cellSize;
    const ctx2d = canvas.getContext('2d');
    ctx2d.fillStyle = '#1a1a2e';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);

    await Promise.all(
      charMatches.map(
        ({ name, img }, i) =>
          new Promise((resolve) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = col * cellSize;
            const y = row * cellSize;
            const drawLabel = () => {
              ctx2d.fillStyle = 'rgba(0,0,0,0.75)';
              ctx2d.fillRect(x, y + cellSize - 22, cellSize, 22);
              ctx2d.fillStyle = '#fff';
              ctx2d.font = '12px sans-serif';
              ctx2d.textAlign = 'center';
              ctx2d.fillText(name, x + cellSize / 2, y + cellSize - 7);
            };
            const image = new Image();
            image.onload = () => {
              ctx2d.drawImage(image, x, y, cellSize, cellSize - 22);
              drawLabel();
              resolve();
            };
            image.onerror = () => {
              drawLabel();
              resolve();
            };
            image.src = img.dataUrl;
          }),
      ),
    );

    const posLabels = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    const legendParts = charMatches.map(({ name, img }, i) => {
      const pos = posLabels[i] || `section ${i + 1}`;
      const detail = img.description || (img.tag && img.tag !== 'default' ? img.tag : '');
      return `${pos}: ${name}${detail ? ` (${detail})` : ''}`;
    });
    const legend = `Character sheet grid. ${legendParts.join('. ')}. Match each character's appearance exactly as shown in their labeled section.`;
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), legend, isComposite: true };
  }

  // Build per-panel image options using hybrid cascading strategy
  async function buildPanelImageOpts(panel) {
    // Use AI-picked size when dynamic sizing is enabled and the AI provided a valid WxH value
    let resolution = imageResolution;
    if (dynamicSizesEnabled && panel.imageSize) {
      const trimmed = panel.imageSize.trim();
      if (/^\d+x\d+$/i.test(trimmed)) {
        resolution = trimmed.toLowerCase();
      }
    }
    const opts = { resolution };
    if (negativePrompt) opts.negativePrompt = negativePrompt;
    const charNamesInPanel = Object.keys(ctx.state.characterImagesByName).filter((name) =>
      nameInPrompt(name, panel.imagePrompt),
    );

    // Select best image per character in this panel
    const charMatches = [];
    for (const name of charNamesInPanel) {
      const charData = ctx.state.characterImagesByName[name] || {};
      const img = await selectBestImage(charData.images, panel.imagePrompt, name, charData.primaryImageIndex);
      if (img) charMatches.push({ name, img });
    }

    const totalRefs = charMatches.length + worldRefs.length;

    // Use composite sheet when mode is 'composite' or multiple chars exceed budget
    if (charMatches.length > 1 && (charRefMode === 'composite' || totalRefs > maxRefImages)) {
      const sheet = await buildCompositeSheet(charMatches);
      if (sheet) {
        const panelRefs = [
          {
            dataUrl: sheet.dataUrl,
            label: 'Composite character sheet',
            tag: '',
            description: sheet.legend,
            type: 'character',
          },
          ...worldRefs,
        ];
        opts.imageDataUrls = panelRefs.map((r) => r.dataUrl);
        opts.labeledRefs = panelRefs;
        return opts;
      }
    }

    // Build individual labeled refs
    const labeledCharRefs = charMatches.map(({ name, img }) => ({
      dataUrl: img.dataUrl,
      label: name,
      tag: img.tag || '',
      description: img.description || '',
      type: 'character',
    }));
    const panelRefs = [...labeledCharRefs, ...worldRefs];

    if (panelRefs.length === 1) {
      opts.imageDataUrl = panelRefs[0].dataUrl;
      opts.labeledRefs = panelRefs;
    } else if (panelRefs.length > 1) {
      opts.imageDataUrls = panelRefs.map((r) => r.dataUrl);
      opts.labeledRefs = panelRefs;
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
  const panels = pageData.panels;
  const warnings = [];
  const targetPanels = options.panelIndexes ? new Set(options.panelIndexes) : null;

  const config = ctx.state.imageGenerationConfig || (await preflightImageGeneration(ctx));
  warnings.push(...(config?.warnings || []));
  const modelId = config?.pageModelId || (await DB.getSetting('imageModel', '')) || 'gpt-image-1';
  const meta = config?.pageModel || (await API.getImageModelMeta(modelId, { signal: ctx.signal() }));
  const sequentialEnabled = config?.sequentialEnabled ?? (await DB.getSetting('enableSequentialPages', false));
  const refBudgetSetting = await DB.getSetting('refBudget', 'auto');
  // The companion applies ONLY when the page model is the sequential adapter;
  // a stale companion must never hijack generation for other selected models
  const singleImageModelId = config?.companionModelId || modelId;
  const imageSize = config?.imageSize || (await DB.getSetting('imageSize', '1024x1024'));
  const negativePrompt = await DB.getSetting('negativePrompt', '');
  const useRefImages = await DB.getSetting('useRefImages', true);
  const imagePresetData = ctx.state.selectedImagePreset
    ? await DB.get(DB.STORES.imagePresets, ctx.state.selectedImagePreset)
    : null;
  const stylePreset = imagePresetData?.promptPrefix || (await DB.getSetting('imagePromptPrefix', ''));

  const byId = {};
  for (const c of ctx.state.characters) byId[c.id] = c;

  // Independent panel requests run on the companion model, so their budget
  // and size validation use the companion's capabilities, not the page model's
  const companionMeta =
    config?.companionModel ||
    (singleImageModelId === modelId ? meta : await API.getImageModelMeta(singleImageModelId, { signal: ctx.signal() }));
  const budget = effectiveReferenceBudget(refBudgetSetting, meta?.maxInputImages);
  const panelBudget = effectiveReferenceBudget(refBudgetSetting, companionMeta?.maxInputImages);
  const previousFrame = useRefImages ? getPreviousFrameRef(ctx.state) : null;

  // The ledger's recorded anchors are the comic's explicit continuity choice
  const ledgerStates = (pageData.continuityBefore || ctx.state.visualContinuity)?.characterStates || {};
  const anchorImageIdByCharacter = {};
  for (const [charId, charState] of Object.entries(ledgerStates)) {
    anchorImageIdByCharacter[charId] = charState?.identityAnchorImageId ?? null;
  }

  const emptyAlloc = { manifest: [], dataUrls: [], unanchoredCharacterIds: [], warnings: [] };

  // Page-wide reference union (sequential candidate)
  const pageCast = collectPageCast(planned, ctx.state.selectedCharacters);
  const pageAlloc = useRefImages
    ? allocateReferences({
        characterIds: pageCast,
        charactersById: byId,
        locationKeys: collectLocationKeys(planned.panels),
        world: ctx.state.world,
        budget,
        previousFrame,
        anchorImageIdByCharacter,
      })
    : emptyAlloc;
  warnings.push(...pageAlloc.warnings);

  // Per-panel allocations (routing counts + independent fallback)
  const panelAllocs = planned.panels.map((panel) =>
    useRefImages
      ? allocateReferences({
          characterIds: orderedPanelCast(ctx.state, panel),
          charactersById: byId,
          locationKeys: panel.visual?.locationKey ? [panel.visual.locationKey] : [],
          world: ctx.state.world,
          budget: panelBudget,
          // Cross-page continuity applies to independent panels too — the
          // allocator includes it only when spare capacity remains
          previousFrame,
          anchorImageIdByCharacter,
        })
      : emptyAlloc,
  );

  const sizeValid = !Array.isArray(meta?.sizes) || meta.sizes.length === 0 || meta.sizes.includes(imageSize);
  if (!sizeValid) {
    warnings.push(`Size ${imageSize} is not in ${modelId}'s supported resolution list — sequential batching skipped`);
  }
  const companionSizeValid =
    !Array.isArray(companionMeta?.sizes) || companionMeta.sizes.length === 0 || companionMeta.sizes.includes(imageSize);
  if (!companionSizeValid) {
    warnings.push(
      `Size ${imageSize} is not in ${singleImageModelId}'s supported resolution list — panel requests may be rejected`,
    );
  }

  const plan = resolveImageGenerationPlan({
    modelId,
    modelMeta: meta ? { maxInputImages: budget, maxOutputImages: meta.maxOutputImages, sizes: meta.sizes } : null,
    imagePanelCount: planned.panels.length,
    pageReferenceCount: pageAlloc.error ? pageAlloc.error.required : pageAlloc.manifest.length,
    panelReferenceCounts: panelAllocs.map((a) => (a.error ? a.error.required : a.manifest.length)),
    requestedSizes: [imageSize],
    sequentialEnabled: sequentialEnabled && sizeValid && !targetPanels,
    panelCapacity: panelBudget,
  });
  warnings.push(...plan.reasons.filter((r) => r !== 'Sequential page request'));

  const compiledPrompts = [];
  const compressionCache = new Map();
  const progress = ctx.state.generationProgress;
  if (progress) {
    let next = setRoute(progress, {
      strategy: plan.strategy,
      pageModelId: modelId,
      effectiveImageModelId: plan.strategy === 'sequential-page' ? modelId : singleImageModelId,
      resolution: imageSize,
      expectedImageCount: targetPanels?.size ?? planned.panels.length,
    });
    next = enterStage(next, 'preparing-references', 'Preparing reference images…');
    const requests =
      plan.strategy === 'sequential-page'
        ? [
            {
              id: 'page-sequence',
              panelIndexes: planned.panels.map((_, i) => i),
              modelId,
              expectedImageCount: planned.panels.length,
            },
          ]
        : planned.panels
            .map((_, i) =>
              (targetPanels && !targetPanels.has(i)) ||
              panelAllocs[i].error ||
              plan.blockedPanels.some((blockedPanel) => blockedPanel.panelIndex === i)
                ? null
                : { id: `panel-${i + 1}`, panelIndexes: [i], modelId: singleImageModelId, expectedImageCount: 1 },
            )
            .filter(Boolean);
    next = registerRequests(next, requests);
    ctx.setProgress(next);
  }

  if (plan.strategy === 'sequential-page' && !pageAlloc.error) {
    // One ordered request for the whole page; data[i] maps ONLY to IMAGE i+1
    const prompt = compileSequentialPagePrompt({
      panels: planned.panels,
      renderStates,
      manifest: pageAlloc.manifest,
      charactersById: byId,
      stylePreset,
    });
    compiledPrompts.push(prompt);
    planned.panels.forEach((panel, i) => {
      panels[i].imagePrompt = compilePanelDescription({
        panel,
        renderState: renderStates[i] || {},
        manifest: pageAlloc.manifest,
        charactersById: byId,
      });
    });
    if (statusMsg) statusMsg.textContent = `Generating ${planned.panels.length} panel images in one sequence...`;

    const genOpts = {
      count: planned.panels.length,
      model: modelId,
      resolution: imageSize,
      exactReferences: true,
      refMaxDimension: 2048,
      signal: ctx.signal(),
      requestId: 'page-sequence',
      compressionCache,
      onProgress: (event) => reportImageApiProgress(ctx, event),
    };
    if (pageAlloc.dataUrls.length > 0) genOpts.imageDataUrls = pageAlloc.dataUrls;
    if (negativePrompt) genOpts.negativePrompt = negativePrompt;

    try {
      const results = await API.generateImages(prompt, genOpts);
      if (ctx.state.generationProgress)
        ctx.setProgress(
          enterStage(ctx.state.generationProgress, 'persisting-images', 'Saving returned images locally…'),
        );
      if (ctx.state.generationProgress)
        ctx.setProgress(
          updateRequest(ctx.state.generationProgress, 'page-sequence', {
            state: 'persisting',
            receivedImageCount: results.length,
          }),
        );
      const persisted = await Promise.all(
        results.map((result) => imageResultToDataUrl(result.value, result.source, { signal: ctx.signal() })),
      );
      results.forEach((result, resultIndex) => {
        const saved = persisted[resultIndex];
        if (saved.value && panels[result.index]) panels[result.index].imageUrl = saved.value;
        if (saved.warning) warnings.push(saved.warning);
      });
      if (results.length < planned.panels.length) {
        const warning = `Model returned ${results.length} of ${planned.panels.length} images — missing panels were left empty`;
        warnings.push(warning);
        panels.forEach((panel) => {
          if (!panel.imageUrl) panel.generationError = 'The page sequence did not return an image for this panel.';
        });
        ctx.toast(`Only ${results.length} of ${planned.panels.length} panel images were returned`, 'error');
      }
      if (ctx.state.generationProgress)
        ctx.setProgress(
          updateRequest(ctx.state.generationProgress, 'page-sequence', {
            state: 'complete',
            receivedImageCount: results.length,
            completedAt: Date.now(),
          }),
        );
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const failure = toSafeGenerationFailure(error, 'image-request');
      warnings.push(failure.message);
      panels.forEach((panel) => {
        if (!panel.imageUrl) panel.generationError = failure.message;
      });
      if (ctx.state.generationProgress) {
        ctx.setProgress(
          updateRequest(ctx.state.generationProgress, 'page-sequence', {
            state: failure.code === 'GENERATION_TIMEOUT' ? 'timed-out' : 'failed',
            failure,
            completedAt: Date.now(),
          }),
        );
      }
    }
  } else {
    // Independent panel requests with the same compiled state semantics
    const blocked = new Set(plan.blockedPanels.map((b) => b.panelIndex));
    const prompts = planned.panels.map((panel, i) => {
      if (targetPanels && !targetPanels.has(i)) return null;
      const alloc = panelAllocs[i];
      if (alloc.error || blocked.has(i)) return null;
      return compileIndependentPanelPrompt({
        panel,
        renderState: renderStates[i] || {},
        manifest: alloc.manifest,
        charactersById: byId,
        stylePreset,
      });
    });
    prompts.forEach((p, i) => {
      if (p) {
        compiledPrompts.push(p);
        panels[i].imagePrompt = compilePanelDescription({
          panel: planned.panels[i],
          renderState: renderStates[i] || {},
          manifest: panelAllocs[i].manifest,
          charactersById: byId,
        });
      }
    });

    let done = 0;
    const total = prompts.filter(Boolean).length;
    if (statusMsg) statusMsg.textContent = `Generating images (0 / ${total})...`;
    const settlements = await Promise.allSettled(
      planned.panels.map(async (panel, i) => {
        const alloc = panelAllocs[i];
        if (alloc.error) {
          // Never silently drop a required anchor — leave the panel empty with the exact conflict
          panels[i].generationError = alloc.error.detail;
          warnings.push(`Panel ${i + 1}: ${alloc.error.detail}`);
          return;
        }
        const prompt = prompts[i];
        if (!prompt) return;
        try {
          const genOpts = {
            count: 1,
            model: singleImageModelId,
            resolution: imageSize,
            exactReferences: true,
            refMaxDimension: 2048,
            signal: ctx.signal(),
            requestId: `panel-${i + 1}`,
            compressionCache,
            onProgress: (event) => reportImageApiProgress(ctx, event),
          };
          if (alloc.dataUrls.length > 0) genOpts.imageDataUrls = alloc.dataUrls;
          if (negativePrompt) genOpts.negativePrompt = negativePrompt;
          const results = await API.generateImages(prompt, genOpts);
          if (ctx.state.generationProgress)
            ctx.setProgress(
              updateRequest(ctx.state.generationProgress, `panel-${i + 1}`, {
                state: 'persisting',
                receivedImageCount: 1,
              }),
            );
          const saved = await imageResultToDataUrl(results[0].value, results[0].source, {
            signal: ctx.signal(),
          });
          if (saved.value) {
            panels[i].imageUrl = saved.value;
            delete panels[i].generationError;
          }
          if (saved.warning) warnings.push(`Panel ${i + 1}: ${saved.warning}`);
          if (ctx.state.generationProgress)
            ctx.setProgress(
              updateRequest(ctx.state.generationProgress, `panel-${i + 1}`, {
                state: 'complete',
                receivedImageCount: 1,
                completedAt: Date.now(),
              }),
            );
        } catch (imgErr) {
          if (imgErr?.name === 'AbortError') throw imgErr;
          ctx.logError('Panel image generation (continuity)', imgErr);
          const failure = toSafeGenerationFailure(imgErr, 'image-request');
          panels[i].generationError = failure.message;
          warnings.push(`Panel ${i + 1}: ${failure.message}`);
          if (ctx.state.generationProgress)
            ctx.setProgress(
              updateRequest(ctx.state.generationProgress, `panel-${i + 1}`, {
                state: failure.code === 'GENERATION_TIMEOUT' ? 'timed-out' : 'failed',
                failure,
                completedAt: Date.now(),
              }),
            );
          ctx.toast(`Panel ${i + 1} image failed: ${failure.message}`, 'error');
        }
        done++;
        if (statusMsg) statusMsg.textContent = `Generating images (${done} / ${total})...`;
      }),
    );
    const cancelled = settlements.find(
      (settlement) => settlement.status === 'rejected' && settlement.reason?.name === 'AbortError',
    );
    if (cancelled) throw cancelled.reason;
  }

  pageData.generation = {
    schemaVersion: 2,
    strategy: plan.strategy,
    modelId,
    ...(plan.strategy === 'independent-panels' ? { singleImageModelId } : {}),
    resolution: imageSize,
    promptVersion: PROMPT_VERSION,
    compiledPrompts,
    referenceManifest:
      plan.strategy === 'sequential-page' ? pageAlloc.manifest : panelAllocs.flatMap((a) => a.manifest),
    generatedAt: Date.now(),
    outcome: generationOutcomeForPage(pageData),
    failures: panels
      .map((panel, panelIndex) =>
        panel.generationError ? { panelIndexes: [panelIndex], message: panel.generationError } : null,
      )
      .filter(Boolean),
  };
  pageData.generationWarnings = [...new Set(warnings)];
}
