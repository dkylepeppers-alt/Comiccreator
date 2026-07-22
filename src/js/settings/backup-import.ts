/** Typed, DOM-free schema-v2 backup transfer and legacy conversion. */
import { parseReferenceClassification } from '../references/schema.js';

export interface BackupRecord {
  readonly id: unknown;
  readonly [key: string]: unknown;
}

type CollectionKey =
  | 'worlds'
  | 'locations'
  | 'characters'
  | 'referenceAssets'
  | 'classificationJobs'
  | 'comics'
  | 'pages'
  | 'presets'
  | 'imagePresets';

export interface LegacyBackupPayload {
  readonly schemaVersion?: undefined;
  readonly exportedAt?: string;
  readonly worlds?: readonly BackupRecord[];
  readonly characters?: readonly BackupRecord[];
  readonly comics?: readonly BackupRecord[];
  readonly pages?: readonly BackupRecord[];
  readonly presets?: readonly BackupRecord[];
  readonly imagePresets?: readonly BackupRecord[];
}

export interface BackupPayloadV2 {
  readonly schemaVersion: 2;
  readonly worlds: readonly BackupRecord[];
  readonly locations: readonly BackupRecord[];
  readonly characters: readonly BackupRecord[];
  readonly referenceAssets: readonly BackupRecord[];
  readonly classificationJobs: readonly BackupRecord[];
  readonly comics: readonly BackupRecord[];
  readonly pages: readonly BackupRecord[];
  readonly presets: readonly BackupRecord[];
  readonly imagePresets: readonly BackupRecord[];
  readonly exportedAt: string;
}

export type BackupPayload = LegacyBackupPayload | BackupPayloadV2;
type MutableLegacyPayload = { -readonly [K in keyof LegacyBackupPayload]?: LegacyBackupPayload[K] };
export type BackupWrite = readonly [storeName: string, record: unknown];

export interface BackupImportStoreNames {
  readonly worlds: string;
  readonly locations: string;
  readonly characters: string;
  readonly referenceAssets: string;
  readonly classificationJobs: string;
  readonly comics: string;
  readonly pages: string;
  readonly presets: string;
  readonly imagePresets: string;
}

export interface BackupRecordNormalizationResult {
  readonly record: unknown;
}

export interface BackupImportDependencies {
  readonly stores: BackupImportStoreNames;
  readonly getAll?: (storeName: string) => Promise<unknown[]>;
  readonly put: (storeName: string, record: unknown) => Promise<unknown>;
  /** Production supplies one IndexedDB transaction for the complete validated write set. */
  readonly putBatch?: (writes: readonly BackupWrite[]) => Promise<void>;
  readonly normalizeCharacter: (record: unknown) => BackupRecordNormalizationResult;
  readonly normalizeWorld: (record: unknown) => BackupRecordNormalizationResult;
  readonly now?: () => number;
}

const V2_COLLECTIONS: readonly CollectionKey[] = [
  'worlds',
  'locations',
  'characters',
  'referenceAssets',
  'classificationJobs',
  'comics',
  'pages',
  'presets',
  'imagePresets',
];

const LEGACY_COLLECTIONS = ['characters', 'worlds', 'comics', 'pages', 'presets', 'imagePresets'] as const;
const FORBIDDEN_FIELDS = new Set([
  'embedding',
  'embeddingText',
  'referenceKey',
  'locationKey',
  'referenceClassifications',
  'tag',
]);

function hasTruthyId(item: unknown): item is BackupRecord {
  return typeof item === 'object' && item !== null && Boolean((item as Record<string, unknown>).id);
}

