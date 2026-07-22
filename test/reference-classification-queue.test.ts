import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClassificationQueue, isAutomaticallyEligible } from '../src/js/references/classification-queue.js';
import { createReferenceRepository } from '../src/js/references/repository.js';
import { createReferenceWorkspace } from '../src/js/reference-workspace.js';
import type {
  ReferenceRepositoryDependencies,
  ReferenceStoreName,
  ReferenceTransaction,
} from '../src/js/references/repository.js';
import type { ClassificationJob, ReferenceAsset } from '../src/js/references/types.js';

function timerHarness() {
  let nextId = 0;
  const callbacks = new Map<number, () => void | Promise<void>>();
  return {
    setTimeout: vi.fn((callback: () => void | Promise<void>) => {
      nextId += 1;
      callbacks.set(nextId, callback);
      return nextId;
    }),
    clearTimeout: vi.fn((id: number) => callbacks.delete(id)),
    async fireNext() {
      const [id, callback] = callbacks.entries().next().value || [];
      if (id === undefined || !callback) throw new Error('No timer scheduled');
      callbacks.delete(id);
      await callback();
    },
  };
}

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

  it('rejects retry for manual or accepted metadata so only explicit reclassify can replace it', async () => {
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    await repo.putAsset(asset({ provenance: { source: 'uploaded', metadata: 'manual' } }));
    await expect(queue.retry('r1')).rejects.toThrow('Reclassify');

    await repo.putAsset(asset({ provenance: { source: 'uploaded', metadata: 'accepted' }, acceptedAsIs: true }));
    await expect(queue.retry('r1')).rejects.toThrow('Reclassify');
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

  it('wakes queued waiting work when its retry timer expires', async () => {
    const timer = timerHarness();
    classifier.classify
      .mockResolvedValueOnce({ kind: 'waiting', reason: 'quota-busy', retryDelayMs: 500 })
      .mockResolvedValueOnce({ kind: 'classified', classification });
    const queue = createClassificationQueue({ repository: repo, classifier, now, timer } as any);

    await queue.enqueue('r1');
    expect(timer.setTimeout).toHaveBeenCalledWith(expect.any(Function), 500);

    now.mockReturnValue(600);
    await timer.fireNext();
    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'complete', attemptCount: 2 });
  });

  it('immediately resumes model-download work when the download completes', async () => {
    classifier.classify
      .mockResolvedValueOnce({ kind: 'waiting', reason: 'model-downloading', retryDelayMs: 30_000 })
      .mockResolvedValueOnce({ kind: 'classified', classification });
    const queue = createClassificationQueue({ repository: repo, classifier, now });

    await queue.enqueue('r1');
    await queue.resumeAfterLocalModelDownload();

    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'complete', attemptCount: 2 });
  });

  it('does not unpause when enqueue or run is called after pause', async () => {
    await repo.putAsset(asset({ id: 'r2' }));
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    queue.pause();

    await queue.enqueue('r1');
    await queue.run();
    await queue.enqueue('r2');

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(await queue.getProgress()).toMatchObject({ paused: true, pending: 2 });
    await queue.resume();
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it('persists a safe parse excerpt through the diagnostic repository', async () => {
    now.mockReturnValue(Date.now());
    classifier.classify.mockResolvedValueOnce({
      kind: 'failure',
      error: { stage: 'parse', code: 'invalid-json', rawOutputExcerpt: 'unexpected trailing comma' },
    });
    const queue = createClassificationQueue({ repository: repo, classifier, now });

    await queue.enqueue('r1');
    await queue.run();

    expect(await repo.listDiagnostics('r1')).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ rawOutputExcerpt: 'unexpected trailing comma' }) }),
    ]);
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

  it('does not let an in-flight classifier overwrite a manual ready save', async () => {
    let resolveClassification!: (outcome: any) => void;
    classifier.classify.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClassification = resolve;
        }),
    );
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    const workspace = createReferenceWorkspace({
      repository: repo,
      queue,
      listCharacters: async () => [{ id: 'mara', name: 'Mara' }],
      listLocations: async () => [],
    });
    queue.pause();
    await queue.enqueue('r1');
    const running = queue.resume();
    await vi.waitFor(() => expect(classifier.classify).toHaveBeenCalledOnce());

    await workspace.handleAction({
      action: 'save-reference-classification',
      referenceId: 'r1',
      classification: {
        subjectType: 'character',
        use: 'identity',
        characterIds: ['mara'],
        locationId: null,
        facets: {},
        description: 'Manual replacement',
      },
    });
    resolveClassification({ kind: 'classified', classification });
    await running;

    expect(await repo.getAsset('r1')).toMatchObject({
      classificationState: 'ready',
      description: 'Manual replacement',
      provenance: { metadata: 'manual' },
    });
    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'complete' });
  });

  it('does not recreate an asset deleted while classification is in flight', async () => {
    let resolveClassification!: (outcome: any) => void;
    classifier.classify.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClassification = resolve;
        }),
    );
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    queue.pause();
    await queue.enqueue('r1');
    const running = queue.resume();
    await vi.waitFor(() => expect(classifier.classify).toHaveBeenCalledOnce());

    await repo.deleteAsset('r1');
    resolveClassification({ kind: 'classified', classification });
    await running;

    expect(await repo.getAsset('r1')).toBeUndefined();
    expect(await repo.getJobByAsset('r1')).toBeUndefined();
  });

  it('does not recreate a running job when deletion wins between pending selection and claim', async () => {
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    queue.pause();
    await queue.enqueue('r1');
    const claim = repo.claimPendingJobIfCurrent.bind(repo);
    repo.claimPendingJobIfCurrent = async (...args) => {
      await repo.deleteAsset('r1');
      return claim(...args);
    };

    await queue.resume();

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(await repo.getAsset('r1')).toBeUndefined();
    expect(await repo.getJobByAsset('r1')).toBeUndefined();
  });

  it('does not overwrite a manual-completed job when manual save wins between pending selection and claim', async () => {
    const queue = createClassificationQueue({ repository: repo, classifier, now });
    const workspace = createReferenceWorkspace({
      repository: repo,
      queue,
      listCharacters: async () => [{ id: 'mara', name: 'Mara' }],
      listLocations: async () => [],
    });
    queue.pause();
    await queue.enqueue('r1');
    const claim = repo.claimPendingJobIfCurrent.bind(repo);
    repo.claimPendingJobIfCurrent = async (...args) => {
      await workspace.handleAction({
        action: 'save-reference-classification',
        referenceId: 'r1',
        classification: {
          subjectType: 'character',
          use: 'identity',
          characterIds: ['mara'],
          locationId: null,
          facets: {},
          description: 'Manual before claim',
        },
      });
      return claim(...args);
    };

    await queue.resume();

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(await repo.getAsset('r1')).toMatchObject({ provenance: { metadata: 'manual' } });
    expect(await repo.getJobByAsset('r1')).toMatchObject({ status: 'complete' });
  });
});
