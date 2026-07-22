import { beforeEach, describe, expect, it } from 'vitest';
import {
  createReferenceRepository,
  type ReferenceRepositoryDependencies,
  type ReferenceStoreName,
  type ReferenceTransaction,
} from '../src/js/references/repository.js';
import type { ClassificationJob, ReferenceAsset, WorldLocation } from '../src/js/references/types.js';

type StoredRecord = { id: string };

function createMemoryDependencies() {
  const stores = new Map<ReferenceStoreName, Map<string, StoredRecord>>();
  const store = (name: ReferenceStoreName) => {
    let records = stores.get(name);
    if (!records) {
      records = new Map();
      stores.set(name, records);
    }
    return records;
  };
  let transactionCount = 0;

  const transaction: ReferenceRepositoryDependencies['transaction'] = async (_stores, _mode, operation) => {
    transactionCount += 1;
    const access: ReferenceTransaction = {
      get: async <T>(name: ReferenceStoreName, id: string) => store(name).get(id) as T | undefined,
      getAll: async <T>(name: ReferenceStoreName) => [...store(name).values()] as T[],
      getAllByIndex: async <T>(name: ReferenceStoreName, indexName: string, value: unknown) =>
        [...store(name).values()].filter((record) => {
          const indexed = (record as Record<string, unknown>)[indexName];
          return Array.isArray(indexed) ? indexed.includes(value) : indexed === value;
        }) as T[],
      put: async (name: ReferenceStoreName, value: StoredRecord) => {
        store(name).set(value.id, structuredClone(value));
      },
      delete: async (name: ReferenceStoreName, id: string) => {
        store(name).delete(id);
      },
    };
    return operation(access);
  };

  return {
    dependencies: { transaction },
    put: (name: ReferenceStoreName, value: StoredRecord) => store(name).set(value.id, structuredClone(value)),
    get: <T>(name: ReferenceStoreName, id: string) => store(name).get(id) as T | undefined,
    getCharacter: (id: string) => store('characters').get(id) as Record<string, unknown> | undefined,
    get transactionCount() {
      return transactionCount;
    },
  };
}

