import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClassificationQueue, isAutomaticallyEligible } from '../src/js/references/classification-queue.js';
import { createReferenceRepository } from '../src/js/references/repository.js';
import type {
  ReferenceRepositoryDependencies,
  ReferenceStoreName,
  ReferenceTransaction,
} from '../src/js/references/repository.js';
import type { ClassificationJob, ReferenceAsset } from '../src/js/references/types.js';

function memoryDependencies(): ReferenceRepositoryDependencies {
  const stores = new Map<ReferenceStoreName, Map<string, Record<string, unknown>>>();
  const store = (name: ReferenceStoreName) => {
    let values = stores.get(name);
    if (!values) {
      values = new Map();
      stores.set(name, values);
    }
    return values;
  };
  return {
    async transaction(_names, _mode, operation) {
      const access: ReferenceTransaction = {
        get: async <T>(name: ReferenceStoreName, id: string) => store(name).get(id) as T | undefined,
        getAll: async <T>(name: ReferenceStoreName) => [...store(name).values()] as T[],
        getAllByIndex: async <T>(name: ReferenceStoreName, index: string, value: unknown) =>
          [...store(name).values()].filter((record) => {
            const indexed = record[index];
            return Array.isArray(indexed) ? indexed.includes(value) : indexed === value;
          }) as T[],
        put: async <T extends { id: string }>(name: ReferenceStoreName, value: T) => {
          store(name).set(value.id, structuredClone(value) as Record<string, unknown>);
        },
        delete: async (name: ReferenceStoreName, id: string) => {
          store(name).delete(id);
        },
      };
      return operation(access);
    },
  };
}

function asset(overrides: Partial<ReferenceAsset> = {}): ReferenceAsset {
  return {
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
    ...overrides,
  };
}

const classification = {
  subjectType: 'character' as const,
  use: 'identity' as const,
  characterIds: ['mara'],
  locationId: null,
  facets: { framing: 'medium' as const },
  description: 'Mara facing forward.',
  confidence: { subject: 0.9, links: 0.9, use: 0.9, facets: 0.9 },
};

describe('reference classification queue', () => {
  const now = vi.fn(() => 100);
  let repo: ReturnType<typeof createReferenceRepository>;
  let classifier: { classify: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    now.mockClear();
    repo = createReferenceRepository(memoryDependencies());
    classifier = { classify: vi.fn().mockResolvedValue({ kind: 'classified', classification }) };
    await repo.putAsset(asset());
  });

  it('resumes pending jobs and commits validated metadata atomically', async () => {
    await repo.putJob({
      id: 'classification-r1',
      assetId: 'r1',
      worldId: 'w1',
      status: 'running',
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const queue = createClassificationQueue({ repository: repo, classifier, now });

    await queue.run();

    expect(await repo.getAsset('r1')).toMatchObject({
      classificationState: 'ready',
      subjectType: 'character',
      use: 'identity',
      characterIds: ['mara'],
    });
    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'complete', attemptCount: 1 });
  });

  it('keeps failures reviewable and supports accept as-is', async () => {
    classifier.classify.mockResolvedValueOnce({
      kind: 'failure',
      error: { stage: 'validation', code: 'unmatched-entity-links', validationReason: 'unmatched-entity-links' },
    });
    const queue = createClassificationQueue({ repository: repo, classifier, now });

    await queue.enqueue('r1');
    await queue.run();

    expect((await repo.getAsset('r1'))?.classificationState).toBe('could-not-classify');
    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'failed', attemptCount: 1 });
    await queue.acceptAsIs('r1');
    expect(await repo.getAsset('r1')).toMatchObject({ acceptedAsIs: true, autoUse: true });
  });

  it('pauses between jobs and resumes the remaining durable work', async () => {
    await repo.putAsset(asset({ id: 'r2' }));
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    classifier.classify.mockImplementation(async () => {
      queue.pause();
      return { kind: 'classified', classification };
    });

    await queue.enqueue('r1');
    await queue.enqueue('r2');
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect((await queue.getProgress()).pending).toBe(1);

    await queue.resume();
    expect(classifier.classify).toHaveBeenCalledTimes(2);
    expect((await queue.getProgress()).complete).toBe(2);
  });

  it('retries failures and treats reclassify as explicit approval to replace manual metadata', async () => {
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    classifier.classify.mockResolvedValueOnce({
      kind: 'failure',
      error: { stage: 'inference', code: 'busy' },
    });
    await queue.enqueue('r1');
    await queue.run();
    await queue.retry('r1');
    await queue.run();
    expect((await repo.getJobByAsset('r1'))?.status).toBe('complete');

    await repo.putAsset(
      asset({
        classificationState: 'ready',
        subjectType: 'style',
        use: 'rendering',
        provenance: { source: 'uploaded', metadata: 'manual' },
      }),
    );
    await queue.reclassify('r1');
    expect(await repo.getAsset('r1')).toMatchObject({
      classificationState: 'ready',
      provenance: { metadata: 'local' },
    });
  });

  it('only considers ready or explicitly accepted visible assets eligible', () => {
    expect(isAutomaticallyEligible(asset({ classificationState: 'ready' }))).toBe(true);
    expect(isAutomaticallyEligible(asset({ classificationState: 'needs-review', acceptedAsIs: true }))).toBe(true);
    expect(isAutomaticallyEligible(asset({ classificationState: 'ready', autoUse: false }))).toBe(false);
    expect(isAutomaticallyEligible(asset())).toBe(false);
  });

  it('keeps waiting work pending until its retry time and starts retry work immediately', async () => {
    classifier.classify.mockResolvedValueOnce({
      kind: 'waiting',
      reason: 'quota-busy',
      retryDelayMs: 500,
    });
    const queue = createClassificationQueue({ repository: repo, classifier, now });

    await queue.enqueue('r1');
    await queue.run();

    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'pending', retryAt: 600 });
    expect((await repo.getAsset('r1'))?.classificationState).toBe('pending');
    expect((await queue.getProgress()).complete).toBe(0);

    await queue.retry('r1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it('restores interrupted running jobs and returns the current failed retry-all count', async () => {
    await repo.putJob({
      id: 'classification-r1',
      assetId: 'r1',
      worldId: 'w1',
      status: 'running',
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const queue = createClassificationQueue({ repository: repo, classifier, now });

    await queue.resume();
    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'complete' });
    expect(await queue.retryAllFailed()).toBe(0);
  });

  it('contains a startup recovery failure until IndexedDB is available', async () => {
    const unavailableRepository = {
      ...repo,
      listJobs: vi.fn().mockRejectedValue(new Error('IndexedDB is not available')),
    };

    createClassificationQueue({ repository: unavailableRepository, classifier, now });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unavailableRepository.listJobs).toHaveBeenCalledOnce();
  });
});
