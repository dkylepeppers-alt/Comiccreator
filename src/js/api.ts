import DB from './db.js';
import { IMAGE_REQUEST_TIMEOUT_MS, MODEL_METADATA_TIMEOUT_MS, runWithTimeout } from './generation-progress.js';

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

export interface TextModel {
  id: string;
  name: string;
  owned_by: string;
  context_length?: number | null;
  pricing?: any;
  supports_vision?: boolean;
  supports_tools?: boolean;
}

export interface ImageModel {
  id: string;
  name: string;
  owned_by: string;
  pricing?: any;
  supports_edit?: boolean;
  sizes?: string[] | null;
  inputModalities?: string[];
  maxInputImages?: number | null;
  maxOutputImages?: number | null;
  supportedParameters?: Record<string, unknown>;
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

export interface ComicPanel {
  narration: string;
  imagePrompt: string;
  imageSize?: string;
  dialogue: { speaker: string; text: string }[];
}

export interface ComicPageResult {
  title: string;
  panels: ComicPanel[];
  choices: { text: string; summary: string }[];
}

export interface ModelParams {
  temperature: number;
  topP: number;
  maxTokens: number;
}

export interface BuildSystemPromptOptions {
  imageSizes?: string[];
  includeAppearanceText?: boolean;
  imageStylePreset?: string;
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

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
  signal?: AbortSignal;
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
let _lastImageModelSource: 'live' | 'cache' | 'fallback' = 'fallback';
const IMAGE_MODEL_CACHE_SCHEMA_VERSION = 2;
const IMAGE_MODEL_CACHE_MIGRATION_RETRY_MS = 5 * 60 * 1000;

// Static fallback sizes for well-known models when the live API doesn't return size info.
// Keys are model IDs (or ID prefixes), values are arrays of supported WxH strings.
const KNOWN_IMAGE_SIZES: Record<string, string[]> = {
  'gpt-image-1': ['1024x1024', '1536x1024', '1024x1536', 'auto'],
  'gpt-image-1.5': ['1024x1024', '1536x1024', '1024x1536', 'auto'],
  'gpt-image-1-mini': ['1024x1024', 'auto'],
  'flux-2-turbo': ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-flash': ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-pro': ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-max': ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-dev': ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-flex': ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'seedream-v4': ['1024x1024', '1536x1024', '1024x1536', '2048x2048'],
  'seedream-v3': ['1024x1024', '1152x896', '896x1152', '1344x768', '768x1344'],
  'nano-banana': ['auto'],
  'nano-banana-pro': ['1k', '2k', '4k'],
  'qwen-image': ['auto', '1024x1024', '512x512', '768x1024', '1024x768'],
  'hunyuan-image-3': ['auto', '1024x1024', '768x1024', '1024x768', '1024x1536', '1536x1024', '512x512'],
  // Legacy entries retained for backward compatibility
  'dall-e-3': ['1024x1024', '1024x1792', '1792x1024'],
  'dall-e-2': ['256x256', '512x512', '1024x1024'],
  'gpt-4o-image': ['1024x1024', '1024x1792', '1792x1024'],
  'flux-pro': ['1024x1024', '1024x768', '768x1024', '1280x768', '768x1280'],
  'flux-schnell': ['1024x1024', '1024x768', '768x1024'],
  'flux-kontext': ['1024x1024', '1024x768', '768x1024'],
  'stable-diffusion-xl': ['1024x1024', '1024x768', '768x1024'],
  'stable-diffusion-3': ['1024x1024', '1024x768', '768x1024'],
};

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

  // Fall back to static known sizes for well-known model IDs
  if (KNOWN_IMAGE_SIZES[modelId]) return KNOWN_IMAGE_SIZES[modelId];
  // Also match by prefix (e.g. "flux-schnell-v2" matches "flux-schnell")
  for (const [prefix, sizes] of Object.entries(KNOWN_IMAGE_SIZES)) {
    if (modelId.startsWith(prefix)) return sizes;
  }

