const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { indexedDB } = require('fake-indexeddb');

const dbCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8');
const apiCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');

function loadApiContext(fetchImpl) {
  const ctx = {
    indexedDB,
    crypto: globalThis.crypto || require('node:crypto').webcrypto,
    atob: globalThis.atob,
    Blob: globalThis.Blob,
    TextDecoder: globalThis.TextDecoder,
    Image: class {
      set src(_value) {
        this.width = 256;
        this.height = 256;
        if (this.onload) this.onload();
      }
    },
    document: {
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
    },
    fetch: fetchImpl,
    console,
    Date,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(`${dbCode}\n;this.DB = DB;`, ctx, { filename: 'db.js' });
  vm.runInContext(`${apiCode}\n;this.API = API;`, ctx, { filename: 'api.js' });
  return ctx;
}

function sseResponse(lines) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('API integration', () => {
  let ctx;

  beforeEach(async () => {
    ctx = loadApiContext(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    await ctx.DB.setSetting('apiKey', 'test-key');
    await ctx.DB.setSetting('model', 'gpt-4o-mini');
  });

  it('chatCompletion sends auth/body and returns content', async () => {
    const calls = [];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200 });
    };
    const out = await ctx.API.chatCompletion([{ role: 'user', content: 'Hi' }], { temperature: 0.3 });
    assert.equal(out, 'reply');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(calls[0].opts.body).temperature, 0.3);
  });

  it('chatCompletion throws on missing key or http error', async () => {
    await ctx.DB.setSetting('apiKey', '');
    await assert.rejects(() => ctx.API.chatCompletion([]), /API key not set/);
    await ctx.DB.setSetting('apiKey', 'test-key');
    ctx.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 });
    await assert.rejects(() => ctx.API.chatCompletion([]), /bad/);
  });

  it('chatCompletionStream accumulates chunks and skips non-json frames', async () => {
    const deltas = [];
    ctx.fetch = async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      'data: not-json\n',
      'data: [DONE]\n',
      '\n',
    ]);
    const text = await ctx.API.chatCompletionStream([], (chunk, full) => deltas.push([chunk, full]));
    assert.equal(text, 'Hello');
    assert.deepEqual(deltas, [['Hel', 'Hel'], ['lo', 'Hello']]);
  });

  it('fetchTextModels sorts, caches, force-refreshes and falls back', async () => {
    let mode = 'network';
    let fetchCalls = 0;
    ctx.fetch = async () => {
      fetchCalls++;
      if (mode === 'error') throw new Error('down');
      return new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }] }), { status: 200 });
    };
    const first = await ctx.API.fetchTextModels();
    assert.deepEqual(first.map(m => m.id), ['a', 'z']);
    mode = 'error';
    const cached = await ctx.API.fetchTextModels();
    assert.deepEqual(cached.map(m => m.id), ['a', 'z']);
    const forced = await ctx.API.fetchTextModels(true);
    assert.deepEqual(forced.map(m => m.id), ['a', 'z']);
    assert.equal(fetchCalls, 2);
  });

  it('fetchTextModels maps capabilities.vision and capabilities.tool_calling', async () => {
    ctx.fetch = async () => new Response(JSON.stringify({
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

    const models = await ctx.API.fetchTextModels(true);

    const gpt4o = models.find(m => m.id === 'gpt-4o');
    assert.equal(gpt4o.supports_vision, true, 'should read vision from capabilities.vision');
    assert.equal(gpt4o.supports_tools, true, 'should read tools from capabilities.tool_calling');

    const noCaps = models.find(m => m.id === 'no-caps-model');
    assert.equal(noCaps.supports_vision, false);
    assert.equal(noCaps.supports_tools, false);
  });


  it('fetchImageModels caches and falls back to defaults when empty cache', async () => {
    ctx.fetch = async () => {
      throw new Error('down');
    };
    const fallback = await ctx.API.fetchImageModels(true);
    assert.ok(Array.isArray(fallback));
    assert.ok(fallback.length > 0);
  });

  it('fetchImageModels sends Authorization header and caches sizes from response', async () => {
    const calls = [];
    ctx.fetch = async (url, opts) => {
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

    const models = await ctx.API.fetchImageModels(true);

    // Auth header must be sent
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');

    // Models should be sorted by id and sizes captured from all field variants
    const gpt = models.find(m => m.id === 'gpt-image-1');
    assert.deepEqual(gpt.sizes, ['1024x1024', '1536x1024', '1024x1536', 'auto']);
    const dall3 = models.find(m => m.id === 'dall-e-3');
    assert.deepEqual(dall3.sizes, ['1024x1024', '1024x1792']);
    const flux = models.find(m => m.id === 'flux-pro');
    assert.deepEqual(flux.sizes, ['512x512', '1024x1024']);

    // Sizes should be available via getModelSizes after fetch
    const sizes = await ctx.API.getModelSizes('gpt-image-1');
    assert.deepEqual(sizes, ['1024x1024', '1536x1024', '1024x1536', 'auto']);
  });

  it('fetchImageModels maps capabilities.image_to_image to supports_edit', async () => {
    ctx.fetch = async () => new Response(JSON.stringify({
      data: [
        // Real NanoGPT API shape: edit support under capabilities.image_to_image
        { id: 'flux-kontext', name: 'Flux Kontext', owned_by: 'Black Forest Labs', capabilities: { image_generation: true, image_to_image: true }, supported_parameters: { resolutions: ['1024x1024'] } },
        // Text-to-image only model
        { id: 'nano-banana-pro-ultra', name: 'NBP Ultra', owned_by: 'gemini', capabilities: { image_generation: true, image_to_image: false }, supported_parameters: { resolutions: ['4k', '8k'] } },
      ],
    }), { status: 200 });

    const models = await ctx.API.fetchImageModels(true);

    const editModel = models.find(m => m.id === 'flux-kontext');
    assert.equal(editModel.supports_edit, true, 'should read supports_edit from capabilities.image_to_image');

    const textOnly = models.find(m => m.id === 'nano-banana-pro-ultra');
    assert.equal(textOnly.supports_edit, false);
  });

  it('getModelSizes returns cached sizes when present, null when missing or no sizes', async () => {
    // Seed the IndexedDB cache with one model that has sizes and one without
    await ctx.DB.setSetting('cachedImageModels', [
      { id: 'model-with-sizes', sizes: ['512x512', '1024x1024'] },
      { id: 'model-no-sizes', sizes: null },
      { id: 'model-empty-sizes', sizes: [] },
    ]);

    // Model with sizes should return those sizes
    const withSizes = await ctx.API.getModelSizes('model-with-sizes');
    assert.deepEqual(withSizes, ['512x512', '1024x1024']);

    // Model with null sizes should return null
    const noSizes = await ctx.API.getModelSizes('model-no-sizes');
    assert.equal(noSizes, null);

    // Model with empty sizes array should return null
    const emptySizes = await ctx.API.getModelSizes('model-empty-sizes');
    assert.equal(emptySizes, null);

    // Unknown model (not in cache) should return null
    const unknown = await ctx.API.getModelSizes('unknown-model');
    assert.equal(unknown, null);

    // Null/undefined modelId should return null
    assert.equal(await ctx.API.getModelSizes(null), null);
    assert.equal(await ctx.API.getModelSizes(''), null);
  });

  it('generateImage uses default gpt-image-1 model when none explicitly configured', async () => {
    // No imageModel saved — should use default 'gpt-image-1'
    const calls = [];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: 'default-img' }] }), { status: 200 });
    };
    const result = await ctx.API.generateImage('draw scene');
    assert.equal(result, 'default-img');
    assert.equal(calls[0].body.model, 'gpt-image-1');
  });

  it('generateImage throws with diagnostic properties and makes exactly one request on 500 error', async () => {
    await ctx.DB.setSetting('imageModel', 'unstable-model');
    const calls = [];
    ctx.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return new Response('{"error":{"message":"Internal server error"}}', { status: 500 });
    };

    await assert.rejects(
      () => ctx.API.generateImage('draw scene', { resolution: '1792x1024' }),
      (err) => {
        assert.equal(err.status, 500);
        assert.equal(err.model, 'unstable-model');
        assert.equal(err.resolution, '1792x1024');
        assert.equal(err.prompt, 'draw scene');
        assert.match(err.message, /Image generation failed \[HTTP 500\]/);
        return true;
      }
    );
    assert.equal(calls.length, 1, 'should make exactly one request with no retries or fallbacks');
    assert.deepEqual([calls[0].model, calls[0].size], ['unstable-model', '1792x1024']);
  });

  it('generateImage sends reference images as imageDataUrls in JSON body', async () => {
    await ctx.DB.setSetting('imageModel', 'ref-model');
    const calls = [];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      return new Response(JSON.stringify({ data: [{ b64_json: 'ref-img' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene', {
      imageDataUrls: [
        'data:image/png;base64,aGVsbG8=',
        'data:image/png;base64,aGVsbG8=',
      ],
    });

    assert.equal(result, 'ref-img');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/images/generations'));
    assert.equal(calls[0].body.model, 'ref-model');
    assert.equal(calls[0].body.prompt, 'draw scene');
    assert.equal(calls[0].body.n, 1);
    assert.ok(Array.isArray(calls[0].body.imageDataUrls));
    assert.equal(calls[0].body.imageDataUrls.length, 2);
    assert.equal(calls[0].headers['Authorization'], 'Bearer test-key');
  });

  it('generateImage includes showExplicitContent and n when enabled', async () => {
    await ctx.DB.setSetting('showExplicitContent', true);
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ url: 'https://img.test/explicit.png' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene');
    assert.equal(result, 'https://img.test/explicit.png');
    assert.equal(requestBody.showExplicitContent, true);
    assert.equal(requestBody.n, 1);
    assert.ok(requestBody.size);
  });

  it('generateEmbedding returns null when no API key is set', async () => {
    await ctx.DB.setSetting('apiKey', '');
    const result = await ctx.API.generateEmbedding('test text');
    assert.equal(result, null);
  });

  it('generateEmbedding reads model from settings and sends dimensions for supported models', async () => {
    const calls = [];
    const fakeEmbedding = [0.1, -0.2, 0.3, 0.4];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: fakeEmbedding }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }), { status: 200 });
    };

    // Default model (text-embedding-3-small) supports dimension reduction
    const result = await ctx.API.generateEmbedding('hero with cape');

    assert.deepEqual(result, fakeEmbedding);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/embeddings'));
    assert.equal(calls[0].headers['Authorization'], 'Bearer test-key');
    assert.equal(calls[0].body.input, 'hero with cape');
    assert.equal(calls[0].body.model, 'text-embedding-3-small');
    assert.equal(calls[0].body.encoding_format, 'float');
    assert.equal(calls[0].body.dimensions, 256, 'should include dimensions for supported models');
  });

  it('generateEmbedding reads configured embeddingModel from settings', async () => {
    await ctx.DB.setSetting('embeddingModel', 'qwen/qwen3-embedding-8b');
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: [{ embedding: [0.5, 0.5] }],
      }), { status: 200 });
    };

    await ctx.API.generateEmbedding('test');
    assert.equal(requestBody.model, 'qwen/qwen3-embedding-8b');
    assert.equal(requestBody.dimensions, 256, 'qwen3-embedding-8b supports dimension reduction');
  });

  it('generateEmbedding omits dimensions for models that do not support it', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: [{ embedding: [0.5, 0.5] }],
      }), { status: 200 });
    };

    // BAAI/bge-m3 does NOT support dimension reduction
    await ctx.API.generateEmbedding('test', { model: 'BAAI/bge-m3' });
    assert.equal(requestBody.model, 'BAAI/bge-m3');
    assert.equal(requestBody.dimensions, undefined, 'should NOT send dimensions for unsupported models');
  });

  it('generateEmbedding uses explicit options.model override over settings', async () => {
    await ctx.DB.setSetting('embeddingModel', 'qwen/qwen3-embedding-8b');
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: [{ embedding: [0.5, 0.5] }],
      }), { status: 200 });
    };

    await ctx.API.generateEmbedding('test', { model: 'text-embedding-3-large' });
    assert.equal(requestBody.model, 'text-embedding-3-large');
    assert.equal(requestBody.dimensions, 256, 'text-embedding-3-large supports dimension reduction');
  });

  it('generateEmbedding returns null on HTTP error', async () => {
    ctx.fetch = async () => new Response('{"error":{"message":"bad request"}}', { status: 400 });
    const result = await ctx.API.generateEmbedding('test text');
    assert.equal(result, null);
  });

  it('generateEmbedding returns null on network error', async () => {
    ctx.fetch = async () => { throw new Error('network down'); };
    const result = await ctx.API.generateEmbedding('test text');
    assert.equal(result, null);
  });

  it('generateEmbedding returns null when response has no embedding data', async () => {
    ctx.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const result = await ctx.API.generateEmbedding('test text');
    assert.equal(result, null);
  });

  it('generateImageCaption returns null when no API key is set', async () => {
    await ctx.DB.setSetting('apiKey', '');
    const result = await ctx.API.generateImageCaption('data:image/png;base64,abc', { type: 'character', name: 'Hero' });
    assert.equal(result, null);
  });

  it('generateImageCaption returns null (silently) for non-vision models without calling fetch', async () => {
    // Seed the model cache with a model that explicitly has supports_vision = false
    await ctx.DB.setSetting('cachedTextModels', [
      { id: 'no-vision-model', supports_vision: false, supports_tools: false },
    ]);
    await ctx.DB.setSetting('cachedTextModelsAt', Date.now());
    await ctx.DB.setSetting('captionModel', 'no-vision-model');
    let fetchCalled = false;
    ctx.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
    const result = await ctx.API.generateImageCaption('data:image/png;base64,abc', { type: 'character', name: 'Hero' });
    assert.equal(result, null, 'should return null without calling fetch');
    assert.equal(fetchCalled, false, 'should not call fetch for non-vision model');
  });

  it('generateImageCaption uses captionModel setting when set, falls back to text model', async () => {
    const calls = [];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A hero in red armor.' } }] }), { status: 200 });
    };
    // With explicit captionModel
    await ctx.DB.setSetting('captionModel', 'gpt-4o');
    const r1 = await ctx.API.generateImageCaption('data:image/jpeg;base64,abc', { type: 'character', name: 'Iron Man', role: 'hero', tag: 'action-pose' });
    assert.equal(r1, 'A hero in red armor.');
    assert.equal(calls[0].body.model, 'gpt-4o');
    // Without captionModel, falls back to text model from settings
    await ctx.DB.setSetting('captionModel', '');
    await ctx.API.generateImageCaption('data:image/jpeg;base64,abc', { type: 'character', name: 'Iron Man' });
    assert.equal(calls[1].body.model, 'gpt-4o-mini'); // default from beforeEach
  });

  it('generateImageCaption sends vision message with compressed image and context', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Neon skyline at dusk.' } }] }), { status: 200 });
    };
    await ctx.DB.setSetting('captionModel', 'gpt-4o');
    const result = await ctx.API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'world', name: 'Neo-Tokyo', era: '2099', tag: 'night' },
    );
    assert.equal(result, 'Neon skyline at dusk.');
    // System message is first to frame the comic context
    const sysMsg = requestBody.messages[0];
    assert.equal(sysMsg.role, 'system', 'first message should be a system message');
    assert.ok(sysMsg.content.includes('comic book'), 'system message should mention comic book context');
    // Vision user message is second
    const userMsg = requestBody.messages[1];
    assert.equal(userMsg.role, 'user');
    assert.ok(Array.isArray(userMsg.content), 'content should be an array for vision');
    const imagePart = userMsg.content.find(c => c.type === 'image_url');
    assert.ok(imagePart, 'should include an image_url part');
    // The image URL should be a compressed JPEG (from compressDataUrl)
    assert.ok(imagePart.image_url.url.startsWith('data:image/'), 'image url should be a data URL');
    const textPart = userMsg.content.find(c => c.type === 'text');
    assert.ok(textPart.text.includes('Neo-Tokyo'), 'context should include world name');
    assert.ok(textPart.text.includes('2099'), 'context should include era');
    assert.ok(textPart.text.includes('night'), 'context should include tag');
    // Model params
    assert.equal(requestBody.max_tokens, 120);
    assert.equal(requestBody.temperature, 0.3);
  });

  it('generateImageCaption anchors description to character name when provided', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Iron Man stands in red and gold armor.' } }] }), { status: 200 });
    };
    await ctx.DB.setSetting('captionModel', 'gpt-4o');
    await ctx.API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character', name: 'Iron Man', role: 'hero', tag: 'action-pose', appearance: 'red and gold armor' },
    );
    const userMsg = requestBody.messages[1];
    const textPart = userMsg.content.find(c => c.type === 'text');
    // Prompt must mention character name and request name-anchored description
    assert.ok(textPart.text.includes('Iron Man'), 'prompt should include character name');
    assert.ok(textPart.text.includes('red and gold armor'), 'prompt should include appearance hint');
    assert.ok(textPart.text.includes('action-pose'), 'prompt should include tag');
  });

  it('generateImageCaption returns null on API error', async () => {
    await ctx.DB.setSetting('captionModel', 'gpt-4o');
    ctx.fetch = async () => { throw new Error('network down'); };
    const result = await ctx.API.generateImageCaption('data:image/png;base64,abc', {});
    assert.equal(result, null);
  });

  it('generateImageCaption uses character-sheet prompt with higher token limit', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Nova shown from front, side, and back views wearing silver armor.' } }] }), { status: 200 });
    };
    await ctx.DB.setSetting('captionModel', 'gpt-4o');
    const result = await ctx.API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character', name: 'Nova', role: 'hero', tag: 'character-sheet', appearance: 'silver armor, blue cape' },
    );
    assert.equal(result, 'Nova shown from front, side, and back views wearing silver armor.');
    const textPart = requestBody.messages[1].content.find(c => c.type === 'text');
    assert.ok(textPart.text.includes('character sheet'), 'prompt should mention character sheet');
    assert.ok(textPart.text.includes('multiple'), 'prompt should mention multiple views/angles');
    assert.ok(textPart.text.includes('Nova'), 'prompt should include character name');
    assert.ok(textPart.text.includes('silver armor, blue cape'), 'prompt should include appearance');
    // Character sheets get a higher token limit for more detailed captions
    assert.equal(requestBody.max_tokens, 200, 'character-sheet should get 200 max_tokens');
  });

  it('generateImageCaption uses character-in-world prompt with worldName context', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Nova stands amid the neon towers of Neo-Tokyo.' } }] }), { status: 200 });
    };
    await ctx.DB.setSetting('captionModel', 'gpt-4o');
    const result = await ctx.API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character-in-world', name: 'Nova', tag: 'character-in-world', appearance: 'silver armor', worldName: 'Neo-Tokyo' },
    );
    assert.equal(result, 'Nova stands amid the neon towers of Neo-Tokyo.');
    const textPart = requestBody.messages[1].content.find(c => c.type === 'text');
    assert.ok(textPart.text.includes('Nova'), 'prompt should include character name');
    assert.ok(textPart.text.includes('Neo-Tokyo'), 'prompt should include world name');
    assert.ok(textPart.text.includes('character-in-world'), 'prompt should include tag');
  });

  it('generateImageCaption uses character-interaction prompt with characterNames and worldName', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Nova and Blaze face off in the arena.' } }] }), { status: 200 });
    };
    await ctx.DB.setSetting('captionModel', 'gpt-4o');
    const result = await ctx.API.generateImageCaption(
      'data:image/png;base64,aGVsbG8=',
      { type: 'character-interaction', name: 'Colosseum', tag: 'character-interaction', characterNames: 'Nova, Blaze', worldName: 'Colosseum' },
    );
    assert.equal(result, 'Nova and Blaze face off in the arena.');
    const textPart = requestBody.messages[1].content.find(c => c.type === 'text');
    assert.ok(textPart.text.includes('Nova, Blaze'), 'prompt should include character names');
    assert.ok(textPart.text.includes('Colosseum'), 'prompt should include world name');
    assert.ok(textPart.text.includes('interacting'), 'prompt should mention interaction');
  });
});

