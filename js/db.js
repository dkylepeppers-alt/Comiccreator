/**
 * IndexedDB Storage Layer
 * Handles all local persistence for characters, worlds, comics, presets, and settings.
 */
const DB = (() => {
  const DB_NAME = 'ComicCreatorDB';
  const DB_VERSION = 2;
  let db = null;

  const STORES = {
    characters: 'characters',
    worlds: 'worlds',
    comics: 'comics',
    pages: 'pages',
    presets: 'presets',
    settings: 'settings',
  };

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORES.characters)) {
          d.createObjectStore(STORES.characters, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(STORES.worlds)) {
          d.createObjectStore(STORES.worlds, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(STORES.comics)) {
          const cs = d.createObjectStore(STORES.comics, { keyPath: 'id' });
          cs.createIndex('createdAt', 'createdAt');
        }
        if (!d.objectStoreNames.contains(STORES.pages)) {
          const ps = d.createObjectStore(STORES.pages, { keyPath: 'id' });
          ps.createIndex('comicId', 'comicId');
        }
        if (!d.objectStoreNames.contains(STORES.presets)) {
          d.createObjectStore(STORES.presets, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(STORES.settings)) {
          d.createObjectStore(STORES.settings, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(storeName, mode = 'readonly') {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    await open();
    return promisify(tx(storeName).getAll());
  }

  async function get(storeName, id) {
    await open();
    return promisify(tx(storeName).get(id));
  }

  async function put(storeName, data) {
    await open();
    return promisify(tx(storeName, 'readwrite').put(data));
  }

  async function del(storeName, id) {
    await open();
    return promisify(tx(storeName, 'readwrite').delete(id));
  }

  async function getByIndex(storeName, indexName, value) {
    await open();
    const store = tx(storeName);
    const index = store.index(indexName);
    return promisify(index.getAll(value));
  }

  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  }

  // Settings helpers
  async function getSetting(key, defaultValue = null) {
    const row = await get(STORES.settings, key);
    return row ? row.value : defaultValue;
  }

  async function setSetting(key, value) {
    return put(STORES.settings, { key, value });
  }

  // Image helpers: store as data URLs
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Migrate a character record from the legacy single-imageData format to
   * the new images[] format.  Safe to call on already-migrated records.
   * Does NOT persist the change — callers should call DB.put() if they wish
   * to store the migration result.
   */
  function migrateCharacter(char) {
    if (!char) return char;
    if (Array.isArray(char.images) && char.images.length > 0) return char;
    const images = char.imageData
      ? [{ dataUrl: char.imageData, tag: 'default', description: '', embedding: null }]
      : [];
    return Object.assign({}, char, { images, primaryImageIndex: 0 });
  }

  // Seed default presets on first run (idempotent — stable IDs prevent duplicates)
  // Low, stable timestamps ensure seed presets sort to the bottom of the list (below user-created presets)
  const SEED_PRESETS = [
    {
      id: 'seed-preset-balanced',
      name: 'Balanced',
      description: 'Good for general storytelling',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      systemPrompt: 'You are a creative comic book writer. Create vivid, engaging comic panels with narration and dialogue.',
      createdAt: 1000000000000,
    },
    {
      id: 'seed-preset-creative',
      name: 'Creative',
      description: 'Higher randomness for unique stories',
      temperature: 1.0,
      topP: 0.95,
      maxTokens: 3000,
      systemPrompt: 'You are an avant-garde comic book creator. Push boundaries with unexpected plot twists and unique artistic descriptions.',
      createdAt: 1000000000001,
    },
    {
      id: 'seed-preset-precise',
      name: 'Precise',
      description: 'Lower randomness for consistent output',
      temperature: 0.3,
      topP: 0.8,
      maxTokens: 1500,
      systemPrompt: 'You are a disciplined comic book writer. Create clear, well-structured panels with consistent characterization.',
      createdAt: 1000000000002,
    },
  ];

  async function seedDefaults() {
    for (const p of SEED_PRESETS) {
      const existing = await get(STORES.presets, p.id);
      if (!existing) await put(STORES.presets, p);
    }
  }

  async function dedupePresets() {
    const all = await getAll(STORES.presets);
    const sorted = [...all].sort((a, b) => (b?.updatedAt ?? b?.createdAt ?? 0) - (a?.updatedAt ?? a?.createdAt ?? 0));
    const seen = new Set();
    const unique = [];
    for (const item of sorted) {
      const key = ((item?.name || '').trim().toLowerCase()) || item?.id || '';
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    if (unique.length !== all.length) {
      const keepIds = new Set(unique.map(p => p.id));
      for (const row of all) {
        if (!keepIds.has(row.id)) await del(STORES.presets, row.id);
      }
    }
    return unique;
  }

  return {
    open,
    STORES,
    getAll,
    get,
    put,
    del,
    getByIndex,
    uuid,
    getSetting,
    setSetting,
    fileToDataURL,
    migrateCharacter,
    seedDefaults,
    dedupePresets,
  };
})();