  return null;
}

async function getApiKey(): Promise<string> {
  return DB.getSetting('apiKey', '');
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
  return data.choices?.[0]?.message?.content || '';
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
 * Build system prompt for comic generation.
 * @param {string} genre
 * @param {Array} characters
 * @param {Object} world
 * @param {string|null} customSystemPrompt
 * @param {Object} [options]
 * @param {string[]} [options.imageSizes] - available image sizes for dynamic per-panel selection
 * @param {boolean} [options.includeAppearanceText] - whether to include character appearance text (default: true)
 * @param {string} [options.imageStylePreset] - image style prompt prefix from the selected image preset (e.g. "watercolor painting, soft edges").
 */
function buildSystemPrompt(
  genre: string,
  characters: any[],
  world: any,
  customSystemPrompt: string | null,
  options?: BuildSystemPromptOptions,
): string {
  const base = customSystemPrompt || `You are a masterful comic book creator specializing in ${genre} stories.`;

  const imageSizes = options?.imageSizes;
  const hasDynamicSizes = Array.isArray(imageSizes) && imageSizes.length > 1;
  const includeAppearance = options?.includeAppearanceText !== false;
  const imageStylePreset = options?.imageStylePreset || '';

  // When an image style preset is selected, use it as the art style directive;
  // otherwise fall back to a generic placeholder so the LLM doesn't hardcode one style.
  const artStyleDirective = imageStylePreset ? imageStylePreset : '[art style keywords matching the story genre]';
  const artStyleExamples = imageStylePreset
    ? `art style (use: ${imageStylePreset})`
    : 'art style (comic book illustration, bold ink lines, cel shading, halftone texture, watercolor, photorealistic — pick the style that fits the story)';

  // Build the per-panel JSON example — include imageSize field when dynamic sizing is enabled
  // Use the first available size as a placeholder; the IMAGE SIZES section instructs the AI to vary them
  const panelExample = hasDynamicSizes
    ? `{
    "narration": "Scene-setting narration text (optional)",
    "imagePrompt": "${artStyleDirective}, [shot type], [lighting], [composition] — describe the scene, characters, action",
    "imageSize": "one of the supported sizes listed below",
    "dialogue": [
      { "speaker": "Character Name", "text": "What they say" }
    ]
  }`
    : `{
    "narration": "Scene-setting narration text (optional)",
    "imagePrompt": "${artStyleDirective}, [shot type], [lighting], [composition] — describe the scene, characters, action",
    "dialogue": [
      { "speaker": "Character Name", "text": "What they say" }
    ]
  }`;

  let prompt = `${base}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, just raw JSON.

Your response must be a JSON object with this exact structure:
{
"title": "Page title",
"panels": [
  ${panelExample}
],
"choices": [
  { "text": "Choice description for the reader", "summary": "Brief consequence summary" }
]
}

Generate 3-4 panels per page. Each panel needs:
- A vivid imagePrompt describing the visual scene using technical art direction language. Specify: shot type (wide establishing shot, medium shot, close-up portrait, over-the-shoulder, Dutch angle), lighting (rim lighting, dramatic side-lighting, chiaroscuro, soft diffused light, hard shadows), ${artStyleExamples}, composition (rule of thirds, foreground/midground/background layers, dynamic diagonal composition), and color mood (desaturated, high contrast, warm palette, etc.).${imageStylePreset ? ` IMPORTANT: Every imagePrompt MUST begin with "${imageStylePreset}" as the art style prefix.` : ''}${includeAppearance ? " Include each character's physical appearance details (clothing, hair, build, distinguishing features) so the image generator maintains visual consistency." : ''}
- Optional narration for scene-setting
- Character dialogue that advances the story

CRITICAL: In each panel's "imagePrompt", you MUST explicitly name every character
who appears in that panel.${
    includeAppearance
      ? ` Include their full physical appearance description
inline. Do NOT just say "the hero" — say "Nova (tall woman with silver hair,
black armor, glowing blue eyes)". This is essential for visual consistency.`
      : ` Describe their actions, poses, and the scene composition.
Reference images will be provided for visual consistency, so you do not need
to repeat full appearance descriptions — but always use character names.`
  }
If a panel has NO characters (e.g., establishing shot), say "No characters present."

Provide 2-3 meaningful choices at the end that affect the story direction.`;

  if (hasDynamicSizes) {
    prompt += `\n\nIMAGE SIZES:
For each panel, choose the most appropriate image size from these supported values: ${imageSizes.join(', ')}
Set the "imageSize" field in each panel object. Pick sizes that best match the composition:
- Use landscape/wide sizes for panoramic scenes, establishing shots, or action sequences
- Use portrait/tall sizes for character close-ups, vertical compositions, or tall structures
- Use square sizes for balanced scenes, dialogue-focused panels, or group shots
Vary the sizes across panels to create a visually dynamic comic layout.`;
  }

  if (characters && characters.length > 0) {
    prompt += '\n\nCHARACTERS:\n';
    for (const c of characters) {
      prompt += `- ${c.name}: ${c.description}`;
      if (c.role) prompt += ` (Role: ${c.role})`;
      if (c.appearance && includeAppearance) prompt += `\n  APPEARANCE: ${c.appearance}`;
      if (c.powers) prompt += `\n  Abilities: ${c.powers}`;
      prompt += '\n';
    }
    if (includeAppearance) {
      prompt += `\nVISUAL CONSISTENCY RULES:
- EVERY panel's "imagePrompt" must repeat each visible character's full appearance (hair color/style, build, outfit, distinguishing marks). Never abbreviate or omit details between panels.
- Use the exact character name and appearance text from the CHARACTERS list above so the image generator can match reference images.
- Keep each character's outfit, proportions, and features identical across all panels unless the story explicitly calls for a change (e.g., transformation, costume swap).`;
    } else {
      prompt += `\nVISUAL CONSISTENCY RULES:
- In each panel's "imagePrompt", name every visible character and describe their actions, poses, and the scene. Reference images will be provided to the image generator for visual consistency.
- Keep each character's outfit, proportions, and features identical across all panels unless the story explicitly calls for a change (e.g., transformation, costume swap).`;
    }
  }

  if (world) {
    prompt += `\nWORLD SETTING:\nName: ${world.name}\nDescription: ${world.description}\n`;
    if (world.details) prompt += `Details: ${world.details}\n`;
    if (world.atmosphere) prompt += `Atmosphere: ${world.atmosphere}\n`;
    prompt += `\nWORLD VISUAL RULES:
- Every imagePrompt must ground the scene in ${world.name}. Include at least one specific environmental detail (architecture style, lighting quality, material textures, color palette) that reflects this world's atmosphere.
- When characters appear indoors, name the specific interior space (e.g., "a cluttered kitchen in ${world.name}", "the dim office corridor of ${world.name}") rather than a generic room.
- When characters appear outdoors, name the specific exterior context (e.g., "the rain-slicked streets of ${world.name}", "the rooftop overlooking ${world.name}") to reinforce the world's visual identity.
- Blend the character's presence with the world — show how they belong to (or contrast with) this environment through lighting, color mood, and framing.`;
  }

  return prompt;
}

