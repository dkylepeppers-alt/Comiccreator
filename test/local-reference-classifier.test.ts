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
    expect(result?.characterIds).toEqual(['mara']);
  });

  it('returns null for unsupported devices or invalid JSON', async () => {
    const unavailablePlugin = {
      classify: vi.fn(),
      getAvailability: vi.fn().mockResolvedValue({ status: 'unavailable' as const }),
      download: vi.fn(),
    };
    const unavailableClassifier = createLocalReferenceClassifier(unavailablePlugin);
    expect(await unavailableClassifier.classify({ asset, world, characters: [], locations: [] })).toBeNull();
    expect(unavailablePlugin.classify).not.toHaveBeenCalled();

    const invalidClassifier = createLocalReferenceClassifier({
      ...unavailablePlugin,
      getAvailability: vi.fn().mockResolvedValue({ status: 'available' as const }),
      classify: vi.fn().mockResolvedValue({ text: 'not json' }),
    });
    expect(await invalidClassifier.classify({ asset, world, characters: [], locations: [] })).toBeNull();
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
