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

  it('fetchImageModels caches and falls back to defaults when empty cache', async () => {
    ctx.fetch = async () => {
      throw new Error('down');
    };
    const fallback = await ctx.API.fetchImageModels(true);
    assert.ok(Array.isArray(fallback));
    assert.ok(fallback.length > 0);
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