function isValidCollection(value: unknown): value is readonly BackupRecord[] {
  return Array.isArray(value) && value.every(hasTruthyId);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateCanonical(payload: BackupPayloadV2): void {
  const uniqueIds = (key: CollectionKey): Set<string> => {
    const ids = payload[key].map(({ id }) => String(id));
    if (new Set(ids).size !== ids.length) throw new Error(`Invalid ${key} data`);
    return new Set(ids);
  };
  const worldIds = uniqueIds('worlds');
  const characterIds = uniqueIds('characters');
  const locationIds = uniqueIds('locations');
  const assetIds = uniqueIds('referenceAssets');
  uniqueIds('classificationJobs');
  const comicIds = uniqueIds('comics');
  for (const key of ['pages', 'presets', 'imagePresets'] as const) uniqueIds(key);

  if (payload.worlds.some((item) => !isString(item.name))) throw new Error('Invalid worlds data');
  const locationWorlds = new Map<string, string>();
  for (const item of payload.locations) {
    if (
      !isString(item.worldId) ||
      !worldIds.has(item.worldId) ||
      !isString(item.name) ||
      !Array.isArray(item.aliases) ||
      item.aliases.some((alias) => typeof alias !== 'string')
    ) {
      throw new Error('Invalid locations data');
    }
    locationWorlds.set(String(item.id), item.worldId);
  }
  const characterWorlds = new Map<string, string>();
  for (const item of payload.characters) {
    if (!isString(item.worldId) || !worldIds.has(item.worldId) || !isString(item.name)) {
      throw new Error('Invalid characters data');
    }
    characterWorlds.set(String(item.id), item.worldId);
  }

  const classificationStates = new Set(['pending', 'ready', 'needs-review']);
  const provenanceSources = new Set(['uploaded', 'generated', 'migrated']);
  const provenanceMetadata = new Set(['local', 'manual', 'accepted']);
  const assetWorlds = new Map<string, string>();
  for (const item of payload.referenceAssets) {
    const provenance = isObject(item.provenance) ? item.provenance : null;
    if (
      !isString(item.worldId) ||
      !worldIds.has(item.worldId) ||
      !isString(item.dataUrl) ||
      (item.thumbnailDataUrl !== undefined && typeof item.thumbnailDataUrl !== 'string') ||
      !Array.isArray(item.characterIds) ||
      item.characterIds.some(
        (id) => !isString(id) || !characterIds.has(id) || characterWorlds.get(id) !== item.worldId,
      ) ||
      (item.locationId != null &&
        (!isString(item.locationId) || locationWorlds.get(item.locationId) !== item.worldId)) ||
      !isObject(item.facets) ||
      typeof item.description !== 'string' ||
      !isObject(item.confidence) ||
      !provenance ||
      !provenanceSources.has(String(provenance.source)) ||
      !provenanceMetadata.has(String(provenance.metadata)) ||
      !classificationStates.has(String(item.classificationState)) ||
      typeof item.acceptedAsIs !== 'boolean' ||
      typeof item.autoUse !== 'boolean' ||
      !isTimestamp(item.createdAt) ||
      !isTimestamp(item.updatedAt)
    ) {
      throw new Error('Invalid referenceAssets data');
    }
    const classificationCandidate =
      item.subjectType === null
        ? { ...item, subjectType: 'style', use: 'rendering', description: item.description || undefined }
        : item;
    if (
      (item.subjectType === null && item.use !== null) ||
      !parseReferenceClassification(classificationCandidate, {
        worldId: item.worldId,
        characterIds,
        locationIds,
      })
    ) {
      throw new Error('Invalid referenceAssets data');
    }
    assetWorlds.set(String(item.id), item.worldId);
  }
  const jobStatuses = new Set(['pending', 'running', 'complete', 'failed']);
  if (
    payload.classificationJobs.some(
      (item) =>
        !isString(item.assetId) ||
        !assetIds.has(item.assetId) ||
        !isString(item.worldId) ||
        !worldIds.has(item.worldId) ||
        assetWorlds.get(item.assetId) !== item.worldId ||
        !jobStatuses.has(String(item.status)) ||
        !Number.isInteger(item.attemptCount) ||
        Number(item.attemptCount) < 0 ||
        (item.lastError !== undefined && typeof item.lastError !== 'string') ||
        !isTimestamp(item.createdAt) ||
        !isTimestamp(item.updatedAt),
    )
  )
    throw new Error('Invalid classificationJobs data');
  if (payload.comics.some((item) => item.referenceSchemaVersion !== 1 && item.referenceSchemaVersion !== 2)) {
    throw new Error('Invalid comics data');
  }
  if (payload.pages.some((item) => !isString(item.comicId) || !comicIds.has(item.comicId))) {
    throw new Error('Invalid pages data');
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FORBIDDEN_FIELDS.has(key))
      .map(([key, item]) => [key, cleanValue(item)]),
  );
}

