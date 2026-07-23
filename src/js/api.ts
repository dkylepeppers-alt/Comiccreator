import DB from './db.js';
import { IMAGE_REQUEST_TIMEOUT_MS, MODEL_METADATA_TIMEOUT_MS, runWithTimeout } from './generation-progress.js';
import {
  FALLBACK_IMAGE_MODELS,
  FALLBACK_TEXT_MODELS,
  KNOWN_IMAGE_SIZES,
  getModelSizesStatic,
  normalizeImageModel,
} from './model-catalog.js';
import type { ImageModel, TextModel } from './model-catalog.js';
import { parseComicResponse, parsePlannedPageResponse } from './api-parsing.js';
import { buildPlannerSystemPrompt, buildSystemPrompt } from './prompt-building.js';

export { normalizeImageModel };
export type { ImageModel, TextModel } from './model-catalog.js';
export type { ComicPanel, ComicPageResult } from './api-parsing.js';
export type { BuildSystemPromptOptions, PlannerManifest } from './prompt-building.js';

/**
 * NanoGPT API Integration
 * Handles chat completions with streaming support via the NanoGPT OpenAI-compatible API.
 */

// ── Exported interfaces ──────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | any[];
}

export interface ImageGenOptions {
  model?: string;
  resolution?: string;
  imageDataUrls?: string[];
  imageDataUrl?: string;
  labeledRefs?: LabeledRef[];
  signal?: AbortSignal;
  negativePrompt?: string;
  showExplicitContent?: boolean;
  stylePrefix?: string;
}

export interface LabeledRef {
  dataUrl: string;
  label?: string;
  description?: string;
  type?: string;
  tag?: string;
}

export interface RefVariation {
  tag: string;
  prompt: string;
  key?: string;
  desc?: string;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateImagesOptions extends ImageGenOptions {
  count: number;
  /**
   * When true the caller has already allocated references exactly (anchored
   * continuity pipeline): no truncation is applied and reference/output counts
   * are validated against live model capabilities instead.
   */
  exactReferences?: boolean;
  /** Max long-edge for reference preprocessing (default 1024 legacy, use 2048 for identity anchors). */
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

export interface FetchImageModelOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GeneratedImage {
  index: number;
  value: string;
  source: 'url' | 'b64_json';
}

export interface ModelParams {
  temperature: number;
  topP: number;
  maxTokens: number;
}

export interface CaptionContextHints {
  type?: 'character' | 'character-in-world' | 'character-interaction' | 'world';
  name?: string;
  role?: string;
  tag?: string;
  era?: string;
  appearance?: string;
  characterNames?: string;
  worldName?: string;
}

export interface RefVariationOptions {
  model?: string;
  resolution?: string;
  imageDataUrls?: string[];
}

// ── Constants ────────────────────────────────────────────────────────

const BASE_URL: string = 'https://nano-gpt.com/api/v1';
// In-memory cache for model sizes to avoid repeated IndexedDB reads per session
let _modelSizesCache: ImageModel[] | null = null;
// 'cache-fresh': cache served without attempting a live fetch (TTL not expired — normal, not a failure).
// 'cache-degraded': a live fetch was attempted and failed; cache served as a fallback.
let _lastImageModelSource: 'live' | 'cache-fresh' | 'cache-degraded' | 'fallback' = 'fallback';
const IMAGE_MODEL_CACHE_SCHEMA_VERSION = 2;
const IMAGE_MODEL_CACHE_MIGRATION_RETRY_MS = 5 * 60 * 1000;

/**
 * Return the list of sizes supported by a given image model.
 * Source: live API cache populated by fetchImageModels(), with a static
 * fallback for well-known models when API size data is unavailable.
 * Returns null when no size information is available, indicating the caller
 * should allow free-form size entry.
 */
async function getModelSizes(modelId: string): Promise<string[] | null> {
  if (!modelId) return null;

  try {
    if (_modelSizesCache === null) {
      const cached = await DB.getSetting('cachedImageModels', null);
      _modelSizesCache = Array.isArray(cached) ? cached.map(normalizeImageModel) : null;
    }
    if (Array.isArray(_modelSizesCache)) {
      const m = _modelSizesCache.find((x) => x.id === modelId);
      if (m?.sizes?.length) return m.sizes;
    }
  } catch (_) {
    /* ignore cache errors */
  }

  // Fall back to static known sizes for well-known model IDs (exact or prefix match)
  return getModelSizesStatic(modelId);
}

async function getApiKey(): Promise<string> {
  return DB.getSetting('apiKey', '');
}

/** Guarded App.logDebug — records non-failure events in the global debug log. */
function appLogDebug(context: string, message: string, details?: string): void {
  if (typeof (globalThis as any).App !== 'undefined' && typeof (globalThis as any).App.logDebug === 'function') {
    (globalThis as any).App.logDebug(context, message, details);
  }
}

async function getModel(): Promise<string> {
  return DB.getSetting('model', 'gpt-4o-mini');
}

async function getModelParams(): Promise<ModelParams> {
  return {
    temperature: await DB.getSetting('temperature', 0.7),
    topP: await DB.getSetting('topP', 0.9),
    maxTokens: await DB.getSetting('maxTokens', 2048),
  };
}

/**
 * Non-streaming chat completion
 */
async function chatCompletion(messages: ChatMessage[], options: ChatCompletionOptions = {}): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not set. Go to Settings to add your NanoGPT API key.');

  const model = options.model || (await getModel());
  const params = await getModelParams();

  const body = {
    model,
    messages,
    temperature: options.temperature ?? params.temperature,
    top_p: options.topP ?? params.topP,
    max_tokens: options.maxTokens ?? params.maxTokens,
  };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${res.status}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  appLogDebug(
    'chatCompletion',
    `Completed (model: ${model}, ${messages.length} messages, ${content.length} chars returned)`,
  );
  return content;
}

/**
 * Streaming chat completion
 * onChunk receives each text delta as it arrives.
 * Returns the full accumulated text.
 */
async function chatCompletionStream(
  messages: ChatMessage[],
  onChunk: (delta: string, fullText: string) => void,
  options: ChatCompletionOptions = {},
): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not set. Go to Settings to add your NanoGPT API key.');

