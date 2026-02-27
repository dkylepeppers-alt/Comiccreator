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
    await DB.seedDefaults();
    const second = await DB.getAll(DB.STORES.presets);
    assert.equal(second.length, 3);
  });
});