function asset(overrides: Partial<ReferenceAsset> = {}): ReferenceAsset {
  return {
    id: 'r1',
    worldId: 'w1',
    dataUrl: 'data:image/png;base64,abc',
    subjectType: 'interaction',
    use: 'relationship',
    characterIds: ['mara', 'theo'],
    locationId: 'yard',
    facets: {},
    description: '',
    confidence: {},
    provenance: { source: 'uploaded', metadata: 'local' },
    classificationState: 'ready',
    acceptedAsIs: false,
    autoUse: true,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

describe('reference repository', () => {
  let memory: ReturnType<typeof createMemoryDependencies>;
  let repo: ReturnType<typeof createReferenceRepository>;

  beforeEach(() => {
    memory = createMemoryDependencies();
    repo = createReferenceRepository(memory.dependencies);
  });

  it('lists a shared interaction from either child without duplicating it', async () => {
    await repo.putAsset(asset({ id: 'r1', worldId: 'w1', characterIds: ['mara', 'theo', 'mara'] }));

    expect((await repo.listByCharacter('w1', 'mara')).map((item) => item.id)).toEqual(['r1']);
    expect((await repo.listByCharacter('w1', 'theo')).map((item) => item.id)).toEqual(['r1']);
  });

  it('hides without deleting and clears dangling preferred IDs on delete', async () => {
    memory.put('characters', { id: 'mara', worldId: 'w1', preferredIdentityReferenceId: 'r1' });
    memory.put('worlds', { id: 'w1', preferredStyleReferenceId: 'r1' });
    memory.put('locations', { id: 'yard', worldId: 'w1', preferredReferenceId: 'r1' });
    await repo.putAsset(asset());

    await repo.setAutoUse('r1', false);
    expect((await repo.getAsset('r1'))?.autoUse).toBe(false);

    await repo.deleteAsset('r1');
    expect(await repo.getAsset('r1')).toBeUndefined();
    expect(memory.getCharacter('mara')?.preferredIdentityReferenceId).toBeNull();
    expect(memory.get<Record<string, unknown>>('worlds', 'w1')?.preferredStyleReferenceId).toBeNull();
    expect(memory.get<WorldLocation>('locations', 'yard')?.preferredReferenceId).toBeNull();
  });

  it('unlinks one child and marks an interaction that needs review', async () => {
    memory.put('characters', { id: 'mara', worldId: 'w1', preferredIdentityReferenceId: 'r1' });
    await repo.putAsset(asset());

    await repo.unlinkCharacter('r1', 'mara');

    expect(await repo.getAsset('r1')).toMatchObject({
      characterIds: ['theo'],
      classificationState: 'needs-review',
      acceptedAsIs: false,
    });
    expect(memory.getCharacter('mara')?.preferredIdentityReferenceId).toBeNull();
  });

  it('stores an asset and job atomically and exposes job and location methods', async () => {
    const job: ClassificationJob = {
      id: 'j1',
      assetId: 'r1',
      worldId: 'w1',
      status: 'pending',
      attemptCount: 0,
      createdAt: 10,
      updatedAt: 10,
    };
    const location: WorldLocation = { id: 'yard', worldId: 'w1', name: 'Yard', aliases: [] };
    const before = memory.transactionCount;

    await repo.putAssetAndJob(asset(), job);
    expect(memory.transactionCount).toBe(before + 1);
    expect(await repo.getJobByAsset('r1')).toEqual(job);

    await repo.putLocation(location);
    expect(await repo.listLocations('w1')).toEqual([location]);
    expect((await repo.listJobs()).map((item) => item.id)).toEqual(['j1']);
  });

  it('stores allowlisted diagnostic fields with global retention and expiry', async () => {
    const current = Date.now();
    for (let index = 0; index < 501; index += 1) {
      await repo.recordDiagnostic({
        id: `d${index}`,
        assetId: `r${index}`,
        worldId: 'w1',
        createdAt: current + index,
        error: {
          stage: 'parse',
          code: 'invalid-json',
          mode: 'local',
          message: 'prompt=data:image/png;base64,secret-token',
          rawOutputExcerpt: 'Roster: secret world description',
        },
      } as any);
    }
    await repo.recordDiagnostic({
      id: 'expired',
      assetId: 'old',
      worldId: 'w1',
      createdAt: current - 7 * 24 * 60 * 60 * 1000 - 1,
      error: { stage: 'parse', code: 'invalid-json' },
    });

    const diagnostics = await repo.listDiagnostics();
    expect(diagnostics).toHaveLength(500);
    expect(diagnostics.map((item) => item.id)).not.toContain('expired');
    expect(diagnostics[0]?.error.message).toBeUndefined();
    expect((diagnostics[0]?.error as any).rawOutputExcerpt).toBeUndefined();
  });

  it('retains the newest diagnostics by timestamp rather than diagnostic ID', async () => {
    const error = { stage: 'parse' as const, code: 'invalid-json' as const };
    const current = Date.now();
    for (let index = 1; index <= 49; index += 1) {
      await repo.recordDiagnostic({
        id: `middle-${index}`,
        assetId: 'r1',
        worldId: 'w1',
        createdAt: current + index,
        error,
      });
    }
    await repo.recordDiagnostic({ id: 'z-oldest', assetId: 'r1', worldId: 'w1', createdAt: current, error });
    await repo.recordDiagnostic({ id: 'a-newest', assetId: 'r1', worldId: 'w1', createdAt: current + 100, error });
    for (let index = 1; index <= 450; index += 1) {
      await repo.recordDiagnostic({
        id: `other-${index}`,
        assetId: `other-${index}`,
        worldId: 'w1',
        createdAt: current + 200 + index,
        error,
      });
    }

    expect((await repo.listDiagnostics('r1')).map((item) => item.id)).toEqual(expect.arrayContaining(['a-newest']));
    expect((await repo.listDiagnostics('r1')).map((item) => item.id)).not.toContain('z-oldest');
  });

  it('retains a bounded non-sensitive parse excerpt', async () => {
    await repo.recordDiagnostic({
      id: 'safe-parse',
      assetId: 'r1',
      worldId: 'w1',
      createdAt: Date.now(),
      error: { stage: 'parse', code: 'invalid-json', rawOutputExcerpt: 'x'.repeat(20 * 1024) },
    });

    expect((await repo.listDiagnostics('r1'))[0]?.error.rawOutputExcerpt).toHaveLength(16 * 1024);
  });
});
