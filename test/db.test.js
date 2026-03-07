const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { indexedDB } = require('fake-indexeddb');

globalThis.indexedDB = indexedDB;
globalThis.crypto = globalThis.crypto || require('node:crypto').webcrypto;

const dbCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8');
vm.runInThisContext(`${dbCode}\n;globalThis.__TEST_DB__ = DB;`, { filename: 'db.js' });
const DB = globalThis.__TEST_DB__;

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
    assert.ok(db.objectStoreNames.contains(DB.STORES.characters));
    assert.ok(db.objectStoreNames.contains(DB.STORES.worlds));
    assert.ok(db.objectStoreNames.contains(DB.STORES.comics));
    assert.ok(db.objectStoreNames.contains(DB.STORES.pages));
    assert.ok(db.objectStoreNames.contains(DB.STORES.presets));
    assert.ok(db.objectStoreNames.contains(DB.STORES.imagePresets));
    assert.ok(db.objectStoreNames.contains(DB.STORES.settings));

    const tx = db.transaction(DB.STORES.comics, 'readonly');
    assert.ok(tx.objectStore(DB.STORES.comics).indexNames.contains('createdAt'));
    tx.abort();

    const tx2 = db.transaction(DB.STORES.pages, 'readonly');
    assert.ok(tx2.objectStore(DB.STORES.pages).indexNames.contains('comicId'));
    tx2.abort();
  });

  it('supports put/get/getAll/del', async () => {
    const character = { id: DB.uuid(), name: 'Nyx', role: 'hero', description: 'Lead' };
    await DB.put(DB.STORES.characters, character);
    const one = await DB.get(DB.STORES.characters, character.id);
    assert.equal(one.name, 'Nyx');

    await DB.put(DB.STORES.characters, { id: DB.uuid(), name: 'Echo' });
    assert.equal((await DB.getAll(DB.STORES.characters)).length, 2);

    await DB.del(DB.STORES.characters, character.id);
    assert.equal(await DB.get(DB.STORES.characters, character.id), undefined);
  });

  it('get returns undefined for null, undefined, or empty-string id without throwing', async () => {
    assert.equal(await DB.get(DB.STORES.characters, null), undefined);
    assert.equal(await DB.get(DB.STORES.characters, undefined), undefined);
    assert.equal(await DB.get(DB.STORES.characters, ''), undefined);
  });

  it('del is a no-op for null, undefined, or empty-string id without throwing', async () => {
    await assert.doesNotReject(() => DB.del(DB.STORES.characters, null));
    await assert.doesNotReject(() => DB.del(DB.STORES.characters, undefined));
    await assert.doesNotReject(() => DB.del(DB.STORES.characters, ''));
  });

  it('supports getByIndex for pages by comicId', async () => {
    const comicId = DB.uuid();
    await DB.put(DB.STORES.pages, { id: DB.uuid(), comicId, pageNum: 1 });
    await DB.put(DB.STORES.pages, { id: DB.uuid(), comicId, pageNum: 2 });
    await DB.put(DB.STORES.pages, { id: DB.uuid(), comicId: DB.uuid(), pageNum: 3 });
    const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', comicId);
    assert.equal(pages.length, 2);
  });

  it('uuid generates v4 unique ids', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(DB.uuid());
    assert.equal(seen.size, 100);
    for (const id of seen) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it('getSetting and setSetting work with default fallback', async () => {
    await DB.setSetting('apiKey', 'abc123');
    assert.equal(await DB.getSetting('apiKey', ''), 'abc123');
    assert.equal(await DB.getSetting('missing', 'default'), 'default');
  });

  it('seedDefaults creates presets once', async () => {
    await DB.seedDefaults();
    const first = await DB.getAll(DB.STORES.presets);
    assert.equal(first.length, 3);
    const firstImagePresets = await DB.getAll(DB.STORES.imagePresets);
    assert.equal(firstImagePresets.length, 5);
    await DB.seedDefaults();
    const second = await DB.getAll(DB.STORES.presets);
    assert.equal(second.length, 3);
    const secondImagePresets = await DB.getAll(DB.STORES.imagePresets);
    assert.equal(secondImagePresets.length, 5);
  });

  it('dedupePresets removes older duplicates by name', async () => {
    await DB.put(DB.STORES.presets, { id: 'old', name: 'Storm', createdAt: 1 });
    await DB.put(DB.STORES.presets, { id: 'new', name: 'storm', updatedAt: 5 });
    const deduped = await DB.dedupePresets();
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].id, 'new');
    const rows = await DB.getAll(DB.STORES.presets);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'new');
  });
});

describe('DB.migrateWorld', () => {
  const SAMPLE_IMAGE_URL = 'data:image/png;base64,abc';

  it('returns null/undefined unchanged', () => {
    assert.equal(DB.migrateWorld(null), null);
    assert.equal(DB.migrateWorld(undefined), undefined);
  });

  it('converts legacy string image array to object format with embedding: null', () => {
    const world = { id: '1', images: [SAMPLE_IMAGE_URL] };
    const result = DB.migrateWorld(world);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].dataUrl, SAMPLE_IMAGE_URL);
    assert.equal(result.images[0].tag, 'establishing');
    assert.equal(result.images[0].description, '');
    assert.equal(result.images[0].embedding, null);
  });

  it('adds embedding: null to already-migrated object-format images that are missing the field', () => {
    const world = { id: '2', images: [{ dataUrl: 'data:image/png;base64,xyz', tag: 'interior', description: 'A cave' }] };
    const result = DB.migrateWorld(world);
    assert.equal(result.images[0].embedding, null);
    assert.equal(result.images[0].description, 'A cave');
  });

  it('preserves an existing embedding value during migration', () => {
    const embedding = [0.1, 0.2, 0.3];
    const world = { id: '3', images: [{ dataUrl: 'data:image/png;base64,xyz', tag: 'exterior', description: 'Open sky', embedding }] };
    const result = DB.migrateWorld(world);
    assert.deepEqual(result.images[0].embedding, embedding);
  });

  it('filters out null/undefined image entries', () => {
    const world = { id: '4', images: [null, SAMPLE_IMAGE_URL, undefined] };
    const result = DB.migrateWorld(world);
    assert.equal(result.images.length, 1);
  });

  it('sets primaryImageIndex to 0 when missing', () => {
    const world = { id: '5', images: [SAMPLE_IMAGE_URL] };
    const result = DB.migrateWorld(world);
    assert.equal(result.primaryImageIndex, 0);
  });

  it('does not mutate the original world object', () => {
    const world = { id: '6', images: [SAMPLE_IMAGE_URL] };
    DB.migrateWorld(world);
    assert.equal(typeof world.images[0], 'string');
  });
});
