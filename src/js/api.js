import DB from './db.js';

/**
 * NanoGPT API Integration
 * Handles chat completions with streaming support via the NanoGPT OpenAI-compatible API.
 */
const BASE_URL = 'https://nano-gpt.com/api/v1';
// In-memory cache for model sizes to avoid repeated IndexedDB reads per session
let _modelSizesCache = null;

// Static fallback sizes for well-known models when the live API doesn't return size info.
// Keys are model IDs (or ID prefixes), values are arrays of supported WxH strings.
const KNOWN_IMAGE_SIZES = {
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
async function getModelSizes(modelId) {
  if (!modelId) return null;

  try {
    if (_modelSizesCache === null) {
      _modelSizesCache = await DB.getSetting('cachedImageModels', null);
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

async function getApiKey() {
  return DB.getSetting('apiKey', '');
}

async function getModel() {
  return DB.getSetting('model', 'gpt-4o-mini');
}

async function getModelParams() {
  return {
    temperature: await DB.getSetting('temperature', 0.7),
    topP: await DB.getSetting('topP', 0.9),
    maxTokens: await DB.getSetting('maxTokens', 2048),
  };
}

/**
 * Non-streaming chat completion
 */
async function chatCompletion(messages, options = {}) {
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
async function chatCompletionStream(messages, onChunk, options = {}) {
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

  const fetchOpts = {
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
function compressDataUrl(dataUrl, maxDim = 1024, quality = 0.85) {
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
async function enrichImagePrompt(rawPrompt, options = {}) {
  // Return falsy inputs (null, undefined, '') unchanged — mirrors how other
  // API helpers handle missing input without throwing.
  if (!rawPrompt) return rawPrompt;
  const apiKey = await getApiKey();
  if (!apiKey) return rawPrompt;

  const model = options.model || (await getModel());
  const genre = options.genre ? ` The comic genre is "${options.genre}".` : '';

  const messages = [
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
    if (typeof globalThis.App !== 'undefined') {
      globalThis.App.logError(
        'enrichImagePrompt',
        err,
        `Prompt enrichment failed — using original. Prompt: "${rawPrompt.slice(0, 80)}..."`,
      );
    }
    return rawPrompt;
  }
}

/**
 * Generate image via NanoGPT image API.
 *
 * Sends a JSON POST to /images/generations. On failure, throws with the
 * exact model, size, and prompt that were used so the caller can diagnose
 * the problem without guessing.
 */
async function generateImage(prompt, options = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not set. Go to Settings to add your NanoGPT API key.');

  const imageModel = await DB.getSetting('imageModel', 'gpt-image-1');
  const showExplicitContent = await DB.getSetting('showExplicitContent', false);
  const modelId = options.model || imageModel;
  const resolution = options.resolution || '1024x1024';

  // Collect and compress reference images (configurable cap)
  const maxRefImages = await DB.getSetting('maxRefImages', 4);
  const rawRefs =
    options.imageDataUrls?.length > 0
      ? options.imageDataUrls.slice(0, maxRefImages)
      : options.imageDataUrl
        ? [options.imageDataUrl]
        : [];
  if (options.imageDataUrls?.length > maxRefImages) {
    console.warn(`[generateImage] Truncated reference images from ${options.imageDataUrls.length} to ${maxRefImages}`);
  }
  const compressedRefs = rawRefs.length > 0 ? await Promise.all(rawRefs.map((u) => compressDataUrl(u))) : null;

  // Prepend reference legend when labeled refs are provided
  const labeledRefs = options.labeledRefs;
  let finalPrompt = prompt;
  if (labeledRefs?.length > 0) {
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

  const body = { model: modelId, prompt: finalPrompt, size: resolution, n: 1 };
  if (showExplicitContent) body.showExplicitContent = true;
  if (compressedRefs?.length > 0) body.imageDataUrls = compressedRefs;
  // Pass caller-supplied negative prompt to models that support it (ignored by models that don't)
  if (options.negativePrompt?.trim()) body.negative_prompt = options.negativePrompt.trim();

  const res = await fetch(`${BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const apiMsg = errData.error?.message || errData.message || `HTTP ${res.status} ${res.statusText}`;
    const error = new Error(
      `Image generation failed [HTTP ${res.status}]\n` +
        `Model: ${modelId}  Size: ${resolution}\n` +
        `API: ${apiMsg}\n` +
        `Prompt: ${prompt}`,
    );
    error.status = res.status;
    error.model = modelId;
    error.resolution = resolution;
    error.prompt = prompt;
    console.error('Image generation failed:', { status: res.status, model: modelId, resolution, apiMsg, prompt });
    throw error;
  }

  const data = await res.json();
  const result = data.data?.[0]?.url || data.data?.[0]?.b64_json;
  if (!result) throw new Error('No image data in API response');
  return result;
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
function buildSystemPrompt(genre, characters, world, customSystemPrompt, options) {
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
function repairTruncatedJson(str) {
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

function parseComicResponse(text) {
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

  const buildResult = (parsed) => ({
    title: parsed.title || 'Untitled Page',
    panels: (parsed.panels || []).map((p) => {
      const panel = {
        narration: p.narration || '',
        imagePrompt: p.imagePrompt || p.image_prompt || '',
        dialogue: (p.dialogue || []).map((d) => ({
          speaker: d.speaker || 'Unknown',
          text: d.text || '',
        })),
      };
      if (p.imageSize || p.image_size) panel.imageSize = p.imageSize || p.image_size;
      return panel;
    }),
    choices: (parsed.choices || []).map((c) => ({
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
      if (typeof globalThis.App !== 'undefined')
        globalThis.App.logError('parseComicResponse', _e2, text?.substring(0, 200));
      return null;
    }
  }
}

/**
 * Fetch all available text/chat models from NanoGPT.
 * Endpoint does not require authentication.
 * Returns array of model objects with id, name, owned_by, etc.
 */
async function fetchTextModels(forceRefresh = false) {
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
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        owned_by: m.owned_by || '',
        context_length: m.context_length || null,
        pricing: m.pricing || null,
        // NanoGPT API returns capabilities under a nested `capabilities` object
        supports_vision: m.capabilities?.vision ?? m.supports_vision ?? false,
        supports_tools: m.capabilities?.tool_calling ?? m.supports_tools ?? false,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    await DB.setSetting(CACHE_KEY, models);
    await DB.setSetting(CACHE_TS_KEY, Date.now());
    return models;
  } catch (err) {
    if (typeof globalThis.App !== 'undefined') globalThis.App.logError('fetchTextModels', err);
    // Return cache even if expired, or fallback
    const cached = await DB.getSetting(CACHE_KEY, null);
    if (cached) return cached;
    return FALLBACK_TEXT_MODELS.map((id) => ({ id, name: id, owned_by: '' }));
  }
}

/**
 * Fetch all available image generation models from NanoGPT.
 * Requires authentication so the API returns detailed info including supported sizes.
 */
async function fetchImageModels(forceRefresh = false) {
  const CACHE_KEY = 'cachedImageModels';
  const CACHE_TS_KEY = 'cachedImageModelsAt';
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  if (!forceRefresh) {
    const cached = await DB.getSetting(CACHE_KEY, null);
    const cachedAt = await DB.getSetting(CACHE_TS_KEY, 0);
    if (cached && Date.now() - cachedAt < CACHE_TTL) return cached;
  }

  try {
    const apiKey = await getApiKey();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`${BASE_URL}/image-models?detailed=true`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.data || data || [])
      .map((m) => ({
        id: m.id || m.model,
        name: m.name || m.id || m.model,
        owned_by: m.owned_by || m.provider || '',
        pricing: m.pricing || null,
        // NanoGPT API returns image_to_image support under capabilities.image_to_image
        supports_edit: m.capabilities?.image_to_image ?? m.supports_edit ?? false,
        // Capture supported sizes — NanoGPT API returns them under supported_parameters.resolutions
        sizes: m.sizes || m.supported_sizes || m.image_sizes || m.supported_parameters?.resolutions || null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    await DB.setSetting(CACHE_KEY, models);
    await DB.setSetting(CACHE_TS_KEY, Date.now());
    _modelSizesCache = models; // Update in-memory cache immediately
    return models;
  } catch (err) {
    if (typeof globalThis.App !== 'undefined') globalThis.App.logError('fetchImageModels', err);
    const cached = await DB.getSetting(CACHE_KEY, null);
    if (cached) return cached;
    return FALLBACK_IMAGE_MODELS.map((id) => ({ id, name: id, owned_by: '' }));
  }
}

// Models that support the `dimensions` parameter for dimension reduction
const DIMENSION_REDUCTION_MODELS = new Set([
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
async function generateImageCaption(dataUrl, contextHints = {}, options = {}) {
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

  const messages = [
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
    if (typeof globalThis.App !== 'undefined') {
      globalThis.App.logError(
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
async function generateEmbedding(text, options = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  const model = options.model || (await DB.getSetting('embeddingModel', 'text-embedding-3-small'));
  const body = {
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
      if (typeof globalThis.App !== 'undefined')
        globalThis.App.logError(
          'generateEmbedding',
          new Error(`HTTP ${res.status}`),
          `Embedding API returned ${res.status} for text: "${text.slice(0, 80)}..."`,
        );
      return null;
    }
    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch (err) {
    if (typeof globalThis.App !== 'undefined')
      globalThis.App.logError(
        'generateEmbedding',
        err,
        `Embedding API call failed for text: "${text.slice(0, 80)}..."`,
      );
    return null;
  }
}

// Fallback lists used only when API is unreachable and no cache exists
const FALLBACK_TEXT_MODELS = [
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

const FALLBACK_IMAGE_MODELS = [
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
const CHARACTER_REF_VARIATIONS = [
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

const WORLD_REF_VARIATIONS = [
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
const CHARACTER_WORLD_VARIATIONS = [
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
async function generateRefVariation(sourceDataUrl, prompt, options = {}) {
  try {
    // Use the user's configured image size rather than a hardcoded default
    const resolution = options.resolution || (await DB.getSetting('imageSize', '1024x1024'));
    // Support multiple reference images via options.imageDataUrls (array) or single sourceDataUrl
    const imageGenOpts = { resolution, model: options.model };
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
          reader.onload = () => resolve(reader.result);
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
    if (typeof globalThis.App !== 'undefined') {
      globalThis.App.logError('generateRefVariation', err, `Failed to generate variation: ${prompt.slice(0, 80)}`);
    }
    return null;
  }
}

const API = {
  chatCompletion,
  chatCompletionStream,
  generateImage,
  enrichImagePrompt,
  generateEmbedding,
  generateImageCaption,
  buildSystemPrompt,
  parseComicResponse,
  getApiKey,
  getModel,
  getModelParams,
  fetchTextModels,
  fetchImageModels,
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
  },
};
export default API;