  const model = options.model || (await getModel());
  const params = await getModelParams();

  const body = {
    model,
    messages,
    stream: true,
    temperature: options.temperature ?? params.temperature,
    top_p: options.topP ?? params.topP,
    max_tokens: options.maxTokens ?? params.maxTokens,
  };

  const fetchOpts: any = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
  if (options.signal) fetchOpts.signal = options.signal;

  const res = await fetch(`${BASE_URL}/chat/completions`, fetchOpts);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      if (payload === '[DONE]') continue;

      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          fullText += delta.content;
          onChunk(delta.content, fullText);
        }
      } catch {
        // skip non-JSON frames (pricing etc.)
      }
    }
  }

  appLogDebug(
    'chatCompletionStream',
    `Completed (model: ${model}, ${messages.length} messages, ${fullText.length} chars streamed)`,
  );
  return fullText;
}

/**
 * Compress a base64 data URL to a smaller JPEG to avoid 413 payloads.
 * Resizes so neither dimension exceeds maxDim, re-encodes as JPEG at given quality.
 */
function compressDataUrl(dataUrl: string, maxDim: number = 1024, quality: number = 0.85): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // fallback to original on error
    img.src = dataUrl;
  });
}

/**
 * Expand a terse panel image prompt into a detailed, cinematic description
 * using the configured text LLM.  The enriched prompt adds shot type,
 * lighting, colour palette, and compositional specifics while preserving
 * every visual element in the original text.
 *
 * Falls back to the original prompt on any API failure so image generation
 * always proceeds — callers should treat enrichment as best-effort.
 *
 * @param {string} rawPrompt  - Sanitised panel image prompt
 * @param {Object} [options]  - { genre, model, signal }
 * @returns {Promise<string>} - Enriched prompt, or rawPrompt on failure
 */
async function enrichImagePrompt(
  rawPrompt: string,
  options: ChatCompletionOptions & { genre?: string } = {},
): Promise<string> {
  // Return falsy inputs (null, undefined, '') unchanged — mirrors how other
  // API helpers handle missing input without throwing.
  if (!rawPrompt) return rawPrompt;
  const apiKey = await getApiKey();
  if (!apiKey) return rawPrompt;

  const model = options.model || (await getModel());
  const genre = options.genre ? ` The comic genre is "${options.genre}".` : '';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are an expert art director specialising in comic books and graphic novels. ' +
        'Expand the given brief image prompt into a detailed, cinematic description ' +
        'for an AI image generator. Add a specific shot type (e.g. extreme close-up, ' +
        'wide establishing shot, dutch-angle medium shot), lighting style (e.g. ' +
        'rim lighting, chiaroscuro, soft diffused fill), dominant colour palette, ' +
        'and atmospheric mood. Preserve every visual element and character detail ' +
        'from the original. Reply with only the enhanced description — no explanation, ' +
        'no quotation marks, no preamble.',
    },
    {
      role: 'user',
      content:
        `Expand this comic panel image prompt into a detailed cinematic description.${genre}\n\n` +
        `Original: ${rawPrompt}\n\nEnhanced:`,
    },
  ];

  try {
    const enriched = await chatCompletion(messages, {
      model,
      maxTokens: 250,
      temperature: 0.5,
      signal: options.signal,
    });
    // chatCompletion returns a string or null; fall back to rawPrompt if empty
    const trimmed = typeof enriched === 'string' ? enriched.trim() : '';
    return trimmed || rawPrompt;
  } catch (err) {
    if (typeof (globalThis as any).App !== 'undefined') {
      (globalThis as any).App.logError(
        'enrichImagePrompt',
        err,
        `Prompt enrichment failed — using original. Prompt: "${rawPrompt.slice(0, 80)}..."`,
      );
    }
    return rawPrompt;
  }
}

/**
 * Generate one or more images via the NanoGPT image API in a single request.
 *
 * Sends a JSON POST to /images/generations with `n: count`. Every entry of
 * the response `data[]` array is returned, mapped strictly by array index —
 * short responses are reported, never shifted; extra entries are dropped.
 * On failure, throws with the exact model, size, and prompt that were used.
 */