/**
 * Parse comic page JSON from LLM response
 */
/**
 * Attempt to repair a truncated JSON string by closing any unclosed strings,
 * removing trailing commas, and appending missing closing brackets/braces.
 * Returns the repaired string (which may still be invalid if truncation was severe).
 */
function repairTruncatedJson(str: string): string {
  let s = str.trimEnd();
  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }

  // Close any unclosed string literal.
  // If the string ended on a dangling backslash (escape still true), the '\' is
  // incomplete — drop it before appending the closing quote so the quote doesn't
  // get accidentally escaped (e.g. `{"a":"foo\` → `{"a":"foo"`).
  if (inString) {
    if (escape) s = s.slice(0, -1);
    s += '"';
  }
  // Remove trailing comma left by a truncated array or object
  s = s.replace(/,\s*$/, '');
  // Close all unclosed structures
  while (stack.length > 0) s += stack.pop();
  return s;
}

function parseComicResponse(text: string): ComicPageResult | null {
  // Try to extract JSON from the response
  let jsonStr = text.trim();

  // Remove markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find JSON object boundaries
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  const buildResult = (parsed: any): ComicPageResult => ({
    title: parsed.title || 'Untitled Page',
    panels: (parsed.panels || []).map((p: any) => {
      const panel: any = {
        narration: p.narration || '',
        imagePrompt: p.imagePrompt || p.image_prompt || '',
        dialogue: (p.dialogue || []).map((d: any) => ({
          speaker: d.speaker || 'Unknown',
          text: d.text || '',
        })),
      };
      if (p.imageSize || p.image_size) panel.imageSize = p.imageSize || p.image_size;
      return panel;
    }),
    choices: (parsed.choices || []).map((c: any) => ({
      text: c.text || c.description || '',
      summary: c.summary || '',
    })),
  });

  try {
    return buildResult(JSON.parse(jsonStr));
  } catch (e) {
    // First parse failed — the LLM response may have been truncated.
    // Attempt to repair the JSON and retry before giving up.
    try {
      return buildResult(JSON.parse(repairTruncatedJson(jsonStr)));
    } catch (_e2) {
      if (typeof (globalThis as any).App !== 'undefined')
        (globalThis as any).App.logError('parseComicResponse', _e2, text?.substring(0, 200));
      return null;
    }
  }
}

