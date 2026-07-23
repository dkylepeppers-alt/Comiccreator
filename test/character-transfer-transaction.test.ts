import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import DB from '../src/js/db.js';
import { commitCharacterImport, planCharacterImport } from '../src/js/character-transfer.js';

beforeEach(async () => {
  const database = await DB.open();
  await Promise.all(
    Object.values(DB.STORES).map(
      (storeName) =>
        new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(storeName, 'readwrite');
          transaction.objectStore(storeName).clear();
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        }),
    ),
  );
});

describe('character import transaction', () => {
  it('rolls back the character and reference write set when one job cannot be persisted', async () => {
    const plan = planCharacterImport(
      { id: 'mara', name: 'Mara', imageData: 'data:image/png;base64,TUFSQQ==' },
      { worldId: 'atlas', existingCharacterIds: [], existingReferenceIds: [], newId: () => 'r1', now: 100 },
    );
    const invalidPlan = {
      ...plan,
      jobs: [{ ...plan.jobs[0], invalidValue: () => undefined }],
    };

    await expect(commitCharacterImport(invalidPlan, { putBatch: DB.putBatch })).rejects.toBeDefined();
    expect(await DB.get(DB.STORES.characters, 'mara')).toBeUndefined();
    expect(await DB.getAll(DB.STORES.referenceAssets)).toEqual([]);
    expect(await DB.getAll(DB.STORES.classificationJobs)).toEqual([]);
  });
});