async function generateImages(prompt: string, options: GenerateImagesOptions): Promise<GeneratedImage[]> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not set. Go to Settings to add your NanoGPT API key.');

  const count = Math.floor(options.count ?? 1);
  if (!Number.isFinite(count) || count < 1) throw new Error(`Invalid image count: ${options.count}`);

  const imageModel = await DB.getSetting('imageModel', 'gpt-image-1');
  const showExplicitContent = await DB.getSetting('showExplicitContent', false);
  const modelId = options.model || imageModel;
  const resolution = options.resolution || '1024x1024';

  let rawRefs: string[];
  if (options.exactReferences) {
    // Anchored-continuity path: references were allocated deterministically.
    // Never truncate — validate against live model capability instead.
    rawRefs = options.imageDataUrls || [];
    const meta = await getImageModelMeta(modelId, { signal: options.signal });
    if (meta?.maxInputImages && rawRefs.length > meta.maxInputImages) {
      throw new Error(
        `Reference count ${rawRefs.length} exceeds ${modelId}'s input-image limit of ${meta.maxInputImages}. ` +
          `Reduce the page cast or reference budget.`,
      );
    }
    if (meta?.maxOutputImages && count > meta.maxOutputImages) {
      throw new Error(
        `Requested ${count} outputs but ${modelId} supports at most ${meta.maxOutputImages} per request.`,
      );
    }
    if (count > 1 && Array.isArray(meta?.sizes) && meta.sizes.length > 0 && !meta.sizes.includes(resolution)) {
      throw new Error(
        `Size "${resolution}" is not in ${modelId}'s supported resolution list (${meta.sizes.join(', ')}).`,
      );
    }
  } else {
    // Legacy path: configurable cap preserved for pre-continuity callers
    const maxRefImages = await DB.getSetting('maxRefImages', 4);
    rawRefs =
      options.imageDataUrls?.length > 0
        ? options.imageDataUrls.slice(0, maxRefImages)
        : options.imageDataUrl
          ? [options.imageDataUrl]
          : [];
    if (options.imageDataUrls?.length > maxRefImages) {
      console.warn(
        `[generateImages] Truncated reference images from ${options.imageDataUrls.length} to ${maxRefImages}`,
      );
    }
  }

  // Preserve reference order through preprocessing. Identity anchors keep a
  // larger long edge (up to 2048) so faces survive; legacy callers keep 1024.
  const refMaxDim = options.refMaxDimension || 1024;
  options.onProgress?.({ requestId: options.requestId, phase: 'preparing-references', at: Date.now() });
  const compressReference = (dataUrl: string) => {
    if (!options.compressionCache) return compressDataUrl(dataUrl, refMaxDim);
    const key = `${refMaxDim}:${dataUrl}`;
    let pending = options.compressionCache.get(key);
    if (!pending) {
      pending = compressDataUrl(dataUrl, refMaxDim);
      options.compressionCache.set(key, pending);
    }
    return pending;
  };
  const compressedRefs = rawRefs.length > 0 ? await Promise.all(rawRefs.map((u) => compressReference(u))) : null;

  // Prepend the legacy reference legend only when labeled refs are provided.
  // The anchored pipeline compiles its own reference map into the prompt.
  const labeledRefs = options.exactReferences ? null : options.labeledRefs;
  let finalPrompt = prompt;
  if (labeledRefs?.length > 0) {
    const maxRefImages = await DB.getSetting('maxRefImages', 4);
    const legend = labeledRefs
      .slice(0, maxRefImages)
      .map((ref, i) => {
        const details = ref.description
          ? ` — ${ref.description}`
          : ref.tag && ref.tag !== 'default'
            ? ` (${ref.tag})`
            : '';
        let instruction;
        switch (ref.type) {
          case 'character':
            instruction =
              "Replicate this character's exact appearance, proportions, outfit, and distinguishing features precisely as shown.";
            break;
          case 'world':
            instruction =
              'Use this as an environment and style reference — match the architecture, lighting, and atmosphere.';
            break;
          default:
            instruction = 'Use this as a visual reference.';
            break;
        }
        return `Reference image ${i + 1}: ${ref.label}${details} (${ref.type} reference). ${instruction}`;
      })
      .join(' ');
    finalPrompt = `${legend} ${prompt}`;
  }

  const body: any = { model: modelId, prompt: finalPrompt, size: resolution, n: count };
  if (showExplicitContent) body.showExplicitContent = true;
  if (compressedRefs?.length > 0) body.imageDataUrls = compressedRefs;
  // Pass caller-supplied negative prompt to models that support it (ignored by models that don't)
  if (options.negativePrompt?.trim()) body.negative_prompt = options.negativePrompt.trim();

  const timeoutMs = options.timeoutMs ?? (await DB.getSetting('imageRequestTimeoutMs', IMAGE_REQUEST_TIMEOUT_MS));
  appLogDebug(
    'generateImages',
    `Requesting ${count} image${count === 1 ? '' : 's'} (model: ${modelId}, ${resolution}, ${rawRefs.length} reference${rawRefs.length === 1 ? '' : 's'})`,
  );
  options.onProgress?.({ requestId: options.requestId, phase: 'submitting', at: Date.now() });
  const data = await runWithTimeout(
    async (signal) => {
      const fetchOpts: any = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      };
      options.onProgress?.({ requestId: options.requestId, phase: 'waiting', at: Date.now() });
      const res = await fetch(`${BASE_URL}/images/generations`, fetchOpts);
      options.onProgress?.({ requestId: options.requestId, phase: 'response-received', at: Date.now() });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const apiMsg = errData.error?.message || errData.message || `HTTP ${res.status} ${res.statusText}`;
        const error = new Error(
          `Image generation failed (${modelId}, ${resolution}, ${count} image${count === 1 ? '' : 's'}): ${apiMsg}`,
        ) as any;
        error.safeMessage = error.message;
        error.status = res.status;
        error.model = modelId;
        error.resolution = resolution;
        error.count = count;
        error.phase = 'image-request';
        console.error('Image generation failed:', { status: res.status, model: modelId, resolution, count, apiMsg });
        throw error;
      }
      return res.json();
    },
    { signal: options.signal, timeoutMs, phase: 'image-request', modelId },
  );
  const entries = Array.isArray(data.data) ? data.data : [];
  const results: GeneratedImage[] = [];
  for (let i = 0; i < entries.length && i < count; i++) {
    const entry = entries[i];
    if (entry?.url) results.push({ index: i, value: entry.url, source: 'url' });
    else if (entry?.b64_json) results.push({ index: i, value: entry.b64_json, source: 'b64_json' });
  }
  if (results.length === 0) throw new Error('No image data in API response');
  appLogDebug(
    'generateImages',
    `Generated ${results.length} image${results.length === 1 ? '' : 's'} (model: ${modelId}, ${resolution}, ${rawRefs.length} reference${rawRefs.length === 1 ? '' : 's'})`,
  );
  options.onProgress?.({
    requestId: options.requestId,
    phase: 'response-parsed',
    at: Date.now(),
    receivedImageCount: results.length,
  });
  if (entries.length < count) {
    console.warn(`[generateImages] Requested ${count} images but the API returned ${entries.length}`);
  } else if (entries.length > count) {
    console.warn(`[generateImages] API returned ${entries.length} images for a request of ${count} — extras dropped`);
  }
  return results;
}

