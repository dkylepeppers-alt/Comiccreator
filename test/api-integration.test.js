// @vitest-environment node
import { describe, it, beforeEach, expect } from 'vitest';
import 'fake-indexeddb/auto';

// Mock browser APIs needed by api.js (Image, canvas)
globalThis.Image = globalThis.Image || class {
  set src(_value) {
    this.width = 256;
    this.height = 256;
    if (this.onload) this.onload();
  }
};

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toDataURL() {
          return 'data:image/jpeg;base64,aGVsbG8=';
        },
      };
    },
  };
}

// Default fetch mock (overridden per test as needed)
globalThis.fetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });

const { default: DB } = await import('../src/js/db.js');
const { default: API } = await import('../src/js/api.js');

function sseResponse(lines) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Clear all IndexedDB stores and reset API caches between tests */
async function clearAllStores() {
  API._resetCacheForTesting();
  const db = await DB.open();
  await Promise.all(Object.values(DB.STORES).map((storeName) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }));
}

describe('API integration', () => {
  beforeEach(async () => {
    await clearAllStores();
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    await DB.setSetting('apiKey', 'test-key');
    await DB.setSetting('model', 'gpt-4o-mini');
  });

  it('chatCompletion sends auth/body and returns content', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200 });
    };
    const out = await API.chatCompletion([{ role: 'user', content: 'Hi' }], { temperature: 0.3 });
    expect(out).toBe('reply');
    expect(calls.length).toBe(1);
    expect(calls[0].opts.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0].opts.body).temperature).toBe(0.3);
  });

  it('chatCompletion throws on missing key or http error', async () => {
    await DB.setSetting('apiKey', '');
    await expect(API.chatCompletion([])).rejects.toThrow(/API key not set/);
    await DB.setSetting('apiKey', 'test-key');
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 });
    await expect(API.chatCompletion([])).rejects.toThrow(/bad/);
  });

  it('chatCompletionStream accumulates chunks and skips non-json frames', async () => {
    const deltas = [];
    globalThis.fetch = async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      'data: not-json\n',
      'data: [DONE]\n',
      '\n',
    ]);
    const text = await API.chatCompletionStream([], (chunk, full) => deltas.push([chunk, full]));
    expect(text).toBe('Hello');
    expect(deltas).toEqual([['Hel', 'Hel'], ['lo', 'Hello']]);
  });

  it('fetchTextModels sorts, caches, force-refreshes and falls back', async () => {
    let mode = 'network';
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      if (mode === 'error') throw new Error('down');
      return new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }] }), { status: 200 });
    };
    const first = await API.fetchTextModels();
    expect(first.map(m => m.id)).toEqual(['a', 'z']);
    mode = 'error';
    const cached = await API.fetchTextModels();
    expect(cached.map(m => m.id)).toEqual(['a', 'z']);
    const forced = await API.fetchTextModels(true);
    expect(forced.map(m => m.id)).toEqual(['a', 'z']);
    expect(fetchCalls).toBe(2);
  });

  it('fetchTextModels maps capabilities.vision and capabilities.tool_calling', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        // Real NanoGPT API shape: capabilities nested object
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          owned_by: 'openai',
          context_length: 128000,
          capabilities: { vision: true, tool_calling: true, reasoning: false },
          pricing: { prompt: 2.5, completion: 10, currency: 'USD', unit: 'per_million_tokens' },
        },
        // Model with no capabilities / vision & tools both false
        {
          id: 'no-caps-model',
          name: 'No Caps',
          owned_by: 'other',
          capabilities: { vision: false, tool_calling: false },
        },
      ],
    }), { status: 200 });

    const models = await API.fetchTextModels(true);

    const gpt4o = models.find(m => m.id === 'gpt-4o');
    expect(gpt4o.supports_vision).toBe(true);
    expect(gpt4o.supports_tools).toBe(true);

    const noCaps = models.find(m => m.id === 'no-caps-model');
    expect(noCaps.supports_vision).toBe(false);
    expect(noCaps.supports_tools).toBe(false);
  });


  it('fetchImageModels caches and falls back to defaults when empty cache', async () => {
    globalThis.fetch = async () => {
      throw new Error('down');
    };
    const fallback = await API.fetchImageModels(true);
    expect(Array.isArray(fallback)).toBeTruthy();
    expect(fallback.length > 0).toBeTruthy();
  });

  it('fetchImageModels sends Authorization header and caches sizes from response', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({
        data: [
          // Real API shape: sizes under supported_parameters.resolutions
          { id: 'gpt-image-1', name: 'GPT 4o Image', owned_by: 'openai', supported_parameters: { resolutions: ['1024x1024', '1536x1024', '1024x1536', 'auto'] } },
          // Legacy field names still supported as fallbacks
          { id: 'flux-pro', name: 'Flux Pro', owned_by: 'Black Forest Labs', sizes: ['512x512', '1024x1024'] },
          { id: 'dall-e-3', name: 'DALL-E 3', owned_by: 'OpenAI', supported_sizes: ['1024x1024', '1024x1792'] },
        ],
      }), { status: 200 });
    };

    const models = await API.fetchImageModels(true);

    // Auth header must be sent
    expect(calls.length).toBe(1);
    expect(calls[0].opts.headers.Authorization).toBe('Bearer test-key');

    // Models should be sorted by id and sizes captured from all field variants
    const gpt = models.find(m => m.id === 'gpt-image-1');
    expect(gpt.sizes).toEqual(['1024x1024', '1536x1024', '1024x1536', 'auto']);
    const dall3 = models.find(m => m.id === 'dall-e-3');
    expect(dall3.sizes).toEqual(['1024x1024', '1024x1792']);
    const flux = models.find(m => m.id === 'flux-pro');
    expect(flux.sizes).toEqual(['512x512', '1024x1024']);

    // Sizes should be available via getModelSizes after fetch
    const sizes = await API.getModelSizes('gpt-image-1');
    expect(sizes).toEqual(['1024x1024', '1536x1024', '1024x1536', 'auto']);
  });

  it('fetchImageModels maps capabilities.image_to_image to supports_edit', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        // Real NanoGPT API shape: edit support under capabilities.image_to_image
        { id: 'flux-kontext', name: 'Flux Kontext', owned_by: 'Black Forest Labs', capabilities: { image_generation: true, image_to_image: true }, supported_parameters: { resolutions: ['1024x1024'] } },
        // Text-to-image only model
        { id: 'nano-banana-pro-ultra', name: 'NBP Ultra', owned_by: 'gemini', capabilities: { image_generation: true, image_to_image: false }, supported_parameters: { resolutions: ['4k', '8k'] } },
      ],
    }), { status: 200 });

    const models = await API.fetchImageModels(true);

    const editModel = models.find(m => m.id === 'flux-kontext');
    expect(editModel.supports_edit).toBe(true);

    const textOnly = models.find(m => m.id === 'nano-banana-pro-ultra');
    expect(textOnly.supports_edit).toBe(false);
  });

  it('getModelSizes returns cached sizes when present, null when missing or no sizes', async () => {
    // Seed the IndexedDB cache with one model that has sizes and one without
    await DB.setSetting('cachedImageModels', [
      { id: 'model-with-sizes', sizes: ['512x512', '1024x1024'] },
      { id: 'model-no-sizes', sizes: null },
      { id: 'model-empty-sizes', sizes: [] },
    ]);

    // Model with sizes should return those sizes
    const withSizes = await API.getModelSizes('model-with-sizes');
    expect(withSizes).toEqual(['512x512', '1024x1024']);

    // Model with null sizes should return null
    const noSizes = await API.getModelSizes('model-no-sizes');
    expect(noSizes).toBe(null);

    // Model with empty sizes array should return null
    const emptySizes = await API.getModelSizes('model-empty-sizes');
    expect(emptySizes).toBe(null);

    // Unknown model (not in cache) should return null
    const unknown = await API.getModelSizes('unknown-model');
    expect(unknown).toBe(null);

    // Null/undefined modelId should return null
    expect(await API.getModelSizes(null)).toBe(null);
    expect(await API.getModelSizes('')).toBe(null);
  });

  it('generateImage uses default gpt-image-1 model when none explicitly configured', async () => {
    // No imageModel saved — should use default 'gpt-image-1'
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: 'default-img' }] }), { status: 200 });
    };
    const result = await API.generateImage('draw scene');
    expect(result).toBe('default-img');
    expect(calls[0].body.model).toBe('gpt-image-1');
  });

  it('generateImage throws with diagnostic properties and makes exactly one request on 500 error', async () => {
    await DB.setSetting('imageModel', 'unstable-model');
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return new Response('{"error":{"message":"Internal server error"}}', { status: 500 });
    };

    let caught;
    try {
      await API.generateImage('draw scene', { resolution: '1792x1024' });
      throw new Error('Expected to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(500);
    expect(caught.model).toBe('unstable-model');
    expect(caught.resolution).toBe('1792x1024');
    expect(caught.prompt).toBe('draw scene');
    expect(caught.message).toMatch(/Image generation failed \[HTTP 500\]/);
    expect(calls.length).toBe(1);
    expect([calls[0].model, calls[0].size]).toEqual(['unstable-model', '1792x1024']);
  });

  it('generateImage sends reference images as imageDataUrls in JSON body', async () => {
    await DB.setSetting('imageModel', 'ref-model');
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      return new Response(JSON.stringify({ data: [{ b64_json: 'ref-img' }] }), { status: 200 });
    };

    const result = await API.generateImage('draw scene', {
      imageDataUrls: [
        'data:image/png;base64,aGVsbG8=',
        'data:image/png;base64,aGVsbG8=',
      ],
    });

    expect(result).toBe('ref-img');
    expect(calls.length).toBe(1);
    expect(calls[0].url.endsWith('/images/generations')).toBeTruthy();
    expect(calls[0].body.model).toBe('ref-model');
    expect(calls[0].body.prompt).toBe('draw scene');
    expect(calls[0].body.n).toBe(1);
    expect(Array.isArray(calls[0].body.imageDataUrls)).toBeTruthy();
    expect(calls[0].body.imageDataUrls.length).toBe(2);
    expect(calls[0].headers['Authorization']).toBe('Bearer test-key');
  });

  it('generateImage includes showExplicitContent and n when enabled', async () => {
    await DB.setSetting('showExplicitContent', true);
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ url: 'https://img.test/explicit.png' }] }), { status: 200 });
    };

    const result = await API.generateImage('draw scene');
    expect(result).toBe('https://img.test/explicit.png');
    expect(requestBody.showExplicitContent).toBe(true);
    expect(requestBody.n).toBe(1);
    expect(requestBody.size).toBeTruthy();
  });

  it('generateEmbedding returns null when no API key is set', async () => {
    await DB.setSetting('apiKey', '');
    const result = await API.generateEmbedding('test text');
    expect(result).toBe(null);
  });

  it('generateEmbedding reads model from settings and sends dimensions for supported models', async () => {
    const calls = [];
    const fakeEmbedding = [0.1, -0.2, 0.3, 0.4];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: fakeEmbedding }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }), { status: 200 });
    };

    // Default model (text-embedding-3-small) supports dimension reduction
    const result = await API.generateEmbedding('hero with cape');

    expect(result).toEqual(fakeEmbedding);
    expect(calls.length).toBe(1);
    expect(calls[0].url.endsWith('/embeddings')).toBeTruthy();
    expect(calls[0].headers['Authorization']).toBe('Bearer test-key');
    expect(calls[0].body.input).toBe('hero with cape');
    expect(calls[0].body.model).toBe('text-embedding-3-small');
    expect(calls[0].body.encoding_format).toBe('float');
    expect(calls[0].body.dimensions).toBe(256);
  });

  it('generateEmbedding reads configured embeddingModel from settings', async () => {
    await DB.setSetting('embeddingModel', 'qwen/qwen3-embedding-8b');
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: [{ embedding: [0.5, 0.5] }],
      }), { status: 200 });
    };

    await API.generateEmbedding('test');
    expect(requestBody.model).toBe('qwen/qwen3-embedding-8b');
    expect(requestBody.dimensions).toBe(256);
  });

  it('generateEmbedding omits dimensions for models that do not support it', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: [{ embedding: [0.5, 0.5] }],
      }), { status: 200 });
    };

    // BAAI/bge-m3 does NOT support dimension reduction
    await API.generateEmbedding('test', { model: 'BAAI/bge-m3' });
    expect(requestBody.model).toBe('BAAI/bge-m3');
    expect(requestBody.dimensions).toBe(undefined);
  });

  it('generateEmbedding uses explicit options.model override over settings', async () => {
    await DB.setSetting('embeddingModel', 'qwen/qwen3-embedding-8b');
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: [{ embedding: [0.5, 0.5] }],
      }), { status: 200 });
    };

    await API.generateEmbedding('test', { model: 'text-embedding-3-large' });
    expect(requestBody.model).toBe('text-embedding-3-large');
    expect(requestBody.dimensions).toBe(256);
  });

  it('generateEmbedding returns null on HTTP error', async () => {
    globalThis.fetch = async () => new Response('{"error":{"message":"bad request"}}', { status: 400 });
    const result = await API.generateEmbedding('test text');
    expect(result).toBe(null);
  });

  it('generateEmbedding returns null on network error', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    const result = await API.generateEmbedding('test text');
    expect(result).toBe(null);
  });

  it('generateEmbedding returns null when response has no embedding data', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const result = await API.generateEmbedding('test text');
    expect(result).toBe(null);
  });

  it('generateImageCaption returns null when no API key is set', async () => {
    await DB.setSetting('apiKey', '');
    const result = await API.generateImageCaption('data:image/png;base64,abc', { type: 'character', name: 'Hero' });
    expect(result).toBe(null);
  });

  it('generateImageCaption returns null (silently) for non-vision models without calling fetch', async () => {
    // Seed the model cache with a model that explicitly has supports_vision = false
    await DB.setSetting('cachedTextModels', [
      { id: 'no-vision-model', supports_vision: false, supports_tools: false },
    ]);
    await DB.setSetting('cachedTextModelsAt', Date.now());
    await DB.setSetting('captionModel', 'no-vision-model');
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
    const result = await API.generateImageCaption('data:image/png;base64,abc', { type: 'character', name: 'Hero' });
    expect(result).toBe(null);
    expect(fetchCalled).toBe(false);
  });

  it('generateImageCaption uses captionModel setting when set, falls back to text model', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A hero in red armor.' } }] }), { status: 200 });
    };
    // With explicit captionModel
    await DB.setSetting('captionModel', 'gpt-4o');
    const r1 = await API.generateImageCaption('data:image/jpeg;base64,abc', { type: 'character', name: 'Iron Man', role: 'hero', tag: 'action-pose' });
    expect(r1).toBe('A hero in red armor.');
    expect(calls[0].body.model).toBe('gpt-4o');
    // Without captionModel, falls back to text model from settings
    await DB.setSetting('captionModel', '');
    await API.generateImageCaption('data:image/jpeg;base64,abc', { type: 'character', name: 'Iron Man' });
    expect(calls[1].body.model).toBe('gpt-4o-mini'); // default from beforeEach
  });

  it('generateImageCaption sends vision message with compressed image and context', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Neon skyline at dusk.' } }] }), { status: 200 });
    };
    await DB.setSetting('captionModel', 'gpt-4o');
    const result = await API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'world', name: 'Neo-Tokyo', era: '2099', tag: 'night' },
    );
    expect(result).toBe('Neon skyline at dusk.');
    // System message is first to frame the comic context
    const sysMsg = requestBody.messages[0];
    expect(sysMsg.role).toBe('system');
    expect(sysMsg.content.includes('comic book')).toBeTruthy();
    // Vision user message is second
    const userMsg = requestBody.messages[1];
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBeTruthy();
    const imagePart = userMsg.content.find(c => c.type === 'image_url');
    expect(imagePart).toBeTruthy();
    // The image URL should be a compressed JPEG (from compressDataUrl)
    expect(imagePart.image_url.url.startsWith('data:image/')).toBeTruthy();
    const textPart = userMsg.content.find(c => c.type === 'text');
    expect(textPart.text.includes('Neo-Tokyo')).toBeTruthy();
    expect(textPart.text.includes('2099')).toBeTruthy();
    expect(textPart.text.includes('night')).toBeTruthy();
    // Model params
    expect(requestBody.max_tokens).toBe(120);
    expect(requestBody.temperature).toBe(0.3);
  });

  it('generateImageCaption anchors description to character name when provided', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Iron Man stands in red and gold armor.' } }] }), { status: 200 });
    };
    await DB.setSetting('captionModel', 'gpt-4o');
    await API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character', name: 'Iron Man', role: 'hero', tag: 'action-pose', appearance: 'red and gold armor' },
    );
    const userMsg = requestBody.messages[1];
    const textPart = userMsg.content.find(c => c.type === 'text');
    // Prompt must mention character name and request name-anchored description
    expect(textPart.text.includes('Iron Man')).toBeTruthy();
    expect(textPart.text.includes('red and gold armor')).toBeTruthy();
    expect(textPart.text.includes('action-pose')).toBeTruthy();
  });

  it('generateImageCaption returns null on API error', async () => {
    await DB.setSetting('captionModel', 'gpt-4o');
    globalThis.fetch = async () => { throw new Error('network down'); };
    const result = await API.generateImageCaption('data:image/png;base64,abc', {});
    expect(result).toBe(null);
  });

  it('generateImageCaption uses character-sheet prompt with higher token limit', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Nova shown from front, side, and back views wearing silver armor.' } }] }), { status: 200 });
    };
    await DB.setSetting('captionModel', 'gpt-4o');
    const result = await API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character', name: 'Nova', role: 'hero', tag: 'character-sheet', appearance: 'silver armor, blue cape' },
    );
    expect(result).toBe('Nova shown from front, side, and back views wearing silver armor.');
    const textPart = requestBody.messages[1].content.find(c => c.type === 'text');
    expect(textPart.text.includes('character sheet')).toBeTruthy();
    expect(textPart.text.includes('multiple')).toBeTruthy();
    expect(textPart.text.includes('Nova')).toBeTruthy();
    expect(textPart.text.includes('silver armor, blue cape')).toBeTruthy();
    // Character sheets get a higher token limit for more detailed captions
    expect(requestBody.max_tokens).toBe(200);
  });

  it('generateImageCaption uses character-in-world prompt with worldName context', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Nova stands amid the neon towers of Neo-Tokyo.' } }] }), { status: 200 });
    };
    await DB.setSetting('captionModel', 'gpt-4o');
    const result = await API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character-in-world', name: 'Nova', tag: 'character-in-world', appearance: 'silver armor', worldName: 'Neo-Tokyo' },
    );
    expect(result).toBe('Nova stands amid the neon towers of Neo-Tokyo.');
    const textPart = requestBody.messages[1].content.find(c => c.type === 'text');
    expect(textPart.text.includes('Nova')).toBeTruthy();
    expect(textPart.text.includes('Neo-Tokyo')).toBeTruthy();
    expect(textPart.text.includes('character-in-world')).toBeTruthy();
  });

  it('generateImageCaption uses character-interaction prompt with characterNames and worldName', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Nova and Blaze face off in the arena.' } }] }), { status: 200 });
    };
    await DB.setSetting('captionModel', 'gpt-4o');
    const result = await API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character-interaction', name: 'Colosseum', tag: 'character-interaction', characterNames: 'Nova, Blaze', worldName: 'Colosseum' },
    );
    expect(result).toBe('Nova and Blaze face off in the arena.');
    const textPart = requestBody.messages[1].content.find(c => c.type === 'text');
    expect(textPart.text.includes('Nova, Blaze')).toBeTruthy();
    expect(textPart.text.includes('Colosseum')).toBeTruthy();
    expect(textPart.text.includes('interacting')).toBeTruthy();
  });
});

