// @vitest-environment node
import { describe, it, beforeEach, expect } from 'vitest';
import 'fake-indexeddb/auto';

const { default: DB } = await import('../src/js/db.js');

beforeEach(async () => {
  const db = await DB.open();
  await Promise.all(Object.values(DB.STORES).map((storeName) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }));
});

describe('DB module', () => {
  it('open creates all stores and expected indexes', async () => {
    const db = await DB.open();
    expect(db.objectStoreNames.contains(DB.STORES.characters)).toBeTruthy();
    expect(db.objectStoreNames.contains(DB.STORES.worlds)).toBeTruthy();
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

describe('DB.migrateWorld', () => {
  const SAMPLE_IMAGE_URL = 'data:image/png;base64,abc';

  it('returns null/undefined unchanged', () => {
    expect(DB.migrateWorld(null)).toBe(null);
    expect(DB.migrateWorld(undefined)).toBe(undefined);
  });

  it('converts legacy string image array to object format with embedding: null', () => {
    const world = { id: '1', images: [SAMPLE_IMAGE_URL] };
    const result = DB.migrateWorld(world);
    expect(result.images.length).toBe(1);
    expect(result.images[0].dataUrl).toBe(SAMPLE_IMAGE_URL);
    expect(result.images[0].tag).toBe('establishing');
    expect(result.images[0].description).toBe('');
    expect(result.images[0].embedding).toBe(null);
  });

  it('adds embedding: null to already-migrated object-format images that are missing the field', () => {
    const world = { id: '2', images: [{ dataUrl: 'data:image/png;base64,xyz', tag: 'interior', description: 'A cave' }] };
    const result = DB.migrateWorld(world);
    expect(result.images[0].embedding).toBe(null);
    expect(result.images[0].description).toBe('A cave');
  });

  it('preserves an existing embedding value during migration', () => {
    const embedding = [0.1, 0.2, 0.3];
    const world = { id: '3', images: [{ dataUrl: 'data:image/png;base64,xyz', tag: 'exterior', description: 'Open sky', embedding }] };
    const result = DB.migrateWorld(world);
    expect(result.images[0].embedding).toEqual(embedding);
  });

  it('filters out null/undefined image entries', () => {
    const world = { id: '4', images: [null, SAMPLE_IMAGE_URL, undefined] };
    const result = DB.migrateWorld(world);
    expect(result.images.length).toBe(1);
  });

  it('sets primaryImageIndex to 0 when missing', () => {
    const world = { id: '5', images: [SAMPLE_IMAGE_URL] };
    const result = DB.migrateWorld(world);
    expect(result.primaryImageIndex).toBe(0);
  });

  it('does not mutate the original world object', () => {
    const world = { id: '6', images: [SAMPLE_IMAGE_URL] };
    DB.migrateWorld(world);
    expect(typeof world.images[0]).toBe('string');
  });
});