/**
 * Single-image compatibility wrapper — existing character and world
 * reference-generation callers go through here unchanged.
 */
async function generateImage(prompt: string, options: ImageGenOptions = {}): Promise<string> {
  const results = await generateImages(prompt, Object.assign({}, options, { count: 1 }));
  return results[0].value;
}

/**
 * Fetch all available text/chat models from NanoGPT.
 * Endpoint does not require authentication.
 * Returns array of model objects with id, name, owned_by, etc.
 */
async function fetchTextModels(forceRefresh: boolean = false): Promise<TextModel[]> {
  const CACHE_KEY = 'cachedTextModels';
  const CACHE_TS_KEY = 'cachedTextModelsAt';
  const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

  if (!forceRefresh) {
    const cached = await DB.getSetting(CACHE_KEY, null);
    const cachedAt = await DB.getSetting(CACHE_TS_KEY, 0);
    if (cached && Date.now() - cachedAt < CACHE_TTL) return cached;
  }

  try {
    const res = await fetch(`${BASE_URL}/models?detailed=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.data || data || [])
      .map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        owned_by: m.owned_by || '',
        context_length: m.context_length || null,
        pricing: m.pricing || null,
        // NanoGPT API returns capabilities under a nested `capabilities` object
        supports_vision: m.capabilities?.vision ?? m.supports_vision ?? false,
        supports_tools: m.capabilities?.tool_calling ?? m.supports_tools ?? false,
      }))
      .sort((a: TextModel, b: TextModel) => a.id.localeCompare(b.id));

    await DB.setSetting(CACHE_KEY, models);
    await DB.setSetting(CACHE_TS_KEY, Date.now());
    return models;
  } catch (err) {
    if (typeof (globalThis as any).App !== 'undefined') (globalThis as any).App.logError('fetchTextModels', err);
    // Return cache even if expired, or fallback
    const cached = await DB.getSetting(CACHE_KEY, null);
    if (cached) return cached;
    return FALLBACK_TEXT_MODELS.map((id) => ({ id, name: id, owned_by: '' }));
  }
}

/**
 * Look up normalized capability metadata for one image model from the live
 * cache (populated by fetchImageModels). Returns null when neither live nor
 * cached metadata exists — callers must then take the conservative path.
 */
async function getImageModelMeta(modelId: string, options: FetchImageModelOptions = {}): Promise<ImageModel | null> {
  if (!modelId) return null;
  try {
    const models = await fetchImageModels(false, options);
    return models.find((m) => m.id === modelId) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch all available image generation models from NanoGPT.
 * Requires authentication so the API returns detailed info including supported sizes.
 */
async function fetchImageModels(
  forceRefresh: boolean = false,
  options: FetchImageModelOptions = {},
): Promise<ImageModel[]> {
  const CACHE_KEY = 'cachedImageModels';
  const CACHE_TS_KEY = 'cachedImageModelsAt';
  const CACHE_SCHEMA_KEY = 'cachedImageModelsSchemaVersion';
  const MIGRATION_RETRY_KEY = 'cachedImageModelsMigrationRetryAt';
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  const cached = await DB.getSetting(CACHE_KEY, null);
  const cachedAt = await DB.getSetting(CACHE_TS_KEY, 0);
  const cacheSchema = await DB.getSetting(CACHE_SCHEMA_KEY, 0);
  const migrationRetryAt = await DB.getSetting(MIGRATION_RETRY_KEY, 0);
  const normalizedCache = Array.isArray(cached) ? cached.map(normalizeImageModel).filter((model) => model.id) : null;
  const cacheCurrent = cacheSchema === IMAGE_MODEL_CACHE_SCHEMA_VERSION;
  const migrationBackoffActive = !cacheCurrent && Date.now() < migrationRetryAt;

  if (!forceRefresh && normalizedCache && cacheCurrent && Date.now() - cachedAt < CACHE_TTL) {
    _modelSizesCache = normalizedCache;
    _lastImageModelSource = 'cache-fresh';
    return normalizedCache;
  }
  if (!forceRefresh && normalizedCache && migrationBackoffActive) {
    _modelSizesCache = normalizedCache;
    _lastImageModelSource = 'cache-degraded';
    return normalizedCache;
  }

  try {
    const apiKey = await getApiKey();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const data = await runWithTimeout(
      async (signal) => {
        const res = await fetch(`${BASE_URL}/image-models?detailed=true`, { headers, signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? MODEL_METADATA_TIMEOUT_MS,
        phase: 'model-metadata',
      },
    );
    const models = (data.data || data || [])
      .map((m: any) => normalizeImageModel(m))
      .filter((m: ImageModel) => m.id)
      .sort((a: ImageModel, b: ImageModel) => a.id.localeCompare(b.id));

    await DB.setSetting(CACHE_KEY, models);
    await DB.setSetting(CACHE_TS_KEY, Date.now());
    await DB.setSetting(CACHE_SCHEMA_KEY, IMAGE_MODEL_CACHE_SCHEMA_VERSION);
    await DB.setSetting(MIGRATION_RETRY_KEY, 0);
    _modelSizesCache = models; // Update in-memory cache immediately
    _lastImageModelSource = 'live';
    return models;
  } catch (err) {
    if (typeof (globalThis as any).App !== 'undefined') (globalThis as any).App.logError('fetchImageModels', err);
    if (!cacheCurrent && normalizedCache) {
      await DB.setSetting(MIGRATION_RETRY_KEY, Date.now() + IMAGE_MODEL_CACHE_MIGRATION_RETRY_MS);
    }
    if (normalizedCache) {
      _modelSizesCache = normalizedCache;
      _lastImageModelSource = 'cache-degraded';
      return normalizedCache;
    }
    _lastImageModelSource = 'fallback';
    return FALLBACK_IMAGE_MODELS.map((id) => ({ id, name: id, owned_by: '' }));
  }
}

function getImageModelSource(): 'live' | 'cache-fresh' | 'cache-degraded' | 'fallback' {
  return _lastImageModelSource;
}

/**
 * Generate a contextual caption for an uploaded image using a vision-capable model.
 * The caption is optimized for concise reference metadata. contextHints narrows
 * the prompt to the specific context:
 *   type: 'character'              — single character reference (uses name, role, tag, appearance)
 *       | 'character-in-world'     — character inside a world (uses name, tag, appearance, worldName)
 *       | 'character-interaction'  — multiple characters interacting (uses characterNames, worldName, tag)
 *       | 'world'                  — location/environment reference (uses name, era, tag)
 *   Additional fields: name, role, tag, era, appearance, characterNames, worldName
 * Uses the `captionModel` setting when set, otherwise falls back to the configured
 * text model.  Returns a trimmed string, or null on failure / missing API key /
 * non-vision model.
 */
async function generateImageCaption(
  dataUrl: string,
  contextHints: CaptionContextHints = {},
  options: ChatCompletionOptions = {},
): Promise<string | null> {
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  const model = options.model || (await DB.getSetting('captionModel', '')) || (await getModel());

  // Silently skip models that are known not to support vision to avoid error-log spam.
  // fetchTextModels is cached (6 h TTL), so this lookup is cheap on subsequent calls.
  try {
    const textModels = await fetchTextModels();
    const modelInfo = textModels.find((m) => m.id === model);
    // Only gate when we have explicit capability data; unknown models are attempted.
    if (modelInfo && modelInfo.supports_vision === false) return null;
  } catch {
    /* ignore cache errors — attempt captioning anyway */
  }

  const {
    type = 'character',
    name = '',
    role = '',
    tag = '',
    era = '',
    appearance = '',
    characterNames = '',
    worldName = '',
  } = contextHints;

  // Build targeted context and instruction lines for the vision prompt
  let contextLine = '';
  let instructionLine = '';
  if (type === 'character-interaction') {
    // Character interaction images: multiple characters interacting inside a world
    const chars = characterNames || 'the characters';
    const world = worldName || name || 'the world';
    contextLine = `This is a reference image showing ${chars} interacting together inside ${world}. The image is tagged "${tag || 'character-interaction'}".`;
    instructionLine = `Write 1-2 sentences describing the characters visible and what they are doing together. Name each character you can identify (expected: ${chars}). Mention the setting/environment. Focus on the interaction, poses, and composition. Reply with only the description, no preamble.`;
  } else if (type === 'character-in-world') {
    // Single character in a world environment
    const charName = name || 'the character';
    const world = worldName || 'the world';
    contextLine = `This is a reference image showing ${charName} inside the world of ${world}. The image is tagged "${tag || 'character-in-world'}".`;
    instructionLine = `Write 1-2 sentences describing what ${charName} is doing in ${world}. Begin with "${charName}" as the subject. Focus on the character's pose, activity, and how they interact with the environment. Reply with only the description, no preamble.`;
  } else if (type === 'character') {
    if (tag === 'character-sheet') {
      // Character sheet: multi-angle / multi-pose reference image
      contextLine = name
        ? `This is a character sheet (model/reference sheet) for a comic book character named "${name}"${role ? ` (${role})` : ''}.${appearance ? ` Known appearance: ${appearance}.` : ''} It shows the same character from multiple angles, poses, or views.`
        : 'This is a character sheet (model/reference sheet) for a comic book character showing the same character from multiple angles, poses, or views.';
      instructionLine = name
        ? `This is a character sheet with multiple views of the same character. Write 2-3 sentences describing: 1) the character's consistent visual traits (build, hair, distinguishing features), 2) what views/angles are shown (front, side, back, three-quarter, etc.), 3) outfit details visible across the poses. Begin with "${name}" as the subject. This description will be used to match the character across different comic panel compositions. Reply with only the description, no preamble.`
        : "This is a character sheet with multiple views of the same character. Write 2-3 sentences describing: 1) the character's consistent visual traits (build, hair, distinguishing features), 2) what views/angles are shown (front, side, back, three-quarter, etc.), 3) outfit details visible across the poses. This description will be used to match the character across different comic panel compositions. Reply with only the description, no preamble.";
    } else {
      contextLine = name
        ? `This is a reference image for a comic book character named "${name}"${role ? ` (${role})` : ''}.${appearance ? ` Known appearance: ${appearance}.` : ''} The image is tagged "${tag || 'default'}".`
        : `This is a reference image for a comic book character. The image is tagged "${tag || 'default'}".`;
      instructionLine = name
        ? `Write 1-2 sentences describing what you see. Begin with "${name}" as the subject (e.g. "${name} wears…" or "${name} stands…"). Focus on visual details — outfit, pose, expression, notable features — that would help identify this character in a comic panel. Reply with only the description, no preamble.`
        : 'Write 1-2 sentences describing visual details (outfit, pose, expression, notable features) that would help match this image to comic panel descriptions. Reply with only the description, no preamble.';
    }
  } else {
    contextLine = name
      ? `This is a reference image for a comic book location called "${name}"${era ? ` (${era})` : ''}. The image is tagged "${tag || 'establishing'}".`
      : `This is a reference image for a comic book location. The image is tagged "${tag || 'establishing'}".`;
    instructionLine = name
      ? `Write 1-2 sentences describing what you see. Begin with "${name}" as the subject (e.g. "${name} features…" or "${name} shows…"). Focus on visual details — architecture, lighting, atmosphere, scale — that would help identify this location in a comic panel. Reply with only the description, no preamble.`
      : 'Write 1-2 sentences describing visual details (architecture, lighting, atmosphere, scale) that would help match this image to comic panel descriptions. Reply with only the description, no preamble.';
  }

  // Compress the image before sending to avoid 413 payloads on large camera photos.
  const compressedUrl = await compressDataUrl(dataUrl, 512, 0.75);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a visual description assistant for a comic book creator. Describe reference images concisely to help match them to comic panel art prompts.',
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: compressedUrl } },
        {
          type: 'text',
          text: `${contextLine} ${instructionLine}`,
        },
      ],
    },
  ];

  try {
    const caption = await chatCompletion(messages, {
      model,
      maxTokens: tag === 'character-sheet' ? 200 : 120,
      temperature: 0.3,
    });
    return caption?.trim() || null;
  } catch (err) {
    if (typeof (globalThis as any).App !== 'undefined') {
      (globalThis as any).App.logError(
        'generateImageCaption',
        err,
        `Caption generation failed for ${type} "${name || 'unknown'}"`,
      );
    }
    return null;
  }
}

