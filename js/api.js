/**
 * NanoGPT API Integration
 * Handles chat completions with streaming support via the NanoGPT OpenAI-compatible API.
 */
const API = (() => {
  const BASE_URL = 'https://nano-gpt.com/api';

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
   * Generate image via NanoGPT image API
   */
  async function generateImage(prompt, options = {}) {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('API key not set. Go to Settings to add your NanoGPT API key.');

    const imageModel = await DB.getSetting('imageModel', 'gpt-image-1');
    const body = {
      model: options.model || imageModel,
      prompt,
      size: options.size || '1024x1024',
      response_format: 'url',
    };

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
      throw new Error(err.error?.message || `Image API error: ${res.status}`);
    }

    const data = await res.json();
    return data.data?.[0]?.url || data.data?.[0]?.b64_json;
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
- A vivid imagePrompt describing the visual scene in detail (for AI art generation)
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
      console.error('Failed to parse comic response:', e, text);
      return null;
    }
  }

  /**
   * Fetch available text models from NanoGPT API
   */
  async function fetchTextModels() {
    try {
      const res = await fetch(`${BASE_URL}/v1/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.data && Array.isArray(data.data)) {
        return data.data
          .map(m => m.id)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
      }
      return [];
    } catch (e) {
      console.warn('Failed to fetch text models:', e);
      return [];
    }
  }

  /**
   * Fetch available image models from NanoGPT API
   */
  async function fetchImageModels() {
    try {
      const res = await fetch(`${BASE_URL}/v1/image-models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.data && Array.isArray(data.data)) {
        return data.data
          .map(m => m.id)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
      }
      return [];
    } catch (e) {
      console.warn('Failed to fetch image models:', e);
      return [];
    }
  }

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
    BASE_URL,
  };
})();
