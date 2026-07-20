/**
 * Pure model-catalog logic: model shapes, static size fallbacks, response
 * normalization, and display helpers. No DB or network access — everything
 * here is synchronous and unit-testable in Node.
 */

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

// Static fallback sizes for well-known models when the live API doesn't return size info.
// Keys are model IDs (or ID prefixes), values are arrays of supported WxH strings.
export const KNOWN_IMAGE_SIZES: Record<string, string[]> = {
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
 * Static fallback path of getModelSizes(): exact KNOWN_IMAGE_SIZES lookup,
 * then prefix match (e.g. "flux-schnell-v2" matches "flux-schnell").
 * Returns null when the model is unknown.
 */
export function getModelSizesStatic(modelId: string | null | undefined): string[] | null {
  if (!modelId) return null;
  if (KNOWN_IMAGE_SIZES[modelId]) return KNOWN_IMAGE_SIZES[modelId];
  for (const [prefix, sizes] of Object.entries(KNOWN_IMAGE_SIZES)) {
    if (modelId.startsWith(prefix)) return sizes;
  }
  return null;
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

// Fallback lists used only when API is unreachable and no cache exists
export const FALLBACK_TEXT_MODELS: string[] = [
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

export const FALLBACK_IMAGE_MODELS: string[] = [
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

/** Human-readable provider name for a model, from owned_by, id namespace, or id prefix. */
export function extractProvider(model: any): string {
  // Try owned_by first
  if (model.owned_by) return model.owned_by;
  // Try to extract from model id (e.g. "openai/gpt-4o" -> "openai")
  const slashIdx = model.id.indexOf('/');
  if (slashIdx > 0) return model.id.substring(0, slashIdx);
  // Guess from common prefixes
  const id = model.id.toLowerCase();
  if (
    id.startsWith('gpt-') ||
    id.startsWith('chatgpt') ||
    id.startsWith('dall-e') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4')
  )
    return 'OpenAI';
  if (id.startsWith('claude')) return 'Anthropic';
  if (id.startsWith('gemini') || id.startsWith('nano-banana')) return 'Google';
  if (id.startsWith('llama') || id.startsWith('meta-llama')) return 'Meta';
  if (id.startsWith('mistral') || id.startsWith('codestral') || id.startsWith('pixtral')) return 'Mistral';
  if (id.startsWith('deepseek')) return 'DeepSeek';
  if (id.startsWith('grok')) return 'xAI';
  if (id.startsWith('qwen') || id.startsWith('wan-') || id.startsWith('z-image')) return 'Alibaba';
  if (id.startsWith('command')) return 'Cohere';
  if (id.startsWith('flux') || id.startsWith('schnell')) return 'Black Forest Labs';
  if (id.startsWith('stable-diffusion') || id.startsWith('sdxl') || id.startsWith('sd3')) return 'Stability AI';
  if (id.startsWith('seedream') || id.startsWith('seedvr')) return 'ByteDance';
  if (id.startsWith('hunyuan')) return 'Tencent';
  if (id.startsWith('cogview') || id.startsWith('glm')) return 'Zhipu';
  if (id.startsWith('kling')) return 'Kling';
  if (id.startsWith('vidu')) return 'Vidu';
  if (id.startsWith('minimax')) return 'MiniMax';
  if (id.startsWith('yi-')) return '01.AI';
  if (id.startsWith('phi-')) return 'Microsoft';
  if (id.startsWith('nova-') || id.startsWith('amazon')) return 'Amazon';
  if (id.startsWith('kimi')) return 'Moonshot';
  // Retained for cached model data from older sessions or future API additions
  if (id.startsWith('hidream')) return 'HiDream';
  if (id.startsWith('midjourney')) return 'Midjourney';
  if (id.startsWith('riverflow')) return 'Sourceful';
  if (id.startsWith('lucid')) return 'Leonardo AI';
  return 'Other';
}

/** One-line capability/pricing summary for the model-picker UI (" &middot; "-joined). */
export function buildModelDetails(m: any): string {
  const parts = [];
  if (m.context_length) parts.push(`${(m.context_length / 1000).toFixed(0)}K ctx`);
  if (m.supports_vision) parts.push('vision');
  if (m.supports_tools) parts.push('tools');
  if (m.supports_edit) parts.push('edit');
  if (m.pricing) {
    if (typeof m.pricing === 'object') {
      // Text models: pricing.prompt is per-million-tokens
      if (m.pricing.prompt != null) {
        parts.push(`$${m.pricing.prompt}/1M in`);
        // Image models: pricing.per_image is { resolution: cost }
      } else if (m.pricing.per_image && typeof m.pricing.per_image === 'object') {
        const prices = Object.values(m.pricing.per_image).filter((v) => typeof v === 'number');
        if (prices.length > 0) {
          const minPrice = Math.min(...prices);
          parts.push(`$${minPrice}/img`);
        }
      }
    } else if (typeof m.pricing === 'string') {
      parts.push(m.pricing);
    }
  }
  return parts.length > 0 ? parts.join(' &middot; ') : '';
}