/**
 * Resolve the model used for reference classification and report whether it can run.
 * Shares the caption model setting, since both need a vision-capable model.
 */
async function getClassificationModel(): Promise<{ model: string; usable: boolean }> {
  const apiKey = await getApiKey();
  const model = (await DB.getSetting('captionModel', '')) || (await getModel());
  if (!apiKey) return { model, usable: false };
  try {
    const modelInfo = (await fetchTextModels()).find((m) => m.id === model);
    // Only gate on explicit capability data; unknown models are still attempted.
    if (modelInfo && modelInfo.supports_vision === false) return { model, usable: false };
  } catch {
    /* ignore cache errors — attempt classification anyway */
  }
  return { model, usable: true };
}

/** True when an API key is set and the resolved classification model supports vision. */
async function canClassifyReferenceImages(): Promise<boolean> {
  return (await getClassificationModel()).usable;
}

/**
 * Classify a reference image with a vision-capable model and return the raw response text.
 * Parsing and schema validation belong to the caller (`references/cloud-classifier.ts`),
 * so this stays a thin transport. Returns null when no usable model is configured.
 * Errors are thrown, not swallowed, so the classifier can distinguish a rate limit from
 * a bad answer.
 */
async function classifyReferenceImage(dataUrl: string, prompt: string): Promise<string | null> {
  const { model, usable } = await getClassificationModel();
  if (!usable) return null;

  // Compress before sending to avoid 413 payloads on large camera photos.
  const compressedUrl = await compressDataUrl(dataUrl, 512, 0.75);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a precise visual classifier for a comic book creator. Reply with one raw JSON object and nothing else.',
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: compressedUrl } },
        { type: 'text', text: prompt },
      ],
    },
  ];
  const response = await chatCompletion(messages, { model, maxTokens: 600, temperature: 0.1 });
  return response?.trim() || null;
}

