import type { ClassificationJob, ReferenceAsset } from './references/types.js';

export interface CharacterImportPreview {
  name: string;
  worldId: string;
  validImageCount: number;
  malformedImageCount: number;
  idConflicts: string[];
}

export interface CharacterImportPlan {
  preview: CharacterImportPreview;
  character: Record<string, unknown>;
  references: ReferenceAsset[];
  jobs: ClassificationJob[];
}

export interface CharacterImportOptions {
  worldId: string;
  existingCharacterIds: readonly string[];
  existingReferenceIds: readonly string[];
  newId(): string;
  now: number;
}

export interface CharacterImportDependencies {
  putBatch(writes: readonly (readonly [storeName: string, record: unknown])[]): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function characterFrom(payload: unknown): Record<string, unknown> {
  const root = record(payload);
  const character = record(root?.character) || root;
  if (!character || typeof character.name !== 'string' || !character.name.trim()) {
    throw new Error('Character import must contain a named character');
  }
  return character;
}

function dataUrl(value: unknown): string | null {
  const source = typeof value === 'string' ? value : record(value)?.dataUrl;
  if (typeof source !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(source)) return null;
  const normalized = source.replace(/\s/g, '');
  try {
    atob(normalized.slice(normalized.indexOf(',') + 1));
    return normalized;
  } catch {
    return null;
  }
}

interface SourceImage {
  id: string | null;
  dataUrl: string;
  thumbnailDataUrl?: string;
}

function imageFingerprint(dataUrlValue: string): string {
  const encoded = dataUrlValue.slice(dataUrlValue.indexOf(',') + 1);
  try {
    return atob(encoded);
  } catch {
    return dataUrlValue;
  }
}

function sourceImages(
  payload: unknown,
  character: Record<string, unknown>,
): { valid: SourceImage[]; malformed: number } {
  const root = record(payload);
  const candidates = [
    character.imageData,
    ...(Array.isArray(character.images) ? character.images : []),
    ...(Array.isArray(root?.references) ? root.references : []),
  ];
  const valid: SourceImage[] = [];
  let malformed = 0;
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const image = dataUrl(candidate);
    if (!image) malformed += 1;
    else if (!valid.some((current) => imageFingerprint(current.dataUrl) === imageFingerprint(image))) {
      const source = record(candidate);
      valid.push({
        id: typeof source?.id === 'string' && source.id ? source.id : null,
        dataUrl: image,
        ...(typeof source?.thumbnailDataUrl === 'string' ? { thumbnailDataUrl: source.thumbnailDataUrl } : {}),
      });
    }
  }
  return { valid, malformed };
}

function canonicalCharacter(
  source: Record<string, unknown>,
  id: string,
  worldId: string,
  referenceId: string | null,
  now: number,
) {
  const allowed = [
    'name',
    'genre',
    'role',
    'description',
    'appearance',
    'backstory',
    'powers',
    'defaultVisualState',
    'defaultVisualStateSources',
    'createdAt',
  ];
  const character: Record<string, unknown> = { id, worldId, linkedWorldId: worldId, updatedAt: now };
  for (const key of allowed) if (source[key] !== undefined) character[key] = source[key];
  if (character.createdAt === undefined) character.createdAt = now;
  if (referenceId) character.preferredIdentityReferenceId = referenceId;
  return character;
}

function pendingJob(asset: ReferenceAsset, now: number): ClassificationJob {
  return {
    id: `classification-${asset.id}`,
    assetId: asset.id,
    worldId: asset.worldId,
    status: 'pending',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function planCharacterImport(payload: unknown, options: CharacterImportOptions): CharacterImportPlan {
  const source = characterFrom(payload);
  const sourceId = typeof source.id === 'string' && source.id ? source.id : null;
  const characterConflict = sourceId !== null && options.existingCharacterIds.includes(sourceId);
  const occupiedCharacterIds = new Set(options.existingCharacterIds);
  const occupiedReferenceIds = new Set(options.existingReferenceIds);
  const mint = (occupied: Set<string>) => {
    let id = options.newId();
    while (occupied.has(id)) id = options.newId();
    occupied.add(id);
    return id;
  };
  const id = sourceId && !characterConflict ? sourceId : mint(occupiedCharacterIds);
  const images = sourceImages(payload, source);
  const referenceConflicts: string[] = [];
  const referenceIdMap = new Map<string, string>();
  const references = images.valid.map((image) => {
    const assetId = image.id && !occupiedReferenceIds.has(image.id) ? image.id : mint(occupiedReferenceIds);
    if (image.id) {
      if (assetId !== image.id) referenceConflicts.push(image.id);
      referenceIdMap.set(image.id, assetId);
    }
    const asset: ReferenceAsset = {
      id: assetId,
      worldId: options.worldId,
      dataUrl: image.dataUrl,
      ...(image.thumbnailDataUrl ? { thumbnailDataUrl: image.thumbnailDataUrl } : {}),
      subjectType: 'character',
      use: 'identity',
      characterIds: [id],
      locationId: null,
      facets: {},
      description: '',
      confidence: {},
      provenance: { source: 'migrated', metadata: 'local' },
      classificationState: 'pending',
      acceptedAsIs: false,
      autoUse: true,
      createdAt: options.now,
      updatedAt: options.now,
    };
    return asset;
  });
  return {
    preview: {
      name: source.name as string,
      worldId: options.worldId,
      validImageCount: references.length,
      malformedImageCount: images.malformed,
      idConflicts: [...(characterConflict && sourceId ? [sourceId] : []), ...referenceConflicts],
    },
    character: canonicalCharacter(
      source,
      id,
      options.worldId,
      (typeof source.preferredIdentityReferenceId === 'string'
        ? referenceIdMap.get(source.preferredIdentityReferenceId)
        : undefined) ||
        references[0]?.id ||
        null,
      options.now,
    ),
    references,
    jobs: references.map((asset) => pendingJob(asset, options.now)),
  };
}

/** Commit a validated character import with its references and jobs atomically. */
export async function commitCharacterImport(
  plan: CharacterImportPlan,
  dependencies: CharacterImportDependencies,
): Promise<void> {
  await dependencies.putBatch([
    ['characters', plan.character],
    ...plan.references.map((asset) => ['referenceAssets', asset] as const),
    ...plan.jobs.map((job) => ['classificationJobs', job] as const),
  ]);
}

/** Serialize a character and every canonical reference linked to it. */
export function buildCharacterExport(
  character: Record<string, unknown>,
  references: readonly Record<string, unknown>[],
) {
  const canonicalCharacter = { ...character };
  delete canonicalCharacter.imageData;
  delete canonicalCharacter.images;
  delete canonicalCharacter.primaryImageIndex;
  const canonicalReferences = references.filter((reference) =>
    Array.isArray(reference.characterIds) ? reference.characterIds.includes(character.id) : false,
  );
  return { schemaVersion: 3, character: canonicalCharacter, references: canonicalReferences };
}