function cleanEntity(value: BackupRecord): BackupRecord {
  const cleaned = record(cleanValue(value));
  delete cleaned.images;
  delete cleaned.imageData;
  delete cleaned.primaryImageIndex;
  return cleaned as BackupRecord;
}

export function parseBackup(text: string): BackupPayload {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null) throw new Error('Invalid backup file: root is null');
  const root = record(parsed);
  const schemaVersion = root.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== 2) {
    throw new Error(`Unsupported backup schema version "${String(schemaVersion)}"`);
  }

  if (schemaVersion === 2) {
    const payload: Record<string, unknown> = {
      schemaVersion: 2,
      exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : '',
    };
    for (const key of V2_COLLECTIONS) {
      const value = root[key] ?? [];
      if (!isValidCollection(value)) throw new Error(`Invalid ${key} data`);
      payload[key] = value;
    }
    const canonical = payload as unknown as BackupPayloadV2;
    validateCanonical(canonical);
    return canonical;
  }

  const payload: MutableLegacyPayload = {};
  for (const key of LEGACY_COLLECTIONS) {
    const value = root[key];
    if (!value) continue;
    if (!isValidCollection(value)) throw new Error(`Invalid ${key} data`);
    payload[key] = value;
  }
  return payload as LegacyBackupPayload;
}

function imageRecords(value: BackupRecord): Array<Record<string, unknown>> {
  const source = record(value);
  const images = Array.isArray(source.images) ? source.images : [];
  if (typeof source.imageData === 'string' && source.imageData) images.unshift(source.imageData);
  return images.flatMap((image) => {
    if (typeof image === 'string') return image ? [{ dataUrl: image }] : [];
    const item = record(image);
    return typeof item.dataUrl === 'string' && item.dataUrl ? [item] : [];
  });
}

function characterWorldId(
  character: BackupRecord,
  worlds: readonly BackupRecord[],
  comics: readonly BackupRecord[],
): string | null {
  const direct = record(character).worldId;
  if (typeof direct === 'string' && direct) return direct;
  const candidates = [
    ...new Set(
      comics.flatMap((comic) => {
        const item = record(comic);
        return Array.isArray(item.characterIds) &&
          item.characterIds.includes(character.id) &&
          typeof item.worldId === 'string'
          ? [item.worldId]
          : [];
      }),
    ),
  ];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 && worlds.length === 1 && typeof worlds[0].id === 'string') return worlds[0].id;
  return null;
}

