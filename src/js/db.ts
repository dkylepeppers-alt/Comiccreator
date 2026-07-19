/**
 * IndexedDB Storage Layer
 * Handles all local persistence for characters, worlds, comics, presets, and settings.
 */
import type { ImageRef } from './utils.js';
import { ensureImageIds, normalizeLocationKey } from './utils.js';
import type { CharacterVisualStateDefaults, ComicVisualContinuity } from './visual-continuity.js';

export interface Character {
  id: string;
  name: string;
  genre?: string;
  role?: string;
  description?: string;
  appearance?: string;
  powers?: string;
  imageData?: string;
  images: ImageRef[];
  primaryImageIndex: number;
  /** Stable ID of the single authoritative identity-anchor gallery image. */
  identityAnchorImageId?: string | null;
  /** Reusable default mutable visual state (wardrobe, hair, items…). */
  defaultVisualState?: CharacterVisualStateDefaults;
  createdAt?: number;
  updatedAt?: number;
}

export interface World {
  id: string;
  name: string;
  description?: string;
  details?: string;
  atmosphere?: string;
  era?: string;
  images: ImageRef[];
  primaryImageIndex: number;
  /** Stable ID of the default location-anchor gallery image. */
  defaultAnchorImageId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface Comic {
  id: string;
  title?: string;
  genre?: string;
  characterIds?: string[];
  worldId?: string;
  /** Persistent per-comic visual continuity ledger. */
  visualContinuity?: ComicVisualContinuity | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface ComicPage {
  id: string;
  comicId: string;
  pageNum?: number;
  data?: any;
  createdAt?: number;
}

export interface Preset {
  id: string;
  name: string;
  description?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  systemPrompt?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ImagePreset {
  id: string;
  name: string;
  description?: string;
  promptPrefix: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface Setting {
  key: string;
  value: any;
}

const DB_NAME = 'ComicCreatorDB';
const DB_VERSION = 4;
let db: IDBDatabase | null = null;

const STORES = {
  characters: 'characters',
  worlds: 'worlds',
  comics: 'comics',
  pages: 'pages',
  presets: 'presets',
  imagePresets: 'imagePresets',
  settings: 'settings',
} as const;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e: IDBVersionChangeEvent) => {
      const d = (e.target as IDBOpenDBRequest).result;
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
      if (!d.objectStoreNames.contains(STORES.imagePresets)) {
        d.createObjectStore(STORES.imagePresets, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(STORES.settings)) {
        d.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
      // v4: assign stable image IDs and explicit anchors to existing records.
      // Must run inside the versionchange transaction so IDs persist exactly once.
      if (e.oldVersion > 0 && e.oldVersion < 4) {
        const upgradeTx = (e.target as IDBOpenDBRequest).transaction;
        if (upgradeTx) {
          rewriteStoreRecords(upgradeTx, STORES.characters, normalizeCharacterRecord);
          rewriteStoreRecords(upgradeTx, STORES.worlds, normalizeWorldRecord);
        }
      }
    };
    req.onsuccess = (e: Event) => {
      db = (e.target as IDBOpenDBRequest).result;
      resolve(db!);
    };
    req.onerror = (e: Event) => reject((e.target as IDBOpenDBRequest).error);
  });
}

function tx(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
  return db!.transaction(storeName, mode).objectStore(storeName);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(storeName: string): Promise<any[]> {
  await open();
  return promisify(tx(storeName).getAll());
}

async function get(storeName: string, id: string | null | undefined): Promise<any> {
  if (id == null || id === '') return undefined;
  await open();
  return promisify(tx(storeName).get(id));
}

async function put(storeName: string, data: any): Promise<IDBValidKey> {
  await open();
  return promisify(tx(storeName, 'readwrite').put(data));
}

async function del(storeName: string, id: string | null | undefined): Promise<void> {
  if (id == null || id === '') return;
  await open();
  await promisify(tx(storeName, 'readwrite').delete(id));
}

async function getByIndex(storeName: string, indexName: string, value: any): Promise<any[]> {
  await open();
  const store = tx(storeName);
  const index = store.index(indexName);
  return promisify(index.getAll(value));
}

function uuid(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

// Settings helpers
async function getSetting<T>(key: string, defaultValue: T | null = null): Promise<T | null> {
  const row = (await get(STORES.settings, key)) as Setting | undefined;
  return row ? row.value : defaultValue;
}

async function setSetting(key: string, value: any): Promise<IDBValidKey> {
  return put(STORES.settings, { key, value });
}

// Image helpers: store as data URLs
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Iterate every record in a store during a versionchange transaction and
 * rewrite records that the normalizer reports as changed. Runs entirely on
 * IDB request callbacks — no promises — as required inside onupgradeneeded.
 */
function rewriteStoreRecords(
  transaction: IDBTransaction,
  storeName: string,
  normalize: (rec: any) => { record: any; changed: boolean },
): void {
  try {
    const store = transaction.objectStore(storeName);
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      try {
        const { record, changed } = normalize(cursor.value);
        if (changed) cursor.update(record);
      } catch (_) {
        /* leave the record untouched rather than aborting the upgrade */
      }
      cursor.continue();
    };
  } catch (_) {
    /* store may not exist yet on fresh databases */
  }
}

/** Pick the anchor image ID for a gallery: primaryImageIndex → first valid → null. */
function pickAnchorImageId(images: ImageRef[], primaryImageIndex: number | undefined): string | null {
  const valid = (images || []).filter((img) => img && img.dataUrl);
  if (valid.length === 0) return null;
  const primary = typeof primaryImageIndex === 'number' ? (images || [])[primaryImageIndex] : null;
  if (primary && primary.dataUrl && primary.id) return primary.id;
  return valid[0].id || null;
}

/**
 * Fully normalize a character record: legacy imageData migration, stable
 * image IDs, and an explicit identity anchor. Pure — does not persist.
 * Returns { record, changed } so callers know whether to write it back.
 */
function normalizeCharacterRecord(char: any): { record: any; changed: boolean } {
  if (!char) return { record: char, changed: false };
  const migrated = migrateCharacter(char);
  let changed = migrated !== char;
  const { images, changed: idsChanged } = ensureImageIds(migrated.images);
  changed = changed || idsChanged;

  let record = idsChanged || changed ? Object.assign({}, migrated, { images }) : migrated;

  const anchorValid =
    record.identityAnchorImageId && images.some((img: any) => img?.id === record.identityAnchorImageId && img.dataUrl);
  if (!anchorValid) {
    const anchorId = pickAnchorImageId(images, record.primaryImageIndex);
    if (record.identityAnchorImageId !== anchorId) {
      record = Object.assign({}, record, { identityAnchorImageId: anchorId });
      changed = true;
    }
  }
  return { record, changed };
}

/**
 * Fully normalize a world record: legacy string[] migration, stable image
 * IDs, normalized location keys, and an explicit default anchor.
 */
function normalizeWorldRecord(world: any): { record: any; changed: boolean } {
  if (!world) return { record: world, changed: false };
  const migrated = migrateWorld(world);
  let changed = migrated !== world;
  let { images, changed: idsChanged } = ensureImageIds(migrated.images);
  changed = changed || idsChanged;

  // Normalize any user-entered location keys to canonical slug form
  let keysChanged = false;
  images = images.map((img: any) => {
    if (!img || img.locationKey == null) return img;
    const norm = normalizeLocationKey(img.locationKey) || null;
    if (norm === img.locationKey) return img;
    keysChanged = true;
    return Object.assign({}, img, { locationKey: norm });
  });
  changed = changed || keysChanged;

  let record = changed ? Object.assign({}, migrated, { images }) : migrated;

  const anchorValid =
    record.defaultAnchorImageId && images.some((img: any) => img?.id === record.defaultAnchorImageId && img.dataUrl);
  if (!anchorValid) {
    const anchorId = pickAnchorImageId(images, record.primaryImageIndex);
    if (record.defaultAnchorImageId !== anchorId) {
      record = Object.assign({}, record, { defaultAnchorImageId: anchorId });
      changed = true;
    }
  }
  return { record, changed };
}

/**
 * Commit a page record and its comic record in one multi-store transaction.
 * Used so continuity snapshots and the comic's current ledger can never
 * diverge: either both writes land or neither does.
 */
async function commitPageAndComic(pageRecord: ComicPage, comicRecord: Comic): Promise<void> {
  await open();
  return new Promise((resolve, reject) => {
    const transaction = db!.transaction([STORES.pages, STORES.comics], 'readwrite');
    transaction.objectStore(STORES.pages).put(pageRecord);
    transaction.objectStore(STORES.comics).put(comicRecord);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

/**
 * Migrate a character record from the legacy single-imageData format to
 * the new images[] format.  Safe to call on already-migrated records.
 * Does NOT persist the change — callers should call DB.put() if they wish
 * to store the migration result.
 */
function migrateCharacter(char: any): any {
  if (!char) return char;
  if (Array.isArray(char.images) && char.images.length > 0) return char;
  const images = char.imageData ? [{ dataUrl: char.imageData, tag: 'default', description: '', embedding: null }] : [];
  return Object.assign({}, char, { images, primaryImageIndex: 0 });
}

/**
 * Migrate a world record from the legacy images: string[] format to
 * the new images: [{dataUrl, tag, description}] format.
 * Safe to call on already-migrated records.
 * Does NOT persist the change — callers should call DB.put() if they wish
 * to store the migration result.
 */
function migrateWorld(world: any): any {
  if (!world) return world;
  const images = (world.images || [])
    .filter((img: any) => img)
    .map((img: any) =>
      typeof img === 'string'
        ? { dataUrl: img, tag: 'establishing', description: '', embedding: null }
        : Object.assign({ embedding: null }, img),
    );
  return Object.assign({}, world, { images, primaryImageIndex: world.primaryImageIndex ?? 0 });
}

// Seed default presets on first run (idempotent — stable IDs prevent duplicates)
// Low, stable timestamps ensure seed presets sort to the bottom of the list (below user-created presets)
const SEED_PRESETS: Preset[] = [
  {
    id: 'seed-preset-balanced',
    name: 'Balanced',
    description: 'Good for general storytelling',
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    systemPrompt:
      'You are a creative comic book writer. Create vivid, engaging comic panels with narration and dialogue.',
    createdAt: 1000000000000,
  },
  {
    id: 'seed-preset-creative',
    name: 'Creative',
    description: 'Higher randomness for unique stories',
    temperature: 1.0,
    topP: 0.95,
    maxTokens: 3000,
    systemPrompt:
      'You are an avant-garde comic book creator. Push boundaries with unexpected plot twists and unique artistic descriptions.',
    createdAt: 1000000000001,
  },
  {
    id: 'seed-preset-precise',
    name: 'Precise',
    description: 'Lower randomness for consistent output',
    temperature: 0.3,
    topP: 0.8,
    maxTokens: 1500,
    systemPrompt:
      'You are a disciplined comic book writer. Create clear, well-structured panels with consistent characterization.',
    createdAt: 1000000000002,
  },
];

// Seed default image style presets on first run (idempotent — stable IDs prevent duplicates)
const SEED_IMAGE_PRESETS: ImagePreset[] = [
  {
    id: 'seed-imgpreset-comic',
    name: 'Comic Book Ink',
    description: 'Classic bold ink comic book style',
    promptPrefix: 'bold ink outlines, comic book art style, halftone shading, dynamic composition, vibrant colors',
    createdAt: 1000000000010,
  },
  {
    id: 'seed-imgpreset-realistic',
    name: 'Photorealistic',
    description: 'Highly detailed photorealistic renders',
    promptPrefix: 'photorealistic, ultra detailed, 8K resolution, cinematic lighting, hyper realistic',
    createdAt: 1000000000011,
  },
  {
    id: 'seed-imgpreset-anime',
    name: 'Anime / Manga',
    description: 'Japanese animation and manga aesthetic',
    promptPrefix: 'anime style, manga art, cel shading, vibrant colors, expressive characters',
    createdAt: 1000000000012,
  },
  {
    id: 'seed-imgpreset-watercolor',
    name: 'Watercolor',
    description: 'Soft painterly watercolor aesthetic',
    promptPrefix: 'watercolor painting, soft edges, gentle color washes, artistic, painterly',
    createdAt: 1000000000013,
  },
  {
    id: 'seed-imgpreset-3d',
    name: '3D Render',
    description: 'Modern 3D CGI aesthetic',
    promptPrefix: '3D render, CGI, volumetric lighting, physically based rendering, high detail, studio quality',
    createdAt: 1000000000014,
  },
];

async function seedDefaults(): Promise<void> {
  for (const p of SEED_PRESETS) {
    const existing = await get(STORES.presets, p.id);
    if (!existing) await put(STORES.presets, p);
  }
  for (const p of SEED_IMAGE_PRESETS) {
    const existing = await get(STORES.imagePresets, p.id);
    if (!existing) await put(STORES.imagePresets, p);
  }
}

async function dedupePresets(): Promise<any[]> {
  const all: any[] = await getAll(STORES.presets);
  const sorted = [...all].sort((a, b) => (b?.updatedAt ?? b?.createdAt ?? 0) - (a?.updatedAt ?? a?.createdAt ?? 0));
  const seen = new Set<string>();
  const unique: any[] = [];
  for (const item of sorted) {
    const key = (item?.name || '').trim().toLowerCase() || item?.id || '';
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  if (unique.length !== all.length) {
    const keepIds = new Set(unique.map((p) => p.id));
    for (const row of all) {
      if (!keepIds.has(row.id)) await del(STORES.presets, row.id);
    }
  }
  return unique;
}
const DB = {
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
  migrateWorld,
  normalizeCharacterRecord,
  normalizeWorldRecord,
  commitPageAndComic,
  seedDefaults,
  dedupePresets,
};
export default DB;