describe('generateImage negative prompt', () => {
  beforeEach(async () => {
    await clearAllStores();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'imgdata' }] }), { status: 200 });
    await DB.setSetting('apiKey', 'test-key');
    await DB.setSetting('imageModel', 'flux-2-turbo');
  });

  it('sends negative_prompt in body when negativePrompt option is set', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'img' }] }), { status: 200 });
    };
    await API.generateImage('a hero', { negativePrompt: 'blurry, watermark' });
    expect(requestBody.negative_prompt).toBe('blurry, watermark');
  });

  it('does not include negative_prompt when option is absent', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'img' }] }), { status: 200 });
    };
    await API.generateImage('a hero');
    expect(requestBody.negative_prompt).toBe(undefined);
  });

  it('does not include negative_prompt when option is an empty string', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'img' }] }), { status: 200 });
    };
    await API.generateImage('a hero', { negativePrompt: '   ' });
    expect(requestBody.negative_prompt).toBe(undefined);
  });
});

describe('enrichImagePrompt', () => {
  beforeEach(async () => {
    await clearAllStores();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'enriched' } }] }), { status: 200 });
    await DB.setSetting('apiKey', 'test-key');
    await DB.setSetting('model', 'gpt-4o-mini');
  });

  it('returns null/empty input unchanged without making any API call', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'enriched' } }] }), { status: 200 });
    };
    expect(await API.enrichImagePrompt(null)).toBe(null);
    expect(await API.enrichImagePrompt('')).toBe('');
    expect(await API.enrichImagePrompt(undefined)).toBe(undefined);
    expect(calls.length).toBe(0);
  });

  it('returns rawPrompt unchanged when API key is missing', async () => {
    await DB.setSetting('apiKey', '');
    const result = await API.enrichImagePrompt('A hero in the city');
    expect(result).toBe('A hero in the city');
  });

  it('returns the enriched prompt from the LLM', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Cinematic wide shot — hero stands tall' } }] }), { status: 200 });
    const result = await API.enrichImagePrompt('hero stands in city');
    expect(result).toBe('Cinematic wide shot — hero stands tall');
  });

  it('falls back to rawPrompt on API error', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
    const result = await API.enrichImagePrompt('hero stands in city');
    expect(result).toBe('hero stands in city');
  });

  it('includes genre context in the LLM request when provided', async () => {
    let requestBody;
    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'enriched' } }] }), { status: 200 });
    };
    await API.enrichImagePrompt('dark alley scene', { genre: 'noir' });
    const userMsg = requestBody.messages.find(m => m.role === 'user');
    expect(userMsg.content.includes('noir')).toBeTruthy();
  });

  it('returns rawPrompt when API response has no content', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
    const result = await API.enrichImagePrompt('a dragon flies');
    expect(result).toBe('a dragon flies');
  });
});
