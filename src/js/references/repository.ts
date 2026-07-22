import DB from '../db.js';
import type { ClassificationJob, ReferenceAsset, WorldLocation } from './types.js';

export type ReferenceStoreName = 'characters' | 'worlds' | 'locations' | 'referenceAssets' | 'classificationJobs';

export interface ReferenceTransaction {
  get<T>(storeName: ReferenceStoreName, id: string): Promise<T | undefined>;
  getAll<T>(storeName: ReferenceStoreName): Promise<T[]>;
  getAllByIndex<T>(storeName: ReferenceStoreName, indexName: string, value: unknown): Promise<T[]>;
  put<T extends { id: string }>(storeName: ReferenceStoreName, value: T): Promise<void>;
  delete(storeName: ReferenceStoreName, id: string): Promise<void>;
}

export interface ReferenceRepositoryDependencies {
  transaction<T>(
    storeNames: readonly ReferenceStoreName[],
    mode: 'readonly' | 'readwrite',
    operation: (transaction: ReferenceTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ReferenceRepository {
  getAsset(id: string): Promise<ReferenceAsset | undefined>;
  listByWorld(worldId: string): Promise<ReferenceAsset[]>;
  listByCharacter(worldId: string, characterId: string): Promise<ReferenceAsset[]>;
  putAsset(asset: ReferenceAsset): Promise<void>;
  setAutoUse(id: string, autoUse: boolean): Promise<void>;
  unlinkCharacter(id: string, characterId: string): Promise<void>;
  deleteAsset(id: string): Promise<void>;
  getJobByAsset(assetId: string): Promise<ClassificationJob | undefined>;
  listJobs(): Promise<ClassificationJob[]>;
  putJob(job: ClassificationJob): Promise<void>;
  putAssetAndJob(asset: ReferenceAsset, job: ClassificationJob): Promise<void>;
  listLocations(worldId: string): Promise<WorldLocation[]>;
  putLocation(location: WorldLocation): Promise<void>;
}

interface PreferredCharacterRecord {
  id: string;
  preferredIdentityReferenceId?: string | null;
}

interface PreferredWorldRecord {
  id: string;
  preferredStyleReferenceId?: string | null;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

export function createIndexedDbReferenceDependencies(): ReferenceRepositoryDependencies {
  return {
    async transaction<T>(
      storeNames: readonly ReferenceStoreName[],
      mode: 'readonly' | 'readwrite',
      operation: (transaction: ReferenceTransaction) => Promise<T>,
    ): Promise<T> {
      const database = await DB.open();
      const transaction = database.transaction([...storeNames], mode);
      const complete = transactionCompletion(transaction);
      const access: ReferenceTransaction = {
        get: async <Value>(storeName: ReferenceStoreName, id: string) =>
          requestResult(transaction.objectStore(storeName).get(id)) as Promise<Value | undefined>,
        getAll: async <Value>(storeName: ReferenceStoreName) =>
          requestResult(transaction.objectStore(storeName).getAll()) as Promise<Value[]>,
        getAllByIndex: async <Value>(storeName: ReferenceStoreName, indexName: string, value: unknown) =>
          requestResult(transaction.objectStore(storeName).index(indexName).getAll(IDBKeyRange.only(value))) as Promise<
            Value[]
          >,
        put: async (storeName, value) => {
          await requestResult(transaction.objectStore(storeName).put(value));
        },
        delete: async (storeName, id) => {
          await requestResult(transaction.objectStore(storeName).delete(id));
        },
      };

      try {
        const result = await operation(access);
        await complete;
        return result;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have completed after the final request.
        }
        await complete.catch(() => undefined);
        throw error;
      }
    },
  };
}

function stableRecords<T extends { id: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeAsset(asset: ReferenceAsset): ReferenceAsset {
  return { ...asset, characterIds: [...new Set(asset.characterIds)] };
}

async function clearPreferredReference(
  transaction: ReferenceTransaction,
  storeName: 'characters' | 'worlds' | 'locations',
  referenceId: string,
): Promise<void> {
  const records = await transaction.getAll<PreferredCharacterRecord | PreferredWorldRecord | WorldLocation>(storeName);
  for (const record of records) {
    if (
      storeName === 'characters' &&
      (record as PreferredCharacterRecord).preferredIdentityReferenceId === referenceId
    ) {
      await transaction.put(storeName, { ...record, preferredIdentityReferenceId: null });
    } else if (storeName === 'worlds' && (record as PreferredWorldRecord).preferredStyleReferenceId === referenceId) {
      await transaction.put(storeName, { ...record, preferredStyleReferenceId: null });
    } else if (storeName === 'locations' && (record as WorldLocation).preferredReferenceId === referenceId) {
      await transaction.put(storeName, { ...record, preferredReferenceId: null });
    }
  }
}

export function createReferenceRepository(
  dependencies: ReferenceRepositoryDependencies = createIndexedDbReferenceDependencies(),
): ReferenceRepository {
  return {
    getAsset: (id) =>
      dependencies.transaction(['referenceAssets'], 'readonly', (transaction) =>
        transaction.get<ReferenceAsset>('referenceAssets', id),
      ),

    listByWorld: (worldId) =>
      dependencies.transaction(['referenceAssets'], 'readonly', async (transaction) =>
        stableRecords(await transaction.getAllByIndex<ReferenceAsset>('referenceAssets', 'worldId', worldId)),
      ),

    listByCharacter: (worldId, characterId) =>
      dependencies.transaction(['referenceAssets'], 'readonly', async (transaction) => {
        const matches = await transaction.getAllByIndex<ReferenceAsset>('referenceAssets', 'characterIds', characterId);
        return stableRecords(matches.filter((asset) => asset.worldId === worldId));
      }),

    putAsset: (asset) =>
      dependencies.transaction(['referenceAssets'], 'readwrite', (transaction) =>
        transaction.put('referenceAssets', normalizeAsset(asset)),
      ),

    setAutoUse: (id, autoUse) =>
      dependencies.transaction(['referenceAssets'], 'readwrite', async (transaction) => {
        const asset = await transaction.get<ReferenceAsset>('referenceAssets', id);
        if (!asset) return;
        await transaction.put('referenceAssets', { ...asset, autoUse, updatedAt: Date.now() });
      }),

    unlinkCharacter: (id, characterId) =>
      dependencies.transaction(['referenceAssets', 'characters'], 'readwrite', async (transaction) => {
        const asset = await transaction.get<ReferenceAsset>('referenceAssets', id);
        if (!asset || !asset.characterIds.includes(characterId)) return;
        const characterIds = asset.characterIds.filter((candidate) => candidate !== characterId);
        const needsReview =
          asset.subjectType === 'interaction' || (asset.subjectType === 'character' && characterIds.length === 0);
        await transaction.put('referenceAssets', {
          ...asset,
          characterIds,
          ...(needsReview ? { classificationState: 'needs-review' as const, acceptedAsIs: false } : {}),
          updatedAt: Date.now(),
        });
        const character = await transaction.get<PreferredCharacterRecord>('characters', characterId);
        if (character?.preferredIdentityReferenceId === id) {
          await transaction.put('characters', { ...character, preferredIdentityReferenceId: null });
        }
      }),

    deleteAsset: (id) =>
      dependencies.transaction(
        ['referenceAssets', 'characters', 'worlds', 'locations'],
        'readwrite',
        async (transaction) => {
          await clearPreferredReference(transaction, 'characters', id);
          await clearPreferredReference(transaction, 'worlds', id);
          await clearPreferredReference(transaction, 'locations', id);
          await transaction.delete('referenceAssets', id);
        },
      ),

    getJobByAsset: (assetId) =>
      dependencies.transaction(['classificationJobs'], 'readonly', async (transaction) => {
        const jobs = await transaction.getAllByIndex<ClassificationJob>('classificationJobs', 'assetId', assetId);
        return jobs[0];
      }),

    listJobs: () =>
      dependencies.transaction(['classificationJobs'], 'readonly', async (transaction) =>
        stableRecords(await transaction.getAll<ClassificationJob>('classificationJobs')),
      ),

    putJob: (job) =>
      dependencies.transaction(['classificationJobs'], 'readwrite', (transaction) =>
        transaction.put('classificationJobs', job),
      ),

    putAssetAndJob: (asset, job) =>
      dependencies.transaction(['referenceAssets', 'classificationJobs'], 'readwrite', async (transaction) => {
        await transaction.put('referenceAssets', normalizeAsset(asset));
        await transaction.put('classificationJobs', job);
      }),

    listLocations: (worldId) =>
      dependencies.transaction(['locations'], 'readonly', async (transaction) =>
        stableRecords(await transaction.getAllByIndex<WorldLocation>('locations', 'worldId', worldId)),
      ),

    putLocation: (location) =>
      dependencies.transaction(['locations'], 'readwrite', (transaction) => transaction.put('locations', location)),
  };
}
