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
    FormData: globalThis.FormData,
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

  it('generateImage retries with safe size on 400 errors', async () => {
    await ctx.DB.setSetting('imageModel', 'unstable-model');
    const calls = [];
    ctx.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (calls.length === 1) return new Response('{"error":{"message":"Bad request"}}', { status: 400 });
      return new Response(JSON.stringify({ data: [{ url: 'https://img.test/success.png' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene', { size: '1792x1024' });
    assert.equal(result, 'https://img.test/success.png');
    assert.deepEqual(calls.map(c => [c.model, c.size]), [
      ['unstable-model', '1792x1024'],
      ['unstable-model', '1024x1024'],
    ]);
  });

  it('generateImage falls back to gpt-image-1 after repeated 400 errors', async () => {
    await ctx.DB.setSetting('imageModel', 'unstable-model');
    const calls = [];
    ctx.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (calls.length < 3) return new Response('{"error":{"message":"Bad request"}}', { status: 400 });
      return new Response(JSON.stringify({ data: [{ b64_json: 'abcd' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene', { size: '1792x1024' });
    assert.equal(result, 'abcd');
    assert.deepEqual(calls.map(c => [c.model, c.size]), [
      ['unstable-model', '1792x1024'],
      ['unstable-model', '1024x1024'],
      ['gpt-image-1', '1024x1024'],
    ]);
  });

  it('generateImage retries with safe size on 500 errors', async () => {
    await ctx.DB.setSetting('imageModel', 'unstable-model');
    const calls = [];
    ctx.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (calls.length === 1) return new Response('{"error":{"message":"Internal server error"}}', { status: 500 });
      return new Response(JSON.stringify({ data: [{ url: 'https://img.test/success.png' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene', { size: '1792x1024' });
    assert.equal(result, 'https://img.test/success.png');
    assert.deepEqual(calls.map(c => [c.model, c.size]), [
      ['unstable-model', '1792x1024'],
      ['unstable-model', '1024x1024'],
    ]);
  });

  it('generateImage falls back to gpt-image-1 after repeated 500 errors', async () => {
    await ctx.DB.setSetting('imageModel', 'unstable-model');
    const calls = [];
    ctx.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (calls.length < 3) return new Response('{"error":{"message":"Internal server error"}}', { status: 500 });
      return new Response(JSON.stringify({ data: [{ b64_json: 'abcd' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene', { size: '1792x1024' });
    assert.equal(result, 'abcd');
    assert.deepEqual(calls.map(c => [c.model, c.size]), [
      ['unstable-model', '1792x1024'],
      ['unstable-model', '1024x1024'],
      ['gpt-image-1', '1024x1024'],
    ]);
  });

  it('generateImage sends reference images to /images/edits as multipart image fields', async () => {
    await ctx.DB.setSetting('imageModel', 'edit-model');
    const calls = [];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ data: [{ b64_json: 'edited-img' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene', {
      imageDataUrls: [
        'data:image/png;base64,aGVsbG8=',
        'data:image/png;base64,aGVsbG8=',
      ],
    });

    assert.equal(result, 'edited-img');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/images/edits'));
    const body = calls[0].opts.body;
    assert.equal(body.get('model'), 'edit-model');
    assert.equal(body.get('prompt'), 'draw scene');
    assert.equal(body.getAll('image').length, 2);
  });

  it('generateImage falls back to /images/generations when /images/edits fails', async () => {
    await ctx.DB.setSetting('imageModel', 'mixed-model');
    const calls = [];
    ctx.fetch = async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith('/images/edits')) {
        return new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: [{ url: 'https://img.test/fallback.png' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene', {
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    });

    assert.equal(result, 'https://img.test/fallback.png');
    assert.ok(calls[0].url.endsWith('/images/edits'));
    assert.ok(calls[1].url.endsWith('/images/generations'));
  });

  it('generateImage includes showExplicitContent when enabled in settings', async () => {
    await ctx.DB.setSetting('showExplicitContent', true);
    let requestBody;
    ctx.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ data: [{ url: 'https://img.test/explicit.png' }] }), { status: 200 });
    };

    const result = await ctx.API.generateImage('draw scene');
    assert.equal(result, 'https://img.test/explicit.png');
    assert.equal(requestBody.showExplicitContent, true);
  });
});
