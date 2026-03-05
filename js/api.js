/**
 * NanoGPT API Integration
 * Handles chat completions with streaming support via the NanoGPT OpenAI-compatible API.
 */
const API = (() => {
  const BASE_URL = 'https://nano-gpt.com/api/v1';
  // In-memory cache for model sizes to avoid repeated IndexedDB reads per session
  let _modelSizesCache = null;

  // Static fallback sizes for well-known models when the live API doesn't return size info.
  // Keys are model IDs (or ID prefixes), values are arrays of supported WxH strings.
  const KNOWN_IMAGE_SIZES = {
    'gpt-image-1':          ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    'gpt-image-1.5':        ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    'gpt-image-1-mini':     ['1024x1024', 'auto'],
    'flux-2-turbo':         ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
    'flux-2-flash':         ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
    'flux-2-pro':           ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
    'flux-2-max':           ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
    'flux-2-dev':           ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
    'flux-2-flex':          ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
    'seedream-v4':          ['1024x1024', '1536x1024', '1024x1536', '2048x2048'],
    'seedream-v3':          ['1024x1024', '1152x896', '896x1152', '1344x768', '768x1344'],
    'nano-banana':          ['auto'],
    'nano-banana-pro':      ['1k', '2k', '4k'],
    'qwen-image':           ['auto', '1024x1024', '512x512', '768x1024', '1024x768'],
    'hunyuan-image-3':      ['auto', '1024x1024', '768x1024', '1024x768', '1024x1536', '1536x1024', '512x512'],
    // Legacy entries retained for backward compatibility
    'dall-e-3':             ['1024x1024', '1024x1792', '1792x1024'],
    'dall-e-2':             ['256x256', '512x512', '1024x1024'],
    'gpt-4o-image':         ['1024x1024', '1024x1792', '1792x1024'],
    'flux-pro':             ['1024x1024', '1024x768', '768x1024', '1280x768', '768x1280'],
    'flux-schnell':         ['1024x1024', '1024x768', '768x1024'],
    'flux-kontext':         ['1024x1024', '1024x768', '768x1024'],
    'stable-diffusion-xl':  ['1024x1024', '1024x768', '768x1024'],
    'stable-diffusion-3':   ['1024x1024', '1024x768', '768x1024'],
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
        const m = _modelSizesCache.find(x => x.id === modelId);
        if (m?.sizes?.length) return m.sizes;
      }
    } catch (_) { /* ignore cache errors */ }

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

    const model = options.model || await getModel();
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
        'Authorization': `Bearer ${apiKey}`,
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

    const model = options.model || await getModel();
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
        'Authorization': `Bearer ${apiKey}`,
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
            height = Math.round(height * maxDim / width);
            width = maxDim;
          } else {
            width = Math.round(width * maxDim / height);
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
    const rawRefs = options.imageDataUrls?.length > 0
      ? options.imageDataUrls.slice(0, maxRefImages)
      : options.imageDataUrl ? [options.imageDataUrl] : [];
    if (options.imageDataUrls?.length > maxRefImages) {
      console.warn(`[generateImage] Truncated reference images from ${options.imageDataUrls.length} to ${maxRefImages}`);
    }
    const compressedRefs = rawRefs.length > 0
      ? await Promise.all(rawRefs.map(u => compressDataUrl(u)))
      : null;

    // Prepend reference legend when labeled refs are provided
    const labeledRefs = options.labeledRefs;
    let finalPrompt = prompt;
    if (labeledRefs?.length > 0) {
      const legend = labeledRefs
        .slice(0, maxRefImages)
        .map((ref, i) => {
          const details = ref.description ? ` — ${ref.description}` : (ref.tag && ref.tag !== 'default' ? ` (${ref.tag})` : '');
          let instruction;
          switch (ref.type) {
            case 'character':
              instruction = "Replicate this character's exact appearance.";
              break;
            case 'world':
              instruction = 'Use this as an environment and style reference for the setting.';
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

    const res = await fetch(`${BASE_URL}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const apiMsg = errData.error?.message || errData.message
        || `HTTP ${res.status} ${res.statusText}`;
      const error = new Error(
        `Image generation failed [HTTP ${res.status}]\n` +
        `Model: ${modelId}  Size: ${resolution}\n` +
        `API: ${apiMsg}\n` +
        `Prompt: ${prompt}`
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
   * Build system prompt for comic generation
   */
  function buildSystemPrompt(genre, characters, world, customSystemPrompt) {
    const base = customSystemPrompt || `You are a masterful comic book creator specializing in ${genre} stories.`;

    let prompt = `${base}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, just raw JSON.

Your response must be a JSON object with this exact structure:
{
  "title": "Page title",
  "panels": [
    {
      "narration": "Scene-setting narration text (optional)",
      "imagePrompt": "Detailed visual description for AI image generation - describe the scene, characters, action, lighting, style, camera angle",
      "dialogue": [
        { "speaker": "Character Name", "text": "What they say" }
      ]
    }
  ],
  "choices": [
    { "text": "Choice description for the reader", "summary": "Brief consequence summary" }
  ]
}

Generate 3-4 panels per page. Each panel needs:
- A vivid imagePrompt describing the visual scene in detail (for AI art generation). Include each character's physical appearance details (clothing, hair, build, distinguishing features) so the image generator maintains visual consistency.
- Optional narration for scene-setting
- Character dialogue that advances the story

CRITICAL: In each panel's "imagePrompt", you MUST explicitly name every character
who appears in that panel and include their full physical appearance description
inline. Do NOT just say "the hero" — say "Nova (tall woman with silver hair,
black armor, glowing blue eyes)". This is essential for visual consistency.
If a panel has NO characters (e.g., establishing shot), say "No characters present."

Provide 2-3 meaningful choices at the end that affect the story direction.`;

    if (characters && characters.length > 0) {
      prompt += '\n\nCHARACTERS:\n';
      for (const c of characters) {
        prompt += `- ${c.name}: ${c.description}`;
        if (c.role) prompt += ` (Role: ${c.role})`;
        if (c.appearance) prompt += ` | Appearance: ${c.appearance}`;
        prompt += '\n';
      }
    }

    if (world) {
      prompt += `\nWORLD SETTING:\nName: ${world.name}\nDescription: ${world.description}\n`;
      if (world.details) prompt += `Details: ${world.details}\n`;
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
      if (escape) { escape = false; continue; }
      if (c === '\\' && inString) { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
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

    const buildResult = parsed => ({
      title: parsed.title || 'Untitled Page',
      panels: (parsed.panels || []).map(p => ({
        narration: p.narration || '',
        imagePrompt: p.imagePrompt || p.image_prompt || '',
        dialogue: (p.dialogue || []).map(d => ({
          speaker: d.speaker || 'Unknown',
          text: d.text || '',
        })),
      })),
      choices: (parsed.choices || []).map(c => ({
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
        if (typeof App !== 'undefined') App.logError('parseComicResponse', _e2, text?.substring(0, 200));
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
      if (cached && (Date.now() - cachedAt) < CACHE_TTL) return cached;
    }

    try {
      const res = await fetch(`${BASE_URL}/models?detailed=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.data || data || []).map(m => ({
        id: m.id,
        name: m.name || m.id,
        owned_by: m.owned_by || '',
        context_length: m.context_length || null,
        pricing: m.pricing || null,
        // NanoGPT API returns capabilities under a nested `capabilities` object
        supports_vision: (m.capabilities?.vision ?? m.supports_vision) ?? false,
        supports_tools: (m.capabilities?.tool_calling ?? m.supports_tools) ?? false,
      })).sort((a, b) => a.id.localeCompare(b.id));

      await DB.setSetting(CACHE_KEY, models);
      await DB.setSetting(CACHE_TS_KEY, Date.now());
      return models;
    } catch (err) {
      if (typeof App !== 'undefined') App.logError('fetchTextModels', err);
      // Return cache even if expired, or fallback
      const cached = await DB.getSetting(CACHE_KEY, null);
      if (cached) return cached;
      return FALLBACK_TEXT_MODELS.map(id => ({ id, name: id, owned_by: '' }));
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
      if (cached && (Date.now() - cachedAt) < CACHE_TTL) return cached;
    }

    try {
      const apiKey = await getApiKey();
      const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
      const res = await fetch(`${BASE_URL}/image-models?detailed=true`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.data || data || []).map(m => ({
        id: m.id || m.model,
        name: m.name || m.id || m.model,
        owned_by: m.owned_by || m.provider || '',
        pricing: m.pricing || null,
        // NanoGPT API returns image_to_image support under capabilities.image_to_image
        supports_edit: (m.capabilities?.image_to_image ?? m.supports_edit) ?? false,
        // Capture supported sizes — NanoGPT API returns them under supported_parameters.resolutions
        sizes: m.sizes || m.supported_sizes || m.image_sizes || m.supported_parameters?.resolutions || null,
      })).sort((a, b) => a.id.localeCompare(b.id));

      await DB.setSetting(CACHE_KEY, models);
      await DB.setSetting(CACHE_TS_KEY, Date.now());
      _modelSizesCache = models; // Update in-memory cache immediately
      return models;
    } catch (err) {
      if (typeof App !== 'undefined') App.logError('fetchImageModels', err);
      const cached = await DB.getSetting(CACHE_KEY, null);
      if (cached) return cached;
      return FALLBACK_IMAGE_MODELS.map(id => ({ id, name: id, owned_by: '' }));
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
   * Generate a text embedding via NanoGPT embeddings API.
   * Reads the embedding model from settings (configurable in Settings page).
   * Only sends `dimensions` for models that support dimension reduction.
   * Returns a plain number array, or null if the call fails.
   */
  async function generateEmbedding(text, options = {}) {
    const apiKey = await getApiKey();
    if (!apiKey) return null;

    const model = options.model || await DB.getSetting('embeddingModel', 'text-embedding-3-small');
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
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (typeof App !== 'undefined') App.logError('generateEmbedding', new Error(`HTTP ${res.status}`), `Embedding API returned ${res.status} for text: "${text.slice(0, 80)}..."`);
        return null;
      }
      const data = await res.json();
      return data?.data?.[0]?.embedding || null;
    } catch (err) {
      if (typeof App !== 'undefined') App.logError('generateEmbedding', err, `Embedding API call failed for text: "${text.slice(0, 80)}..."`);
      return null;
    }
  }

  // Fallback lists used only when API is unreachable and no cache exists
  const FALLBACK_TEXT_MODELS = [
    'openai/gpt-5-mini', 'openai/gpt-5-nano', 'openai/gpt-5',
    'openai/gpt-5.1', 'openai/gpt-5.2',
    'claude-sonnet-4-5-20250929',
    'deepseek-chat', 'deepseek-reasoner',
    'gemini-2.5-flash', 'gemini-2.5-pro',
    'mistral-large-latest', 'mistral-small-latest',
    'grok-2', 'grok-3-mini',
    'qwen-2.5-72b-instruct',
    'llama-4-scout', 'llama-4-maverick',
    'command-r-plus',
  ];

  const FALLBACK_IMAGE_MODELS = [
    'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini',
    'flux-2-turbo', 'flux-2-pro', 'flux-2-dev',
    'seedream-v4', 'seedream-v4.5',
    'nano-banana', 'nano-banana-pro',
    'qwen-image', 'hunyuan-image-3',
  ];

  return {
    chatCompletion,
    chatCompletionStream,
    generateImage,
    generateEmbedding,
    buildSystemPrompt,
    parseComicResponse,
    getApiKey,
    getModel,
    getModelParams,
    fetchTextModels,
    fetchImageModels,
    getModelSizes,
    FALLBACK_TEXT_MODELS,
    FALLBACK_IMAGE_MODELS,
    KNOWN_IMAGE_SIZES,
    BASE_URL,
  };
})();
