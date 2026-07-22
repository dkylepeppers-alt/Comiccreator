import { describe, it, beforeEach, expect } from 'vitest';
import 'fake-indexeddb/auto';

const { default: DB } = await import('../src/js/db.js');

beforeEach(async () => {
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
});

describe('DB module', () => {
  it('open creates all stores and expected indexes', async () => {
    const db = await DB.open();
    expect(db.objectStoreNames.contains(DB.STORES.characters)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.worlds)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.locations)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.referenceAssets)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.classificationJobs)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.classificationDiagnostics)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.comics)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.pages)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.presets)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.imagePresets)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.settings)).toBeTruthy();

    const tx = db.transaction(DB.STORES.comics, 'readonly');
    expect(tx.objectStore(DB.STORES.comics).indexNames.contains('createdAt')).toBeTruthy();
    tx.abort();

    const tx2 = db.transaction(DB.STORES.pages, 'readonly');
    expect(tx2.objectStore(DB.STORES.pages).indexNames.contains('comicId')).toBeTruthy();
    tx2.abort();

    const tx3 = db.transaction(DB.STORES.referenceAssets, 'readonly');
    const references = tx3.objectStore(DB.STORES.referenceAssets);
    expect(references.indexNames.contains('worldId')).toBeTruthy();
    expect(references.indexNames.contains('characterIds')).toBeTruthy();
    expect(references.index('characterIds').multiEntry).toBeTruthy();
    expect(references.indexNames.contains('locationId')).toBeTruthy();
    expect(references.indexNames.contains('classificationState')).toBeTruthy();
    tx3.abort();

    const tx4 = db.transaction(DB.STORES.classificationJobs, 'readonly');
    const jobs = tx4.objectStore(DB.STORES.classificationJobs);
    expect(jobs.indexNames.contains('status')).toBeTruthy();
    expect(jobs.indexNames.contains('assetId')).toBeTruthy();
    expect(jobs.index('assetId').unique).toBeTruthy();
    tx4.abort();

    const tx5 = db.transaction(DB.STORES.classificationDiagnostics, 'readonly');
    expect(tx5.objectStore(DB.STORES.classificationDiagnostics).indexNames.contains('assetId')).toBeTruthy();
    tx5.abort();
  });

  it('supports put/get/getAll/del', async () => {
    const character = { id: DB.uuid(), name: 'Nyx', role: 'hero', description: 'Lead' };
    await DB.put(DB.STORES.characters, character);
    const one = await DB.get(DB.STORES.characters, character.id);
    expect(one.name).toBe('Nyx');

    await DB.put(DB.STORES.characters, { id: DB.uuid(), name: 'Echo' });
    expect((await DB.getAll(DB.STORES.characters)).length).toBe(2);

    await DB.del(DB.STORES.characters, character.id);
    expect(await DB.get(DB.STORES.characters, character.id)).toBe(undefined);
  });

  it('get returns undefined for null, undefined, or empty-string id without throwing', async () => {
    expect(await DB.get(DB.STORES.characters, null)).toBe(undefined);
    expect(await DB.get(DB.STORES.characters, undefined)).toBe(undefined);
    expect(await DB.get(DB.STORES.characters, '')).toBe(undefined);
  });

  it('del is a no-op for null, undefined, or empty-string id without throwing', async () => {
    await DB.del(DB.STORES.characters, null);
    await DB.del(DB.STORES.characters, undefined);
    await DB.del(DB.STORES.characters, '');
  });

  it('supports getByIndex for pages by comicId', async () => {
    const comicId = DB.uuid();
    await DB.put(DB.STORES.pages, { id: DB.uuid(), comicId, pageNum: 1 });
    await DB.put(DB.STORES.pages, { id: DB.uuid(), comicId, pageNum: 2 });
    await DB.put(DB.STORES.pages, { id: DB.uuid(), comicId: DB.uuid(), pageNum: 3 });
    const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', comicId);
    expect(pages.length).toBe(2);
  });

  it('uuid generates v4 unique ids', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(DB.uuid());
    expect(seen.size).toBe(100);
    for (const id of seen) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it('getSetting and setSetting work with default fallback', async () => {
    await DB.setSetting('apiKey', 'abc123');
    expect(await DB.getSetting('apiKey', '')).toBe('abc123');
    expect(await DB.getSetting('missing', 'default')).toBe('default');
  });

  it('seedDefaults creates presets once', async () => {
    await DB.seedDefaults();
    const first = await DB.getAll(DB.STORES.presets);
    expect(first.length).toBe(3);
    const firstImagePresets = await DB.getAll(DB.STORES.imagePresets);
    expect(firstImagePresets.length).toBe(5);
    await DB.seedDefaults();
    const second = await DB.getAll(DB.STORES.presets);
    expect(second.length).toBe(3);
    const secondImagePresets = await DB.getAll(DB.STORES.imagePresets);
    expect(secondImagePresets.length).toBe(5);
  });

  it('dedupePresets removes older duplicates by name', async () => {
    await DB.put(DB.STORES.presets, { id: 'old', name: 'Storm', createdAt: 1 });
    await DB.put(DB.STORES.presets, { id: 'new', name: 'storm', updatedAt: 5 });
    const deduped = await DB.dedupePresets();
    expect(deduped.length).toBe(1);
    expect(deduped[0].id).toBe('new');
    const rows = await DB.getAll(DB.STORES.presets);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('new');
  });
});