describe('generateImage negative prompt', () => {
  let ctx;

  beforeEach(async () => {
    ctx = loadApiContext(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'imgdata' }] }), { status: 200 }),
    );
    await ctx.DB.setSetting('apiKey', 'test-key');
    await ctx.DB.setSetting('imageModel', 'flux-2-turbo');
  });

  it('sends negative_prompt in body when negativePrompt option is set', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'img' }] }), { status: 200 });
    };
    await ctx.API.generateImage('a hero', { negativePrompt: 'blurry, watermark' });
    assert.equal(requestBody.negative_prompt, 'blurry, watermark');
  });

  it('does not include negative_prompt when option is absent', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'img' }] }), { status: 200 });
    };
    await ctx.API.generateImage('a hero');
    assert.equal(requestBody.negative_prompt, undefined);
  });

  it('does not include negative_prompt when option is an empty string', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'img' }] }), { status: 200 });
    };
    await ctx.API.generateImage('a hero', { negativePrompt: '   ' });
    assert.equal(requestBody.negative_prompt, undefined);
  });
});

describe('enrichImagePrompt', () => {
  let ctx;

  beforeEach(async () => {
    ctx = loadApiContext(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'enriched' } }] }), { status: 200 }),
    );
    await ctx.DB.setSetting('apiKey', 'test-key');
    await ctx.DB.setSetting('model', 'gpt-4o-mini');
  });

  it('returns null/empty input unchanged without making any API call', async () => {
    const calls = [];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'enriched' } }] }), { status: 200 });
    };
    assert.equal(await ctx.API.enrichImagePrompt(null), null);
    assert.equal(await ctx.API.enrichImagePrompt(''), '');
    assert.equal(await ctx.API.enrichImagePrompt(undefined), undefined);
    assert.equal(calls.length, 0, 'no fetch call should be made for falsy input');
  });

  it('returns rawPrompt unchanged when API key is missing', async () => {
    await ctx.DB.setSetting('apiKey', '');
    const result = await ctx.API.enrichImagePrompt('A hero in the city');
    assert.equal(result, 'A hero in the city');
  });

  it('returns the enriched prompt from the LLM', async () => {
    ctx.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Cinematic wide shot — hero stands tall' } }] }), { status: 200 });
    const result = await ctx.API.enrichImagePrompt('hero stands in city');
    assert.equal(result, 'Cinematic wide shot — hero stands tall');
  });

  it('falls back to rawPrompt on API error', async () => {
    ctx.fetch = async () => new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
    const result = await ctx.API.enrichImagePrompt('hero stands in city');
    assert.equal(result, 'hero stands in city');
  });

  it('includes genre context in the LLM request when provided', async () => {
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'enriched' } }] }), { status: 200 });
    };
    await ctx.API.enrichImagePrompt('dark alley scene', { genre: 'noir' });
    const userMsg = requestBody.messages.find(m => m.role === 'user');
    assert.ok(userMsg.content.includes('noir'), 'genre should appear in the user message');
  });

  it('returns rawPrompt when API response has no content', async () => {
    ctx.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
    const result = await ctx.API.enrichImagePrompt('a dragon flies');
    assert.equal(result, 'a dragon flies');
  });
});
