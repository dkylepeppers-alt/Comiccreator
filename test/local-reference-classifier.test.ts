import { describe, expect, it, vi } from 'vitest';
import { createLocalReferenceClassifier } from '../src/js/references/local-classifier.js';
import type { ReferenceAsset, WorldLocation } from '../src/js/references/types.js';

const asset: ReferenceAsset = {
  id: 'r1',
  worldId: 'w1',
  dataUrl: 'data:image/png;base64,abc',
  subjectType: null,
  use: null,
  characterIds: [],
  locationId: null,
  facets: {},
  description: '',
  confidence: {},
  provenance: { source: 'uploaded', metadata: 'local' },
  classificationState: 'pending',
  acceptedAsIs: false,
  autoUse: true,
  createdAt: 1,
  updatedAt: 1,
};
const world = { id: 'w1', name: 'Castle', description: 'A hilltop fortress.' };
const mara = { id: 'mara', name: 'Mara', appearance: 'Short black hair and a red coat.' };
const yard: WorldLocation = {
  id: 'yard',
  worldId: 'w1',
  name: 'Courtyard',
  aliases: ['yard'],
};
const validJson = JSON.stringify({
  subjectType: 'character',
  use: 'identity',
  characterIds: ['mara'],
  locationId: 'yard',
  facets: { framing: 'medium', viewDirection: 'front' },
  description: 'Mara stands in the courtyard.',
  confidence: { subject: 0.9, links: 0.8, use: 0.9, facets: 0.7 },
});

