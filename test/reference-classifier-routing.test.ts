import { describe, expect, it, vi } from 'vitest';
import { createClassifierRouter } from '../src/js/references/classifier-router.js';
import { createCloudReferenceClassifier } from '../src/js/references/cloud-classifier.js';
import { buildClassificationPrompt } from '../src/js/references/classifier-prompt.js';
import type { ClassificationInput } from '../src/js/references/classifier-prompt.js';
import type { ClassificationOutcome, ReferenceAsset, WorldLocation } from '../src/js/references/types.js';

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
const yard: WorldLocation = { id: 'yard', worldId: 'w1', name: 'Courtyard', aliases: ['yard'] };
const input: ClassificationInput = { asset, world, characters: [mara], locations: [yard] };

const validJson = JSON.stringify({
  subjectType: 'character',
  use: 'identity',
  characterIds: ['mara'],
  locationId: 'yard',
  facets: { framing: 'medium', viewDirection: 'front' },
  description: 'Mara stands in the courtyard.',
  confidence: { subject: 0.9, links: 0.8, use: 0.9, facets: 0.7 },
});

function classified(): ClassificationOutcome {
  return { kind: 'classified', classification: { characterIds: ['mara'] } as never, state: 'ready' };
}

function stubBackend(overrides: Partial<{ status: string; outcome: ClassificationOutcome }> = {}) {
  return {
    getAvailability: vi.fn().mockResolvedValue({ status: overrides.status ?? 'available' }),
    download: vi.fn(),
    classify: vi.fn().mockResolvedValue(overrides.outcome ?? classified()),
  };
}

describe('cloud reference classifier', () => {
  it('sends the image and the shared stable-ID prompt to the vision model', async () => {
    const classifyImage = vi.fn().mockResolvedValue(validJson);
    const classifier = createCloudReferenceClassifier({ classifyImage, isConfigured: async () => true });

    const result = await classifier.classify(input);

    expect(classifyImage).toHaveBeenCalledWith(asset.dataUrl, buildClassificationPrompt(input));
    expect(classifyImage.mock.calls[0][1]).toContain('"id":"mara"');
    expect(result).toMatchObject({ kind: 'classified', classification: { characterIds: ['mara'] } });
  });

  it('records which backend answered so provenance survives onto the asset', async () => {
    const classifier = createCloudReferenceClassifier({
      classifyImage: async () => validJson,
      isConfigured: async () => true,
    });

    expect(await classifier.classify(input)).toMatchObject({ kind: 'classified', backend: 'cloud' });
  });

  it('reports confidence high enough to reach ready when the model is certain', async () => {
    // The prompt ships a worked example; if its confidence values sit below the 0.75
    // review threshold, models copy them and every classification lands in needs-review.
    const prompt = buildClassificationPrompt(input);
    const example = JSON.parse(prompt.slice(prompt.indexOf('{"subjectType"')).split('\n')[0]);
    for (const [field, value] of Object.entries(example.confidence)) {
      expect(
        Number(value),
        `example confidence.${field} must not sit below the review threshold`,
      ).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('tags its diagnostics as cloud so review can tell the backends apart', async () => {
    const classifier = createCloudReferenceClassifier({
      classifyImage: async () => 'not json at all',
      isConfigured: async () => true,
    });

    const result = await classifier.classify(input);

    expect(result).toMatchObject({ kind: 'failure', error: { stage: 'parse', code: 'invalid-json', mode: 'cloud' } });
  });

  it('waits rather than failing when no API key or vision model is configured', async () => {
    const classifyImage = vi.fn();
    const classifier = createCloudReferenceClassifier({ classifyImage, isConfigured: async () => false });

    expect(await classifier.getAvailability()).toEqual({ status: 'unavailable' });
    expect(await classifier.classify(input)).toMatchObject({ kind: 'waiting', reason: 'model-unavailable' });
    expect(classifyImage).not.toHaveBeenCalled();
  });

  it('treats a rate-limited response as a retryable wait, not a failure', async () => {
    const classifier = createCloudReferenceClassifier({
      classifyImage: async () => {
        throw new Error('429 Too Many Requests');
      },
      isConfigured: async () => true,
    });

    expect(await classifier.classify(input)).toMatchObject({ kind: 'waiting', reason: 'quota-busy' });
  });
});

describe('classifier router', () => {
  it('defaults to the cloud backend and never touches the local model', async () => {
    const cloud = stubBackend();
    const local = stubBackend();
    const router = createClassifierRouter({ cloud, local, getOrder: async () => 'cloud' });

    expect(await router.classify(input)).toMatchObject({ kind: 'classified' });
    expect(cloud.classify).toHaveBeenCalledTimes(1);
    expect(local.classify).not.toHaveBeenCalled();
  });

  it('falls back to the local model when the cloud backend is unavailable', async () => {
    const cloud = stubBackend({ status: 'unavailable' });
    const local = stubBackend();
    const router = createClassifierRouter({ cloud, local, getOrder: async () => 'cloud' });

    expect(await router.classify(input)).toMatchObject({ kind: 'classified' });
    expect(cloud.classify).not.toHaveBeenCalled();
    expect(local.classify).toHaveBeenCalledTimes(1);
  });

  it('tries the cloud model after the local one when the user prefers on-device first', async () => {
    const cloud = stubBackend();
    const local = stubBackend({ status: 'unavailable' });
    const router = createClassifierRouter({ cloud, local, getOrder: async () => 'local-then-cloud' });

    expect(await router.classify(input)).toMatchObject({ kind: 'classified' });
    expect(local.classify).not.toHaveBeenCalled();
    expect(cloud.classify).toHaveBeenCalledTimes(1);
  });

  it('never silently reaches the cloud when the user pinned the local backend', async () => {
    const cloud = stubBackend();
    const local = stubBackend({ status: 'unavailable' });
    const router = createClassifierRouter({ cloud, local, getOrder: async () => 'local' });

    expect(await router.classify(input)).toMatchObject({ kind: 'waiting' });
    expect(cloud.classify).not.toHaveBeenCalled();
  });

  it('reports the longest wait when no backend is available', async () => {
    const cloud = stubBackend({ status: 'unavailable' });
    const local = stubBackend({ status: 'unavailable' });
    const router = createClassifierRouter({ cloud, local, getOrder: async () => 'cloud' });

    expect(await router.classify(input)).toMatchObject({ kind: 'waiting', reason: 'model-unavailable' });
  });

  it('retries on the other backend when the preferred one fails mid-inference', async () => {
    const cloud = stubBackend({
      outcome: { kind: 'failure', error: { stage: 'inference', code: 'inference-failed', mode: 'cloud' } },
    });
    const local = stubBackend();
    const router = createClassifierRouter({ cloud, local, getOrder: async () => 'cloud' });

    expect(await router.classify(input)).toMatchObject({ kind: 'classified' });
    expect(local.classify).toHaveBeenCalledTimes(1);
  });

  it('keeps a schema rejection from the preferred backend instead of laundering it through the other', async () => {
    const rejection: ClassificationOutcome = {
      kind: 'failure',
      error: { stage: 'validation', code: 'invalid-schema', mode: 'cloud' },
    };
    const cloud = stubBackend({ outcome: rejection });
    const local = stubBackend();
    const router = createClassifierRouter({ cloud, local, getOrder: async () => 'cloud' });

    expect(await router.classify(input)).toEqual(rejection);
    expect(local.classify).not.toHaveBeenCalled();
  });
});
