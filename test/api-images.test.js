import { describe, it, beforeEach, expect } from 'vitest';
import 'fake-indexeddb/auto';

// Mock browser APIs needed by api.js (Image, canvas)
globalThis.Image =
  globalThis.Image ||
  class {
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

globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

const { default: DB } = await import('../src/js/db.js');
const { default: API } = await import('../src/js/api.js');

async function clearAllStores() {
  API._resetCacheForTesting();
  const db = await DB.open();
  await Promise.all(
    Object.values(DB.STORES).map((storeName) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }),
  );
}

/** Install a fetch mock that answers image-model metadata and generation calls. */
function mockImageApi({ models = [], generation }) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/image-models')) {
      return new Response(JSON.stringify({ data: models }), { status: 200 });
    }
    if (String(url).includes('/images/generations')) {
      calls.push(JSON.parse(opts.body));
      const body = typeof generation === 'function' ? generation(calls[calls.length - 1]) : generation;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  return calls;
}

const SEQ_MODEL = {
  id: 'seedream-v4.5-sequential',
  name: 'Seedream Sequential',
  max_input_images: 10,
  max_output_images: 15,
  supported_parameters: { resolutions: ['1024x1024', '1920x1920'] },
};

describe('image model capability normalization', () => {
  beforeEach(async () => {
    await clearAllStores();
    await DB.setSetting('apiKey', 'test-key');
  });

  it('normalizes maxInputImages/maxOutputImages/sizes from field variants', async () => {
    mockImageApi({ models: [SEQ_MODEL] });
    const models = await API.fetchImageModels(true);
    const m = models.find((x) => x.id === 'seedream-v4.5-sequential');
    expect(m.maxInputImages).toBe(10);
    expect(m.maxOutputImages).toBe(15);
    expect(m.sizes).toEqual(['1024x1024', '1920x1920']);
  });

  it('getImageModelMeta returns null for unknown models', async () => {
    mockImageApi({ models: [SEQ_MODEL] });
    await API.fetchImageModels(true);
    expect(await API.getImageModelMeta('no-such-model')).toBeNull();
    expect((await API.getImageModelMeta('seedream-v4.5-sequential')).maxOutputImages).toBe(15);
  });

  it('refreshes an old cache schema and stores normalized capability metadata', async () => {
    await DB.setSetting('cachedImageModels', [{ id: 'seedream-v4.5-sequential', name: 'old' }]);
    await DB.setSetting('cachedImageModelsAt', Date.now());
    await DB.setSetting('cachedImageModelsSchemaVersion', 1);
    mockImageApi({ models: [SEQ_MODEL] });
    const models = await API.fetchImageModels();
    expect(models[0]).toMatchObject({ maxInputImages: 10, maxOutputImages: 15 });
    expect(await DB.getSetting('cachedImageModelsSchemaVersion', 0)).toBe(2);
  });

  it('reports degraded cache while schema migration is in fetch backoff', async () => {
    const cachedModels = [{ id: 'seedream-v4.5-sequential', name: 'old schema model' }];
    await DB.setSetting('cachedImageModels', cachedModels);
    await DB.setSetting('cachedImageModelsAt', Date.now());
    await DB.setSetting('cachedImageModelsSchemaVersion', 1);
    await DB.setSetting('cachedImageModelsMigrationRetryAt', Date.now() + 60_000);

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ data: [SEQ_MODEL] }), { status: 200 });
    };

    const models = await API.fetchImageModels();

    expect(fetchCalled).toBe(false);
    expect(models).toEqual([expect.objectContaining({ id: 'seedream-v4.5-sequential', name: 'old schema model' })]);
    expect(API.getImageModelSource()).toBe('cache-degraded');
  });
});