/**
 * Reference variation definitions for AI-generated reference images.
 * Each entry defines the tag, prompt template, and description for a variation.
 * Character templates are reference-image-centric — the model should derive
 * appearance from the visual reference, not from text.
 * World templates use {name} and {description} placeholders.
 */
const CHARACTER_REF_VARIATIONS: RefVariation[] = [
  {
    key: 'front-view-main',
    tag: 'front-view',
    prompt:
      'Full-body front view of the character shown in the reference image. The character stands upright facing the viewer with a relaxed, neutral pose. Arms slightly away from body. Full figure visible from head to toe. Flat white studio background. Orthographic character-sheet style.',
    desc: 'Front-facing full body reference',
  },
  {
    key: 'side-view-main',
    tag: 'side-view',
    prompt:
      'Full-body side profile of the character shown in the reference image. The character stands facing the right side of the frame. Full figure visible from head to toe. Flat white studio background. Orthographic character-sheet style.',
    desc: 'Side profile reference',
  },
  {
    key: 'back-view-main',
    tag: 'back-view',
    prompt:
      'Full-body rear view of the character shown in the reference image. The character stands facing away from the viewer. Full figure visible from head to toe. Flat white studio background. Orthographic character-sheet style.',
    desc: 'Rear view reference',
  },
  {
    key: 'close-up-portrait',
    tag: 'close-up',
    prompt:
      'Close-up portrait of the character shown in the reference image. Head and shoulders framing. Neutral expression, eyes looking directly at the camera. Highly detailed facial features, hair, and collar. Soft studio lighting. Clean neutral background.',
    desc: 'Close-up face/portrait reference',
  },
  {
    key: 'action-pose-task',
    tag: 'action-pose',
    prompt:
      'The character from the reference image actively performing a task or everyday activity — reaching for something, gesturing expressively, working with their hands, or walking with purpose. Natural mid-action body language showing the character doing something. Full body visible. Clean neutral background.',
    desc: 'Action pose — performing a task/activity',
  },
  {
    key: 'action-pose-motion',
    tag: 'action-pose',
    prompt:
      'The character from the reference image caught in natural motion — turning to look at something, picking up an object, sitting down, or stepping forward. Captured mid-movement in a relaxed, purposeful pose. Conveys what the character is doing, not a heroic stance. Full body visible. Clean neutral background.',
    desc: 'Action pose — natural movement/activity',
  },
  {
    key: 'expression-anger',
    tag: 'expression',
    prompt:
      'Expressive close-up portrait of the character from the reference image showing intense ANGER or RAGE. Furrowed brow, clenched jaw, flared nostrils. Strong dramatic side-lighting with deep shadows. Head and shoulders framing. Clean dark background.',
    desc: 'Expression — anger/rage',
  },
  {
    key: 'expression-joy',
    tag: 'expression',
    prompt:
      'Expressive close-up portrait of the character from the reference image showing JOY or TRIUMPH. Wide grin, bright eyes, lifted cheeks. Warm upbeat lighting. Head and shoulders framing. Clean light background.',
    desc: 'Expression — joy/triumph',
  },
  {
    key: 'expression-fear',
    tag: 'expression',
    prompt:
      'Expressive close-up portrait of the character from the reference image showing FEAR or SHOCK. Wide eyes, raised brows, mouth slightly open. Cool dramatic lighting from below. Head and shoulders framing. Clean background.',
    desc: 'Expression — fear/shock',
  },
  {
    key: 'character-sheet-3view',
    tag: 'character-sheet',
    prompt:
      'Orthographic character reference sheet of the character from the reference image. Three views arranged side by side: front facing (left), three-quarter view (center), side profile (right). All views show the full body at the same scale. Clean white background, thin guide lines. Comic book character design sheet style.',
    desc: 'Character sheet — 3-view turnaround',
  },
];