export interface PlannerManifest {
  genreName: string;
  characters: Array<{ id: string; name: string; role?: string; description?: string; powers?: string }>;
  world?: { name: string; description?: string; details?: string; atmosphere?: string } | null;
  locationKeys?: string[];
  customSystemPrompt?: string | null;
  panelCount?: string;
}

/**
 * Build the system prompt for the structured story planner (spec §8.1).
 * The story model plans visual facts against an explicit ID manifest; the
 * application compiles the final image prompts deterministically. The model
 * must NOT write appearance or wardrobe prose — continuity owns those.
 */
function buildPlannerSystemPrompt(manifest: PlannerManifest): string {
  const base =
    manifest.customSystemPrompt ||
    `You are a masterful comic book creator specializing in ${manifest.genreName} stories.`;
  const panelCount = manifest.panelCount || '3-4';

  const characterLines = manifest.characters
    .map((c) => {
      let line = `- id: "${c.id}"  name: ${c.name}`;
      if (c.role) line += ` (${c.role})`;
      if (c.description) line += `\n  ${c.description}`;
      if (c.powers) line += `\n  Abilities: ${c.powers}`;
      return line;
    })
    .join('\n');

  const locationLines =
    manifest.locationKeys && manifest.locationKeys.length > 0
      ? manifest.locationKeys.map((k) => `- "${k}"`).join('\n')
      : '(none — always use null for locationKey)';

  let worldBlock = '';
  if (manifest.world) {
    worldBlock = `\nWORLD SETTING:\nName: ${manifest.world.name}\nDescription: ${manifest.world.description || ''}\n`;
    if (manifest.world.details) worldBlock += `Details: ${manifest.world.details}\n`;
    if (manifest.world.atmosphere) worldBlock += `Atmosphere: ${manifest.world.atmosphere}\n`;
  }

  return `${base}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, just raw JSON.

Your response must be a JSON object with this exact structure:
{
"title": "Page title",
"panels": [
  {
    "narration": "Scene-setting narration text (optional, may be empty)",
    "dialogue": [ { "speaker": "Character Name", "text": "What they say" } ],
    "visual": {
      "locationKey": "one of the allowed location keys, or null",
      "environment": "brief scene-specific environmental description",
      "shot": "shot type (wide establishing shot, medium shot, close-up, over-the-shoulder, Dutch angle...)",
      "composition": "composition notes (rule of thirds, foreground/background layers, diagonals...)",
      "lighting": "lighting style (rim lighting, chiaroscuro, soft diffused light, hard shadows...)",
      "colorMood": "color mood (desaturated, high contrast, warm palette...)",
      "characters": [
        { "characterId": "id from the CHARACTER MANIFEST", "action": "what they are doing", "pose": "body position", "expression": "facial expression" }
      ],
      "keyProps": ["important objects visible in the panel"],
      "focalPoint": "what the eye should land on (optional)",
      "layoutHint": "wide | balanced | tall (optional)"
    },
    "visualStateChanges": [
      {
        "characterId": "id from the CHARACTER MANIFEST",
        "timing": "before-panel or after-panel",
        "reason": "why the story changes this state",
        "set": {
          "wardrobeDescription": "complete new outfit description (only when clothing visibly changes; null to revert to the identity-anchor outfit)",
          "hairState": "new hair arrangement or condition",
          "carriedItems": ["complete replacement list of carried items"],
          "injuries": ["complete replacement list of visible injuries"],
          "temporaryChanges": ["complete replacement list of temporary visual changes (dirt, disguise, transformation)"]
        }
      }
    ]
  }
],
"choices": [ { "text": "Choice description for the reader", "summary": "Brief consequence summary" } ]
}

Generate ${panelCount} panels per page.

CHARACTER MANIFEST (the ONLY allowed characterId values):
${characterLines}

ALLOWED LOCATION KEYS (the ONLY allowed locationKey values):
${locationLines}

STRICT PLANNING RULES:
- Use ONLY characterId values from the CHARACTER MANIFEST. Never invent IDs and never use character names as IDs.
- List EVERY visible character in visual.characters, including silent background cast whose identity matters.
- Do NOT describe any character's physical appearance, face, hair color, build, or clothing in visual fields. Identity and wardrobe are supplied separately by the application.
- Report a wardrobe, hair, injury, carried-item, disguise, or transformation change ONLY in visualStateChanges, and ONLY when the story visibly changes it. Never redesign clothing for variety.
- In "set", omit any field that does not change. A present value fully replaces the old value.
- Use only the allowed locationKey values, or null when no listed location fits.
- Do not specify art style anywhere; the application's image preset is authoritative.
- Provide 2-3 meaningful choices at the end that affect the story direction.${worldBlock}`;
}