describe('generateImages', () => {
  beforeEach(async () => {
    await clearAllStores();
    await DB.setSetting('apiKey', 'test-key');
    await DB.setSetting('imageModel', 'seedream-v4.5-sequential');
  });

  it('sends n and returns every data[] entry mapped by index', async () => {
    const calls = mockImageApi({
      models: [SEQ_MODEL],
      generation: {
        data: [{ url: 'https://x/1.png' }, { b64_json: 'BBBB' }, { url: 'https://x/3.png' }, { b64_json: 'DDDD' }],
      },
    });
    const results = await API.generateImages('IMAGE 1 ... IMAGE 4', {
      count: 4,
      resolution: '1920x1920',
      exactReferences: true,
      imageDataUrls: ['data:image/png;base64,R1', 'data:image/png;base64,R2'],
    });
    expect(calls[0].n).toBe(4);
    expect(calls[0].model).toBe('seedream-v4.5-sequential');
    expect(calls[0].imageDataUrls.length).toBe(2);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(results[0]).toEqual({ index: 0, value: 'https://x/1.png', source: 'url' });
    expect(results[1].source).toBe('b64_json');
  });

  it('keeps index mapping on short responses without shifting', async () => {
    mockImageApi({
      models: [SEQ_MODEL],
      generation: { data: [{ url: 'https://x/1.png' }, { url: 'https://x/2.png' }] },
    });
    const results = await API.generateImages('p', { count: 4, resolution: '1024x1024', exactReferences: true });
    expect(results.length).toBe(2);
    expect(results.map((r) => r.index)).toEqual([0, 1]);
  });

  it('drops extra entries beyond the requested count', async () => {
    mockImageApi({
      models: [SEQ_MODEL],
      generation: { data: [{ url: 'https://x/1.png' }, { url: 'https://x/2.png' }, { url: 'https://x/3.png' }] },
    });
    const results = await API.generateImages('p', { count: 2, resolution: '1024x1024', exactReferences: true });
    expect(results.length).toBe(2);
  });

  it('rejects requests that exceed the live output limit in exact mode', async () => {
    mockImageApi({ models: [SEQ_MODEL], generation: { data: [{ url: 'u' }] } });
    await expect(
      API.generateImages('p', { count: 99, resolution: '1024x1024', exactReferences: true }),
    ).rejects.toThrow(/at most 15/);
  });

  it('rejects reference overflow in exact mode instead of truncating', async () => {
    mockImageApi({ models: [SEQ_MODEL], generation: { data: [{ url: 'u' }] } });
    const refs = Array.from({ length: 11 }, (_, i) => `data:image/png;base64,R${i}`);
    await expect(
      API.generateImages('p', { count: 1, resolution: '1024x1024', exactReferences: true, imageDataUrls: refs }),
    ).rejects.toThrow(/input-image limit/);
  });

  it('rejects unsupported sizes for multi-output exact requests', async () => {
    mockImageApi({ models: [SEQ_MODEL], generation: { data: [{ url: 'u' }] } });
    await expect(API.generateImages('p', { count: 3, resolution: '640x480', exactReferences: true })).rejects.toThrow(
      /supported resolution list/,
    );
  });

  it('legacy path still truncates references at the configured cap', async () => {
    await DB.setSetting('maxRefImages', 2);
    const calls = mockImageApi({ models: [SEQ_MODEL], generation: { data: [{ url: 'u' }] } });
    await API.generateImages('p', {
      count: 1,
      imageDataUrls: ['data:a', 'data:b', 'data:c'],
    });
    expect(calls[0].imageDataUrls.length).toBe(2);
  });

  it('generateImage wrapper returns the first value (single-image compatibility)', async () => {
    mockImageApi({ models: [SEQ_MODEL], generation: { data: [{ b64_json: 'SINGLE' }] } });
    const value = await API.generateImage('portrait');
    expect(value).toBe('SINGLE');
  });

  it('throws with model/size context on API errors', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/image-models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400 });
    };
    await expect(API.generateImages('p', { count: 1 })).rejects.toThrow(/boom/);
  });

  it('bounds a provider request and classifies the timeout', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/images/generations')) return new Promise(() => {});
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await expect(API.generateImages('p', { count: 1, timeoutMs: 5 })).rejects.toMatchObject({
      name: 'GenerationTimeoutError',
      code: 'GENERATION_TIMEOUT',
      phase: 'image-request',
      retryable: true,
    });
  });
});