const WORLD_REF_VARIATIONS: RefVariation[] = [
  {
    tag: 'establishing',
    prompt:
      'Wide establishing shot of {name}, {description}. Eye-level perspective showing the full scope of the location — buildings, skyline, or landscape. Neutral daylight lighting. Cinematic composition with foreground, midground, and background layers clearly visible.',
    desc: 'Wide establishing shot',
  },
  {
    tag: 'aerial',
    prompt:
      "Aerial bird's-eye view of {name}, {description}. Wide panoramic overhead perspective revealing the full layout and scale of the location — streets, structures, terrain. Dramatic depth of field, natural daylight.",
    desc: 'Aerial panoramic view',
  },
  {
    tag: 'exterior-street',
    prompt:
      'Street-level exterior view of {name}, {description}. Looking down the main street or thoroughfare — storefronts, pavement, signage, pedestrian scale. Realistic environmental detail with atmospheric perspective.',
    desc: 'Street-level exterior view',
  },
  {
    tag: 'exterior-entrance',
    prompt:
      'Close-up of the main entrance or facade of {name}, {description}. Architectural detail — doors, archways, steps, signage, and surrounding exterior elements. Medium shot framing the entry point directly.',
    desc: 'Entrance / facade detail',
  },
  {
    tag: 'interior-living-room',
    prompt:
      "Interior view of the living room or main common area inside {name}, {description}. Comfortable furnishings, ambient lighting, personal objects and décor that reflect the world's tone and era. Medium wide shot showing the full room.",
    desc: 'Interior — living room / common area',
  },
  {
    tag: 'interior-kitchen',
    prompt:
      'Interior view of the kitchen or food preparation area inside {name}, {description}. Countertops, appliances or period-appropriate cooking equipment, utensils, and supplies. Warm functional lighting. Medium wide shot.',
    desc: 'Interior — kitchen',
  },
  {
    tag: 'interior-bedroom',
    prompt:
      "Interior view of a bedroom inside {name}, {description}. Bed, personal belongings, window, and décor elements that reflect the inhabitant's personality and the world's era. Soft ambient lighting. Medium wide shot.",
    desc: 'Interior — bedroom',
  },
  {
    tag: 'interior-office',
    prompt:
      "Interior view of an office, study, or workspace inside {name}, {description}. Desk, equipment, shelves, documents, and environmental details suited to the world's era and tone. Directional task lighting. Medium wide shot.",
    desc: 'Interior — office / workspace',
  },
  {
    tag: 'interior',
    prompt:
      "Interior view of a key location inside {name}, {description}. Detailed architecture, furnishings, lighting fixtures, and atmospheric props that establish the world's tone. Medium wide angle shot showing spatial depth.",
    desc: 'Interior environment detail',
  },
  {
    tag: 'night',
    prompt:
      'Night scene of {name}, {description}. Dark atmosphere with dramatic artificial lighting — neon, lanterns, streetlights, or moonlight casting pools of light and deep shadows. High contrast mood, cinematic composition.',
    desc: 'Night atmosphere reference',
  },
  {
    tag: 'detail',
    prompt:
      'Close-up architectural or environmental detail of {name}, {description}. Extreme texture and material focus — worn stone, metal grating, weathered wood, graffiti, foliage, or signature objects. Shallow depth of field emphasising surface quality.',
    desc: 'Close-up environment detail',
  },
  {
    tag: 'landmark',
    prompt:
      "Hero shot of the most iconic landmark or recognisable structure of {name}, {description}. Dramatic low-angle or three-quarter perspective emphasising the scale and character of the landmark. Cinematic lighting that highlights the structure's defining features.",
    desc: 'Iconic landmark / hero shot',
  },
];

