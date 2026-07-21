/**
 * Typed, DB/DOM-free backup import service.
 *
 * Extracted from `pages/settings.ts`'s `importData()` so the parse/validate/write logic can be
 * unit-tested and strictly typed independently of the file-picker/toast/refresh UI concerns, which
 * stay in `settings.ts`. Backward compatible with the existing backup file shape: no new schema
 * version is introduced, and the legacy `Invalid <collection> data` error messages are preserved
 * verbatim.
 */

/** A single record from an imported collection. Legacy backups only guarantee a truthy `id`. */
export interface BackupRecord {
  readonly id: unknown;
  readonly [key: string]: unknown;
}

type CollectionKey = 'characters' | 'worlds' | 'comics' | 'pages' | 'presets' | 'imagePresets';

/** Parsed, validated backup contents. Unknown top-level properties (e.g. `exportedAt`) are dropped. */
export interface BackupPayload {
  readonly characters?: readonly BackupRecord[];
  readonly worlds?: readonly BackupRecord[];
  readonly comics?: readonly BackupRecord[];
  readonly pages?: readonly BackupRecord[];
  readonly presets?: readonly BackupRecord[];
  readonly imagePresets?: readonly BackupRecord[];
}

/** Mutable build-time counterpart of {@link BackupPayload}, used only while assembling it. */
type MutableBackupPayload = { [K in CollectionKey]?: readonly BackupRecord[] };

/** Store names the import writes to, supplied by the caller (`DB.STORES` in production). */
export interface BackupImportStoreNames {
  readonly characters: string;
  readonly worlds: string;
  readonly comics: string;
  readonly pages: string;
  readonly presets: string;
  readonly imagePresets: string;
}

/** Normalizer result shape shared by `DB.normalizeCharacterRecord`/`DB.normalizeWorldRecord`. */
export interface BackupRecordNormalizationResult {
  readonly record: unknown;
}

/**
 * Everything `importBackup` needs from the outside world. Deliberately has no DOM or `App`
 * dependency so it can run in a plain unit test.
 */
export interface BackupImportDependencies {
  readonly stores: BackupImportStoreNames;
  readonly put: (storeName: string, record: unknown) => Promise<unknown>;
  readonly normalizeCharacter: (record: unknown) => BackupRecordNormalizationResult;
  readonly normalizeWorld: (record: unknown) => BackupRecordNormalizationResult;
}

interface CollectionDescriptor {
  readonly key: CollectionKey;
  readonly storeKey: keyof BackupImportStoreNames;
  readonly normalize?: (record: BackupRecord, dependencies: BackupImportDependencies) => unknown;
}

/**
 * One descriptor per supported collection, in the exact legacy write order:
 * characters, worlds, comics, pages, presets, imagePresets.
 */
const COLLECTION_DESCRIPTORS: readonly CollectionDescriptor[] = [
  {
    key: 'characters',
    storeKey: 'characters',
    normalize: (record, dependencies) => dependencies.normalizeCharacter(record).record,
  },
  {
    key: 'worlds',
    storeKey: 'worlds',
    normalize: (record, dependencies) => dependencies.normalizeWorld(record).record,
  },
  { key: 'comics', storeKey: 'comics' },
  { key: 'pages', storeKey: 'pages' },
  { key: 'presets', storeKey: 'presets' },
  { key: 'imagePresets', storeKey: 'imagePresets' },
];

function hasTruthyId(item: unknown): item is BackupRecord {
  return typeof item === 'object' && item !== null && Boolean((item as Record<string, unknown>).id);
}

/** Mirrors the legacy `validArray`: an array whose every entry is an object with a truthy `id`. */
function isValidCollection(value: unknown): value is readonly BackupRecord[] {
  return Array.isArray(value) && value.every(hasTruthyId);
}

/**
 * Parse and validate a raw backup file's text content.
 *
 * Every present collection is validated (in write order) before the payload is returned — no
 * writes happen here at all, so this doubles as the "validate everything before any write" phase.
 * Throws the exact legacy message (e.g. `Invalid characters data`) for the first invalid
 * collection found, and lets `JSON.parse`'s `SyntaxError` propagate untouched for malformed JSON.
 */
export function parseBackup(text: string): BackupPayload {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null) {
    // Matches the original inline importData(), where `data.characters` on a null `data` threw a
    // TypeError immediately, caught by the caller and surfaced as the "Invalid backup file" toast.
    // Array/primitive roots deliberately still fall back to `{}` below (unchanged legacy behavior).
    throw new Error('Invalid backup file: root is null');
  }
  const root: Record<string, unknown> =
    typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};

  const payload: MutableBackupPayload = {};
  for (const descriptor of COLLECTION_DESCRIPTORS) {
    const value = root[descriptor.key];
    if (!value) continue; // absent, null, or otherwise falsy: treated as "not included", like the legacy code
    if (!isValidCollection(value)) {
      throw new Error(`Invalid ${descriptor.key} data`);
    }
    payload[descriptor.key] = value;
  }
  return payload;
}

/**
 * Write a parsed backup payload to storage.
 *
 * Writes present collections sequentially in descriptor order (characters, worlds, comics, pages,
 * presets, imagePresets), and records within a collection in their original array order —
 * matching the legacy `importData()`'s `for` loops exactly. Character/world records are run
 * through the supplied normalizers first (legacy files may predate stable image IDs/anchors). Any
 * normalizer or write failure rejects immediately and stops further writes.
 */
export async function importBackup(payload: BackupPayload, dependencies: BackupImportDependencies): Promise<void> {
  for (const descriptor of COLLECTION_DESCRIPTORS) {
    const records = payload[descriptor.key];
    if (!records) continue;
    const storeName = dependencies.stores[descriptor.storeKey];
    for (const record of records) {
      const toWrite = descriptor.normalize ? descriptor.normalize(record, dependencies) : record;
      await dependencies.put(storeName, toWrite);
    }
  }
}