/**
 * Parse the structured planned-page JSON from the story model.
 * Shape-normalizes fields with safe defaults; ID/manifest validation is done
 * separately by visual-continuity.validatePlannedPage(). Returns null when
 * the text cannot be parsed even after truncation repair.
 */
function parsePlannedPageResponse(text: string): any | null {
  let jsonStr = (text || '').trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

  const normalizeChange = (ch: any) => ({
    characterId: ch?.characterId || ch?.character_id || '',
    timing: ch?.timing === 'after-panel' ? 'after-panel' : 'before-panel',
    reason: ch?.reason || '',
    set: {
      ...(ch?.set && 'wardrobeDescription' in ch.set ? { wardrobeDescription: ch.set.wardrobeDescription } : {}),
      ...(ch?.set && 'hairState' in ch.set ? { hairState: ch.set.hairState } : {}),
      ...(ch?.set && 'carriedItems' in ch.set ? { carriedItems: ch.set.carriedItems } : {}),
      ...(ch?.set && 'injuries' in ch.set ? { injuries: ch.set.injuries } : {}),
      ...(ch?.set && 'temporaryChanges' in ch.set ? { temporaryChanges: ch.set.temporaryChanges } : {}),
    },
  });

  const buildResult = (parsed: any) => {
    if (!parsed || !Array.isArray(parsed.panels)) return null;
    return {
      title: parsed.title || 'Untitled Page',
      panels: parsed.panels.map((p: any) => ({
        narration: p?.narration || '',
        dialogue: (Array.isArray(p?.dialogue) ? p.dialogue : []).map((d: any) => ({
          speaker: d?.speaker || 'Unknown',
          text: d?.text || '',
        })),
        visual: {
          locationKey: p?.visual?.locationKey || null,
          environment: p?.visual?.environment || '',
          shot: p?.visual?.shot || '',
          composition: p?.visual?.composition || '',
          lighting: p?.visual?.lighting || '',
          colorMood: p?.visual?.colorMood || p?.visual?.color_mood || '',
          characters: (Array.isArray(p?.visual?.characters) ? p.visual.characters : []).map((c: any) => ({
            characterId: c?.characterId || c?.character_id || '',
            action: c?.action || '',
            pose: c?.pose || '',
            expression: c?.expression || '',
          })),
          keyProps: Array.isArray(p?.visual?.keyProps) ? p.visual.keyProps.filter(Boolean) : [],
          focalPoint: p?.visual?.focalPoint || undefined,
          layoutHint: ['wide', 'balanced', 'tall'].includes(p?.visual?.layoutHint) ? p.visual.layoutHint : undefined,
        },
        visualStateChanges: Array.isArray(p?.visualStateChanges) ? p.visualStateChanges.map(normalizeChange) : [],
      })),
      choices: (Array.isArray(parsed.choices) ? parsed.choices : []).map((c: any) => ({
        text: c?.text || c?.description || '',
        summary: c?.summary || '',
      })),
    };
  };

  try {
    return buildResult(JSON.parse(jsonStr));
  } catch (_e) {
    try {
      return buildResult(JSON.parse(repairTruncatedJson(jsonStr)));
    } catch (_e2) {
      if (typeof (globalThis as any).App !== 'undefined')
        (globalThis as any).App.logError('parsePlannedPageResponse', _e2, text?.substring(0, 200));
      return null;
    }
  }
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

/** Pick the first finite positive number from a list of candidate metadata fields. */
function firstPositiveNumber(...candidates: any[]): number | null {
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

/**
 * Normalize one raw NanoGPT image-model entry into the app's ImageModel shape.
 * Accepts known field variants so response-shape differences don't leak
 * through the rest of the app (spec §6.1).
 */
export function normalizeImageModel(m: any): ImageModel {
  const supportedParameters = m.supported_parameters || m.supportedParameters || null;
  const inputModalities =
    m.input_modalities || m.inputModalities || m.architecture?.input_modalities || m.modalities?.input || null;
  return {
    id: m.id || m.model,
    name: m.name || m.id || m.model,
    owned_by: m.owned_by || m.provider || '',
    pricing: m.pricing || null,
    // NanoGPT API returns image_to_image support under capabilities.image_to_image
    supports_edit: m.capabilities?.image_to_image ?? m.supports_edit ?? false,
    // Capture supported sizes — NanoGPT API returns them under supported_parameters.resolutions
    sizes: m.sizes || m.supported_sizes || m.image_sizes || supportedParameters?.resolutions || null,
    inputModalities: Array.isArray(inputModalities) ? inputModalities : undefined,
    maxInputImages: firstPositiveNumber(
      m.max_input_images,
      m.maxInputImages,
      m.max_images,
      supportedParameters?.max_input_images,
      supportedParameters?.max_images,
      m.capabilities?.max_input_images,
    ),
    maxOutputImages: firstPositiveNumber(
      m.max_output_images,
      m.maxOutputImages,
      m.max_outputs,
      supportedParameters?.max_output_images,
      supportedParameters?.n?.max,
      m.capabilities?.max_output_images,
    ),
    supportedParameters: supportedParameters || undefined,
  };
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

  if (!forceRefresh && normalizedCache && cacheCurrent && Date.now() - cachedAt < CACHE_TTL) {
    _modelSizesCache = normalizedCache;
    _lastImageModelSource = 'cache';
    return normalizedCache;
  }
  const shouldAttemptMigration = !cacheCurrent && Date.now() >= migrationRetryAt;
  if (!forceRefresh && normalizedCache && !cacheCurrent && !shouldAttemptMigration) {
    _modelSizesCache = normalizedCache;
    _lastImageModelSource = 'cache';
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
      _lastImageModelSource = 'cache';
      return normalizedCache;
    }
    _lastImageModelSource = 'fallback';
    return FALLBACK_IMAGE_MODELS.map((id) => ({ id, name: id, owned_by: '' }));
  }
}

function getImageModelSource(): 'live' | 'cache' | 'fallback' {
  return _lastImageModelSource;
}

// Models that support the `dimensions` parameter for dimension reduction
const DIMENSION_REDUCTION_MODELS: Set<string> = new Set([
  'text-embedding-3-small',
  'text-embedding-3-large',
  'Qwen/Qwen3-Embedding-0.6B',
  'Qwen/Qwen3-Embedding-4B',
  'qwen/qwen3-embedding-8b',
]);

/**
 * Generate a contextual caption for an uploaded image using a vision-capable model.
 * The caption is optimised for use as an embedding description that matches comic
 * panel prompts.  contextHints narrows the prompt to the specific context:
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
 * Generate a text embedding via NanoGPT embeddings API.
 * Reads the embedding model from settings (configurable in Settings page).
 * Only sends `dimensions` for models that support dimension reduction.
 * Returns a plain number array, or null if the call fails.
 */
async function generateEmbedding(text: string, options: EmbeddingOptions = {}): Promise<number[] | null> {
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  const model = options.model || (await DB.getSetting('embeddingModel', 'text-embedding-3-small'));
  const body: any = {
    input: text,
    model,
    encoding_format: 'float',
  };
  // Only include dimensions for models that support dimension reduction
  if (DIMENSION_REDUCTION_MODELS.has(model)) {
    body.dimensions = options.dimensions || 256;
  }

  try {
    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (typeof (globalThis as any).App !== 'undefined')
        (globalThis as any).App.logError(
          'generateEmbedding',
          new Error(`HTTP ${res.status}`),
          `Embedding API returned ${res.status} for text: "${text.slice(0, 80)}..."`,
        );
      return null;
    }
    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch (err) {
    if (typeof (globalThis as any).App !== 'undefined')
      (globalThis as any).App.logError(
        'generateEmbedding',
        err,
        `Embedding API call failed for text: "${text.slice(0, 80)}..."`,
      );
    return null;
  }
}

// Fallback lists used only when API is unreachable and no cache exists
const FALLBACK_TEXT_MODELS: string[] = [
  'openai/gpt-5-mini',
  'openai/gpt-5-nano',
  'openai/gpt-5',
  'openai/gpt-5.1',
  'openai/gpt-5.2',
  'claude-sonnet-4-5-20250929',
  'deepseek-chat',
  'deepseek-reasoner',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'mistral-large-latest',
  'mistral-small-latest',
  'grok-2',
  'grok-3-mini',
  'qwen-2.5-72b-instruct',
  'llama-4-scout',
  'llama-4-maverick',
  'command-r-plus',
];

const FALLBACK_IMAGE_MODELS: string[] = [
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-1-mini',
  'flux-2-turbo',
  'flux-2-pro',
  'flux-2-dev',
  'seedream-v4',
  'seedream-v4.5',
  'nano-banana',
  'nano-banana-pro',
  'qwen-image',
  'hunyuan-image-3',
];

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
  generateEmbedding,
  generateImageCaption,
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