/**
 * Variation prompts for generating images of a character interacting within a world.
 * Uses {charName}, {charAppearanceNote}, {worldName}, {worldDescription} placeholders.
 */
const CHARACTER_WORLD_VARIATIONS: RefVariation[] = [
  {
    key: 'in-world-establishing',
    tag: 'character-in-world',
    prompt:
      "The character {charName}{charAppearanceNote} standing in {worldName} ({worldDescription}). Full-body establishing shot showing the character in context with the environment. The world's distinctive atmosphere and architecture visible around them. Match the art style of the provided reference images.",
    desc: '{charName} in {worldName} — establishing shot',
  },
  {
    key: 'in-world-activity',
    tag: 'character-in-world',
    prompt:
      "The character {charName}{charAppearanceNote} actively doing something in {worldName} ({worldDescription}) — working, exploring, interacting with an object, or moving through the environment. Full-body shot showing the character mid-activity with the world's distinctive atmosphere and architecture visible around them. Match the art style of the provided reference images.",
    desc: '{charName} in {worldName} — doing an activity',
  },
  {
    key: 'in-world-closeup',
    tag: 'character-in-world',
    prompt:
      "Close-up portrait of {charName}{charAppearanceNote} inside {worldName} ({worldDescription}). Head and shoulders framing with the world's environment softly visible in the background — architecture, lighting, and atmosphere subtly establishing the location. The character's expression is engaged and context-aware. Match the art style of the provided reference images.",
    desc: '{charName} in {worldName} — close-up portrait',
  },
  {
    key: 'in-world-interior',
    tag: 'character-in-world',
    prompt:
      "The character {charName}{charAppearanceNote} inside an interior space within {worldName} ({worldDescription}). The room's furnishings, lighting, and architectural details clearly place the character in this world. The character interacts naturally with the space — seated, examining something, or in conversation. Full-body or medium shot. Match the art style of the provided reference images.",
    desc: '{charName} in {worldName} — interior scene',
  },
];

/**
 * Generate a single reference image variation using the image API.
 * @param {string} sourceDataUrl - The source reference image to base the variation on
 * @param {string} prompt - The specific prompt for this variation
 * @param {Object} [options] - Optional overrides (model, resolution)
 * @returns {Promise<string|null>} - The generated image as a data URL, or null on failure
 */
async function generateRefVariation(
  sourceDataUrl: string,
  prompt: string,
  options: RefVariationOptions = {},
): Promise<string | null> {
  try {
    // Use the user's configured image size rather than a hardcoded default
    const resolution = options.resolution || (await DB.getSetting('imageSize', '1024x1024'));
    // Support multiple reference images via options.imageDataUrls (array) or single sourceDataUrl
    const imageGenOpts: ImageGenOptions = { resolution, model: options.model };
    if (options.imageDataUrls && options.imageDataUrls.length > 0) {
      imageGenOpts.imageDataUrls = options.imageDataUrls;
    } else if (sourceDataUrl) {
      imageGenOpts.imageDataUrl = sourceDataUrl;
    }
    const result = await generateImage(prompt, imageGenOpts);
    if (!result) return null;
    // Convert URL results to data URLs for local storage
    if (result.startsWith('http')) {
      try {
        const resp = await fetch(result);
        const blob = await resp.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    }
    if (result.startsWith('data:')) return result;
    return `data:image/png;base64,${result}`;
  } catch (err) {
    if (typeof (globalThis as any).App !== 'undefined') {
      (globalThis as any).App.logError(
        'generateRefVariation',
        err,
        `Failed to generate variation: ${prompt.slice(0, 80)}`,
      );
    }
    return null;
  }
}

const API = {
  chatCompletion,
  chatCompletionStream,
  generateImage,
  generateImages,
  enrichImagePrompt,
  generateImageCaption,
  classifyReferenceImage,
  canClassifyReferenceImages,
  buildSystemPrompt,
  buildPlannerSystemPrompt,
  parseComicResponse,
  parsePlannedPageResponse,
  getImageModelMeta,
  getApiKey,
  getModel,
  getModelParams,
  fetchTextModels,
  fetchImageModels,
  getImageModelSource,
  normalizeImageModel,
  getModelSizes,
  generateRefVariation,
  CHARACTER_REF_VARIATIONS,
  WORLD_REF_VARIATIONS,
  CHARACTER_WORLD_VARIATIONS,
  FALLBACK_TEXT_MODELS,
  FALLBACK_IMAGE_MODELS,
  KNOWN_IMAGE_SIZES,
  BASE_URL,
  /** @internal Reset in-memory caches (for testing only) */
  _resetCacheForTesting() {
    _modelSizesCache = null;
    _lastImageModelSource = 'fallback';
  },
};
export default API;
