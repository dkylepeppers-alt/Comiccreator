import DB from '../db.js';
import { safeDiagnosticExcerpt } from './diagnostic-privacy.js';
import type { ClassificationDiagnostic, ClassificationJob, ReferenceAsset, WorldLocation } from './types.js';

export type ReferenceStoreName =
  'characters' | 'worlds' | 'locations' | 'referenceAssets' | 'classificationJobs' | 'classificationDiagnostics';

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
  claimPendingJobIfCurrent(job: ClassificationJob, running: ClassificationJob): Promise<ReferenceAsset | undefined>;
  finalizeAssetAndJobIfCurrent(
    snapshot: ReferenceAsset,
    asset: ReferenceAsset,
    job: ClassificationJob,
    diagnostic?: ClassificationDiagnostic,
  ): Promise<boolean>;
  recordDiagnostic(diagnostic: ClassificationDiagnostic): Promise<void>;
  listDiagnostics(assetId?: string): Promise<ClassificationDiagnostic[]>;
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
  return {
    ...asset,
    characterIds: [...new Set(asset.characterIds)],
    proposedCharacterNames: [...new Set(asset.proposedCharacterNames || [])],
    proposedLocationName: asset.proposedLocationName || null,
  };
}

const DIAGNOSTIC_MAX_COUNT = 500;
const DIAGNOSTIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sanitizeDiagnostic(diagnostic: ClassificationDiagnostic): ClassificationDiagnostic {
  const { stage, code, mode, retryDelayMs, validationReason, queueState, rawOutputExcerpt } = diagnostic.error;
  const safeExcerpt = safeDiagnosticExcerpt(rawOutputExcerpt);
  return {
    id: diagnostic.id,
    assetId: diagnostic.assetId,
    worldId: diagnostic.worldId,
    createdAt: diagnostic.createdAt,
    ...(diagnostic.queueState ? { queueState: diagnostic.queueState } : {}),
    error: {
      stage,
      code,
      ...(mode ? { mode } : {}),
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
      ...(validationReason ? { validationReason } : {}),
      ...(queueState ? { queueState } : {}),
      ...(safeExcerpt ? { rawOutputExcerpt: safeExcerpt } : {}),
    },
  };
}

async function pruneDiagnostics(transaction: ReferenceTransaction): Promise<void> {
  const cutoff = Date.now() - DIAGNOSTIC_MAX_AGE_MS;
  const existing = await transaction.getAll<ClassificationDiagnostic>('classificationDiagnostics');
  const expired = existing.filter((diagnostic) => diagnostic.createdAt < cutoff);
  const retained = existing
    .filter((diagnostic) => diagnostic.createdAt >= cutoff)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const overflow = retained.slice(0, Math.max(0, retained.length - DIAGNOSTIC_MAX_COUNT));
  for (const stale of [...expired, ...overflow]) await transaction.delete('classificationDiagnostics', stale.id);
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
        ['referenceAssets', 'classificationJobs', 'classificationDiagnostics', 'characters', 'worlds', 'locations'],
        'readwrite',
        async (transaction) => {
          await clearPreferredReference(transaction, 'characters', id);
          await clearPreferredReference(transaction, 'worlds', id);
          await clearPreferredReference(transaction, 'locations', id);
          await transaction.delete('referenceAssets', id);
          const jobs = await transaction.getAllByIndex<ClassificationJob>('classificationJobs', 'assetId', id);
          for (const job of jobs) await transaction.delete('classificationJobs', job.id);
          const diagnostics = await transaction.getAllByIndex<ClassificationDiagnostic>(
            'classificationDiagnostics',
            'assetId',
            id,
          );
          for (const item of diagnostics) await transaction.delete('classificationDiagnostics', item.id);
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

    claimPendingJobIfCurrent: (job, running) =>
      dependencies.transaction(['referenceAssets', 'classificationJobs'], 'readwrite', async (transaction) => {
        const [asset, currentJob] = await Promise.all([
          transaction.get<ReferenceAsset>('referenceAssets', job.assetId),
          transaction.get<ClassificationJob>('classificationJobs', job.id),
        ]);
        if (
          !asset ||
          asset.provenance.metadata === 'manual' ||
          asset.classificationState !== 'pending' ||
          asset.classificationVersion !== job.assetVersion ||
          !currentJob ||
          currentJob.assetId !== job.assetId ||
          currentJob.worldId !== job.worldId ||
          currentJob.status !== 'pending' ||
          currentJob.updatedAt !== job.updatedAt ||
          currentJob.assetVersion !== job.assetVersion
        ) {
          return undefined;
        }
        await transaction.put('classificationJobs', running);
        return asset;
      }),

    finalizeAssetAndJobIfCurrent: (snapshot, asset, job, diagnostic) =>
      dependencies.transaction(
        ['referenceAssets', 'classificationJobs', 'classificationDiagnostics'],
        'readwrite',
        async (transaction) => {
          const current = await transaction.get<ReferenceAsset>('referenceAssets', snapshot.id);
          if (
            !current ||
            current.provenance.metadata === 'manual' ||
            current.updatedAt !== snapshot.updatedAt ||
            current.classificationVersion !== snapshot.classificationVersion
          ) {
            return false;
          }
          await transaction.put('referenceAssets', normalizeAsset(asset));
          await transaction.put('classificationJobs', job);
          if (diagnostic) await transaction.put('classificationDiagnostics', sanitizeDiagnostic(diagnostic));
          if (diagnostic) await pruneDiagnostics(transaction);
          return true;
        },
      ),

    recordDiagnostic: (item) =>
      dependencies.transaction(['classificationDiagnostics'], 'readwrite', async (transaction) => {
        await transaction.put('classificationDiagnostics', sanitizeDiagnostic(item));
        await pruneDiagnostics(transaction);
      }),

    listDiagnostics: (assetId) =>
      dependencies.transaction(['classificationDiagnostics'], 'readwrite', async (transaction) => {
        const cutoff = Date.now() - DIAGNOSTIC_MAX_AGE_MS;
        const all = await transaction.getAll<ClassificationDiagnostic>('classificationDiagnostics');
        const retained = all
          .filter((diagnostic) => diagnostic.createdAt >= cutoff)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        const removed = [
          ...all.filter((diagnostic) => diagnostic.createdAt < cutoff),
          ...retained.slice(0, Math.max(0, retained.length - DIAGNOSTIC_MAX_COUNT)),
        ];
        for (const diagnostic of removed) await transaction.delete('classificationDiagnostics', diagnostic.id);
        const visible = retained.slice(Math.max(0, retained.length - DIAGNOSTIC_MAX_COUNT));
        return stableRecords(assetId ? visible.filter((diagnostic) => diagnostic.assetId === assetId) : visible);
      }),

    listLocations: (worldId) =>
      dependencies.transaction(['locations'], 'readonly', async (transaction) =>
        stableRecords(await transaction.getAllByIndex<WorldLocation>('locations', 'worldId', worldId)),
      ),

    putLocation: (location) =>
      dependencies.transaction(['locations'], 'readwrite', (transaction) => transaction.put('locations', location)),
  };
}