function migratedAsset(
  id: string,
  worldId: string,
  characterIds: string[],
  source: Record<string, unknown>,
  now: number,
): BackupRecord {
  return {
    id,
    worldId,
    dataUrl: source.dataUrl,
    ...(typeof source.thumbnailDataUrl === 'string' ? { thumbnailDataUrl: source.thumbnailDataUrl } : {}),
    subjectType: null,
    use: null,
    characterIds,
    locationId: null,
    facets: {},
    description: '',
    confidence: {},
    provenance: { source: 'migrated', metadata: 'local' },
    classificationState: 'pending',
    acceptedAsIs: false,
    autoUse: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function convertLegacyBackup(payload: LegacyBackupPayload, now = Date.now()): BackupPayloadV2 {
  const worlds = payload.worlds || [];
  const characters = payload.characters || [];
  const comics = payload.comics || [];
  const assets: BackupRecord[] = [];
  const jobs: BackupRecord[] = [];
  const assetIds = new Set<string>();

  function addAsset(asset: BackupRecord): void {
    const id = String(asset.id);
    if (assetIds.has(id)) throw new Error(`Duplicate migrated reference ID "${id}"`);
    assetIds.add(id);
    assets.push(asset);
    jobs.push({
      id: `classification-${id}`,
      assetId: id,
      worldId: asset.worldId,
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const world of worlds) {
    imageRecords(world).forEach((image, index) => {
      const id = typeof image.id === 'string' && image.id ? image.id : `legacy-world-${String(world.id)}-${index}`;
      addAsset(migratedAsset(id, String(world.id), [], image, now));
    });
  }

  const migratedCharacters = characters.map((character) => {
    const worldId = characterWorldId(character, worlds, comics);
    if (!worldId)
      throw new Error(`Choose one parent world for legacy character "${String(character.id)}" before import`);
    imageRecords(character).forEach((image, index) => {
      const id =
        typeof image.id === 'string' && image.id ? image.id : `legacy-character-${String(character.id)}-${index}`;
      addAsset(migratedAsset(id, worldId, [String(character.id)], image, now));
    });
    return { ...cleanEntity(character), worldId };
  });

  return {
    schemaVersion: 2,
    worlds: worlds.map(cleanEntity),
    locations: [],
    characters: migratedCharacters,
    referenceAssets: assets,
    classificationJobs: jobs,
    comics: comics.map(
      (comic) => ({ ...record(cleanValue(comic)), id: comic.id, referenceSchemaVersion: 1 }) as unknown as BackupRecord,
    ),
    pages: (payload.pages || []).map((item) => cleanValue(item) as BackupRecord),
    presets: (payload.presets || []).map((item) => cleanValue(item) as BackupRecord),
    imagePresets: (payload.imagePresets || []).map((item) => cleanValue(item) as BackupRecord),
    exportedAt: new Date(now).toISOString(),
  };
}

export async function buildBackup(
  dependencies: BackupImportDependencies,
  exportedAt = new Date(),
): Promise<BackupPayloadV2> {
  if (!dependencies.getAll) throw new Error('Backup export requires getAll');
  const read = async (key: CollectionKey): Promise<BackupRecord[]> =>
    (await dependencies.getAll!(dependencies.stores[key])).map((value) =>
      key === 'worlds' || key === 'characters'
        ? cleanEntity(value as BackupRecord)
        : (cleanValue(value) as BackupRecord),
    );
  return {
    schemaVersion: 2,
    worlds: await read('worlds'),
    locations: await read('locations'),
    characters: await read('characters'),
    referenceAssets: await read('referenceAssets'),
    classificationJobs: await read('classificationJobs'),
    comics: await read('comics'),
    pages: await read('pages'),
    presets: await read('presets'),
    imagePresets: await read('imagePresets'),
    exportedAt: exportedAt.toISOString(),
  };
}

function isV2(payload: BackupPayload): payload is BackupPayloadV2 {
  return payload.schemaVersion === 2;
}

function normalizedWrites(payload: BackupPayloadV2, dependencies: BackupImportDependencies): BackupWrite[] {
  return V2_COLLECTIONS.flatMap((key) =>
    payload[key].map((item) => {
      const normalized =
        key === 'characters'
          ? dependencies.normalizeCharacter(item).record
          : key === 'worlds'
            ? dependencies.normalizeWorld(item).record
            : item;
      return [dependencies.stores[key], normalized] as const;
    }),
  );
}

export async function importBackup(payload: BackupPayload, dependencies: BackupImportDependencies): Promise<void> {
  const canonical = isV2(payload) ? payload : convertLegacyBackup(payload, dependencies.now?.());
  const writes = normalizedWrites(canonical, dependencies);
  if (dependencies.putBatch) {
    await dependencies.putBatch(writes);
    return;
  }
  for (const [storeName, item] of writes) await dependencies.put(storeName, item);
}
