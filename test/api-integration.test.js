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

  it('generateImage throws when no image model is configured', async () => {
    // Ensure no imageModel is saved (empty string = not configured)
    await ctx.DB.setSetting('imageModel', '');
    await assert.rejects(
      () => ctx.API.generateImage('draw scene'),
      /No image model configured/
    );
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
});