describe('structured planner', () => {
  it('buildPlannerSystemPrompt embeds the ID manifest and location keys', () => {
    const prompt = API.buildPlannerSystemPrompt({
      genreName: 'Neon Noir',
      characters: [{ id: 'char-1', name: 'Mara', role: 'hero', description: 'A mechanic' }],
      world: { name: 'Rustfield', description: 'A dying factory town' },
      locationKeys: ['machine-shop', 'main-street'],
    });
    expect(prompt).toContain('id: "char-1"');
    expect(prompt).toContain('"machine-shop"');
    expect(prompt).toContain('visualStateChanges');
    expect(prompt).toContain("Do NOT describe any character's physical appearance");
  });

  it('parsePlannedPageResponse normalizes a valid planned page', () => {
    const parsed = API.parsePlannedPageResponse(
      JSON.stringify({
        title: 'The Shop',
        panels: [
          {
            narration: 'Morning.',
            dialogue: [{ speaker: 'Mara', text: 'Hand me the wrench.' }],
            visual: {
              locationKey: 'machine-shop',
              shot: 'wide',
              characters: [{ characterId: 'char-1', action: 'working', pose: 'bent over', expression: 'focused' }],
              keyProps: ['wrench'],
            },
            visualStateChanges: [
              {
                characterId: 'char-1',
                timing: 'after-panel',
                reason: 'grease',
                set: { temporaryChanges: ['grease-smudged hands'] },
              },
            ],
          },
        ],
        choices: [{ text: 'a', summary: 'b' }],
      }),
    );
    expect(parsed.title).toBe('The Shop');
    expect(parsed.panels[0].visual.characters[0].characterId).toBe('char-1');
    expect(parsed.panels[0].visualStateChanges[0].set.temporaryChanges).toEqual(['grease-smudged hands']);
    expect(parsed.panels[0].visualStateChanges[0].timing).toBe('after-panel');
  });

  it('parsePlannedPageResponse handles fences and repairs truncation', () => {
    const good = API.parsePlannedPageResponse('```json\n{"title":"T","panels":[],"choices":[]}\n```');
    expect(good).not.toBeNull();
    const truncated = API.parsePlannedPageResponse('{"title":"T","panels":[{"narration":"hi","visual":{"shot":"wide"');
    expect(truncated === null || Array.isArray(truncated.panels)).toBe(true);
  });

  it('parsePlannedPageResponse returns null for garbage', () => {
    expect(API.parsePlannedPageResponse('not json at all')).toBeNull();
  });

  it('parsePlannedPageResponse repairs internal trailing commas', () => {
    const withTrailingCommas = `{
"title": "T",
"panels": [
  {
    "narration": "hi",
    "dialogue": [ { "speaker": "A", "text": "yo, and {braces, commas} in strings," }, ],
    "visual": { "shot": "wide", },
  },
],
"choices": [ { "text": "c", "summary": "s" }, ]
}`;
    const parsed = API.parsePlannedPageResponse(withTrailingCommas);
    expect(parsed).not.toBeNull();
    expect(parsed.title).toBe('T');
    expect(parsed.panels[0].narration).toBe('hi');
    expect(parsed.panels[0].dialogue[0].text).toBe('yo, and {braces, commas} in strings,');
    expect(parsed.panels[0].visual.shot).toBe('wide');
    expect(parsed.choices[0].text).toBe('c');
  });

  it('parsePlannedPageResponse tolerates non-array dialogue/characters/choices', () => {
    const parsed = API.parsePlannedPageResponse(
      JSON.stringify({
        title: 'T',
        panels: [
          {
            narration: 'x',
            dialogue: { speaker: 'Mara', text: 'not an array' },
            visual: { characters: 'Mara and Ellis', keyProps: 'wrench' },
            visualStateChanges: 'none',
          },
        ],
        choices: { text: 'single object', summary: 's' },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed.panels[0].dialogue).toEqual([]);
    expect(parsed.panels[0].visual.characters).toEqual([]);
    expect(parsed.panels[0].visual.keyProps).toEqual([]);
    expect(parsed.panels[0].visualStateChanges).toEqual([]);
    expect(parsed.choices).toEqual([]);
  });
});
