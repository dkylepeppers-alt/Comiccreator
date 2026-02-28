/**
 * NanoGPT API Integration
 * Handles chat completions with streaming support via the NanoGPT OpenAI-compatible API.
 */
const API = (() => {
  const BASE_URL = 'https://nano-gpt.com/api/v1';
  const DEFAULT_IMAGE_MODEL = 'gpt-image-1';

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
  function compressDataUrl(dataUrl, maxDim = 768, quality = 0.75) {
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
   * Convert a base64 data URL to a Blob for multipart/form-data uploads.
   */
  function dataUrlToBlob(dataUrl) {
    const [header, b64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /**
   * Image-to-image via /images/edits with multipart/form-data.
   * Used when reference images are provided.
   * Caps at 3 reference images; compresses each before upload.
   */
  async function generateImageWithEdit(prompt, modelId, options) {
    const apiKey = await getApiKey();

    // Collect and compress reference images (cap at 3)
    const rawRefs = options.imageDataUrls?.length > 0
      ? options.imageDataUrls.slice(0, 3)
      : [options.imageDataUrl];
    const compressed = await Promise.all(rawRefs.map(u => compressDataUrl(u)));

    const form = new FormData();
    form.append('model', modelId);
    form.append('prompt', prompt);
    form.append('size', options.size || '1024x1024');
    if (options.showExplicitContent) form.append('showExplicitContent', 'true');
    for (let i = 0; i < compressed.length; i++) {
      form.append('image', dataUrlToBlob(compressed[i]), `reference-${i + 1}.jpg`);
    }

    // Do NOT set Content-Type — the browser must set it with the multipart boundary
    const res = await fetch(`${BASE_URL}/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error?.message || err.message || `Image edit API error: ${res.status} ${res.statusText}`;
      console.error('Image edit error:', res.status, err);
      throw new Error(msg);
    }

    const data = await res.json();
    const result = data.data?.[0]?.url || data.data?.[0]?.b64_json;
    if (!result) throw new Error('No image data in API response');
    return result;
  }

  /**
   * Generate image via NanoGPT image API.
   *
   * Two-call strategy:
   *   1. If reference images are provided, first try /images/edits with multipart/form-data.
   *   2. If that fails (unsupported model/endpoint/etc.), fallback to /images/generations JSON.
   */
  async function generateImage(prompt, options = {}) {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('API key not set. Go to Settings to add your NanoGPT API key.');

    const imageModel = await DB.getSetting('imageModel', DEFAULT_IMAGE_MODEL);
    const showExplicitContent = await DB.getSetting('showExplicitContent', false);
    const modelId = options.model || imageModel;

    const hasRefImages = !!(options.imageDataUrl || options.imageDataUrls?.length > 0);
    if (hasRefImages) {
      try {
        return await generateImageWithEdit(prompt, modelId, { ...options, showExplicitContent });
      } catch (editErr) {
        console.warn('Image edit failed; falling back to text-to-image generation', editErr);
      }
    }

    const imageSize = options.size || '1024x1024';

    async function requestImage(model, size) {
      const body = { model, prompt, size };
      if (showExplicitContent) body.showExplicitContent = true;
      const res = await fetch(`${BASE_URL}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.error?.message || err.message || `Image API error: ${res.status} ${res.statusText}`;
        console.error('Image generation error:', res.status, err);
        const error = new Error(msg);
        error.status = res.status;
        throw error;
      }

      const data = await res.json();
      const result = data.data?.[0]?.url || data.data?.[0]?.b64_json;
      if (!result) throw new Error('No image data in API response');
      return result;
    }

    try {
      return await requestImage(modelId, imageSize);
    } catch (err) {
      if (err?.status !== 500 && err?.status !== 400) throw err;
      let lastError = err;

      if (imageSize !== '1024x1024') {
        try {
          return await requestImage(modelId, '1024x1024');
        } catch (sizeRetryErr) {
          lastError = sizeRetryErr;
        }
      }

      if (modelId !== DEFAULT_IMAGE_MODEL) {
        return requestImage(DEFAULT_IMAGE_MODEL, '1024x1024');
      }

      throw lastError;
    }
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
      const res = await fetch(`${BASE_URL}/image-models?detailed=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.data || data || []).map(m => ({
        id: m.id || m.model,
        name: m.name || m.id || m.model,
        owned_by: m.owned_by || m.provider || '',
        pricing: m.pricing || null,
        supports_edit: m.supports_edit || false,
      })).sort((a, b) => a.id.localeCompare(b.id));

      await DB.setSetting(CACHE_KEY, models);
      await DB.setSetting(CACHE_TS_KEY, Date.now());
      return models;
    } catch (err) {
      if (typeof App !== 'undefined') App.logError('fetchImageModels', err);
      const cached = await DB.getSetting(CACHE_KEY, null);
      if (cached) return cached;
      return FALLBACK_IMAGE_MODELS.map(id => ({ id, name: id, owned_by: '' }));
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
    buildSystemPrompt,
    parseComicResponse,
    getApiKey,
    getModel,
    getModelParams,
    fetchTextModels,
    fetchImageModels,
    FALLBACK_TEXT_MODELS,
    FALLBACK_IMAGE_MODELS,
    BASE_URL,
  };
})();
