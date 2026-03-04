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

    const imageModel = await DB.getSetting('imageModel', '');
    const showExplicitContent = await DB.getSetting('showExplicitContent', false);
    const modelId = options.model || imageModel;
    if (!modelId) throw new Error('No image model configured. Go to Settings to select an image model.');
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

    try {
      const parsed = JSON.parse(jsonStr);
      return {
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
      };
    } catch (e) {
      if (typeof App !== 'undefined') App.logError('parseComicResponse', e, text?.substring(0, 200));
      return null;
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
        supports_vision: m.supports_vision || false,
        supports_tools: m.supports_tools || false,
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
        supports_edit: m.supports_edit || false,
        // Capture supported sizes if the API provides them
        sizes: m.sizes || m.supported_sizes || m.image_sizes || null,
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

  /**
   * Generate a text embedding via NanoGPT embeddings API.
   * Returns a plain number array, or null if the call fails.
   */
  async function generateEmbedding(text, options = {}) {
    const apiKey = await getApiKey();
    if (!apiKey) return null;

    const body = {
      input: text,
      model: options.model || 'text-embedding-3-small',
      encoding_format: 'float',
      dimensions: options.dimensions || 256,
    };

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
    'gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'chatgpt-4o-latest', 'gpt-4.5-preview',
    'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229', 'claude-3-haiku-20240307',
    'deepseek-chat', 'deepseek-reasoner',
    'gemini-2.0-flash', 'gemini-2.5-pro-preview-05-06',
    'gemini-1.5-pro', 'gemini-1.5-flash',
    'llama-3.3-70b', 'llama-3.1-405b',
    'mistral-large-latest', 'mistral-small-latest',
    'grok-2', 'grok-2-mini',
    'qwen-2.5-72b-instruct', 'qwen-2.5-coder-32b-instruct',
    'command-r-plus', 'command-r',
    'yi-large', 'phi-4',
  ];

  const FALLBACK_IMAGE_MODELS = [
    'gpt-image-1', 'dall-e-3', 'gpt-4o-image',
    'flux-pro', 'flux-kontext', 'flux-schnell',
    'stable-diffusion-xl', 'stable-diffusion-3',
    'hidream', 'midjourney',
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