describe('local reference classifier', () => {
  it('sends image bytes and the stable-ID roster to the native model', async () => {
    const plugin = {
      classify: vi.fn().mockResolvedValue({ text: validJson }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    };
    const classifier = createLocalReferenceClassifier(plugin);

    const result = await classifier.classify({
      asset,
      world,
      characters: [mara],
      locations: [yard],
    });

    expect(plugin.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        dataUrl: asset.dataUrl,
        prompt: expect.stringContaining('"id":"mara"'),
      }),
    );
    expect(plugin.classify.mock.calls[0][0].prompt).toContain('"id":"yard"');
    expect(result).toMatchObject({ kind: 'classified', classification: { characterIds: ['mara'] } });
  });

  it('returns typed waiting and failure outcomes rather than null', async () => {
    const unavailablePlugin = {
      classify: vi.fn(),
      getAvailability: vi.fn().mockResolvedValue({ status: 'unavailable' as const }),
      download: vi.fn(),
    };
    const unavailableClassifier = createLocalReferenceClassifier(unavailablePlugin);
    expect(await unavailableClassifier.classify({ asset, world, characters: [], locations: [] })).toMatchObject({
      kind: 'waiting',
      reason: 'model-unavailable',
    });
    expect(unavailablePlugin.classify).not.toHaveBeenCalled();

    const invalidClassifier = createLocalReferenceClassifier({
      ...unavailablePlugin,
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      classify: vi.fn().mockResolvedValue({ text: 'not json' }),
    });
    expect(await invalidClassifier.classify({ asset, world, characters: [], locations: [] })).toMatchObject({
      kind: 'failure',
      error: { stage: 'parse', code: 'invalid-json' },
    });
  });

  it('retains only a bounded safe raw-output excerpt for parse failures', async () => {
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn().mockResolvedValue({ text: 'not valid json' }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });
    const echoedPromptClassifier = createLocalReferenceClassifier({
      classify: vi.fn().mockResolvedValue({ text: 'Roster: Castle world description: hidden' }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });
    const multibyteClassifier = createLocalReferenceClassifier({
      classify: vi.fn().mockResolvedValue({ text: '😀'.repeat(5_000) }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });

    await expect(classifier.classify({ asset, world, characters: [], locations: [] })).resolves.toMatchObject({
      kind: 'failure',
      error: { rawOutputExcerpt: 'not valid json' },
    });
    const echoed = await echoedPromptClassifier.classify({ asset, world, characters: [], locations: [] });
    expect(echoed).toMatchObject({ kind: 'failure' });
    expect((echoed as any).error).not.toHaveProperty('rawOutputExcerpt');
    const multibyte = await multibyteClassifier.classify({ asset, world, characters: [], locations: [] });
    expect(new TextEncoder().encode((multibyte as any).error.rawOutputExcerpt).byteLength).toBe(16 * 1024);
  });

  it('uses generic diagnostic details when the native plugin throws sensitive text', async () => {
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn().mockRejectedValue(new Error('prompt=private roster=secret world description=hidden')),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });

    const result = await classifier.classify({ asset, world, characters: [], locations: [] });
    expect(result).toMatchObject({ kind: 'failure', error: { stage: 'inference', code: 'inference-failed' } });
    expect((result as any).error).not.toHaveProperty('message');
  });

  it('uses typed native retry details for busy and background conditions', async () => {
    const busy = Object.assign(new Error('native details must not be parsed'), {
      code: 'busy',
      data: { nativeCode: 9, retryDelayMs: 45_000, mode: 'structured' },
    });
    const background = Object.assign(new Error('native details must not be parsed'), {
      code: 'background-use-blocked',
      data: { nativeCode: 30, retryDelayMs: 20_000, mode: 'text' },
    });
    const plugin = {
      classify: vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(background),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    };
    const classifier = createLocalReferenceClassifier(plugin);

    await expect(classifier.classify({ asset, world, characters: [], locations: [] })).resolves.toEqual({
      kind: 'waiting',
      reason: 'quota-busy',
      retryDelayMs: 45_000,
    });
    await expect(classifier.classify({ asset, world, characters: [], locations: [] })).resolves.toEqual({
      kind: 'waiting',
      reason: 'app-background',
      retryDelayMs: 20_000,
    });
  });

  it('retains safe native mode and error-code data without retaining native messages', async () => {
    const nativeFailure = Object.assign(new Error('private prompt and roster'), {
      code: 'request-too-large',
      data: { nativeCode: 12, mode: 'structured' },
    });
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn().mockRejectedValue(nativeFailure),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });

    const result = await classifier.classify({ asset, world, characters: [], locations: [] });
    expect(result).toMatchObject({
      kind: 'failure',
      error: { stage: 'inference', code: 'inference-failed', nativeCode: 12, nativeMode: 'structured' },
    });
    expect((result as any).error).not.toHaveProperty('message');
  });

  it('accepts the native structured-output mode with validated JSON', async () => {
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn().mockResolvedValue({ text: validJson, mode: 'structured' as const }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });

    await expect(classifier.classify({ asset, world, characters: [mara], locations: [yard] })).resolves.toMatchObject({
      kind: 'classified',
      classification: { subjectType: 'character' },
    });
  });

  it('keeps a multimodal result reviewable when the model chooses an incompatible use or no roster link', async () => {
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          subjectType: 'character',
          use: 'establishing',
          characterIds: [],
          locationId: null,
          facets: { framing: 'medium' },
          description: 'A person is visible in the uploaded image.',
          confidence: { subject: 0.9, links: 0.2, use: 0.8, facets: 0.8 },
        }),
        mode: 'structured' as const,
      }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });

    await expect(classifier.classify({ asset, world, characters: [mara], locations: [yard] })).resolves.toMatchObject({
      kind: 'classified',
      state: 'needs-review',
      validationReason: 'subject-requirements',
    });
  });

  it('extracts a fenced JSON object surrounded by model prose', async () => {
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn().mockResolvedValue({ text: `Here is the result:\n\`\`\`json\n${validJson}\n\`\`\`` }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });

    await expect(classifier.classify({ asset, world, characters: [mara], locations: [yard] })).resolves.toMatchObject({
      kind: 'classified',
      classification: { subjectType: 'character' },
    });
  });

  it('reports an undecodable native response as a decode failure', async () => {
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn().mockResolvedValue({ text: 42 }),
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      download: vi.fn(),
    });

    await expect(classifier.classify({ asset, world, characters: [mara], locations: [yard] })).resolves.toMatchObject({
      kind: 'failure',
      error: { stage: 'decode', code: 'decode-failed' },
    });
  });

  it('exposes availability and download without a remote fallback', async () => {
    const plugin = {
      classify: vi.fn(),
      getAvailability: vi.fn().mockResolvedValue({ status: 'downloadable' as const }),
      download: vi.fn().mockResolvedValue(undefined),
    };
    const classifier = createLocalReferenceClassifier(plugin);

    await expect(classifier.getAvailability()).resolves.toEqual({ status: 'downloadable' });
    await classifier.download();
    expect(plugin.download).toHaveBeenCalledOnce();
  });

  it('reports unavailable when the native plugin is not implemented', async () => {
    const classifier = createLocalReferenceClassifier({
      classify: vi.fn(),
      getAvailability: vi.fn().mockRejectedValue(new Error('plugin is not implemented on web')),
      download: vi.fn(),
    });

    await expect(classifier.getAvailability()).resolves.toEqual({ status: 'unavailable' });
  });
});
