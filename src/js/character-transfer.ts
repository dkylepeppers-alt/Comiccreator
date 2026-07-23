import type {
  ClassificationJob,
  ReferenceAsset,
  ReferenceFacets,
  ReferenceSubjectType,
  ReferenceUse,
} from './references/types.js';

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
  canonical?: Record<string, unknown>;
  alias?: boolean;
}

function imageFingerprint(dataUrlValue: string): string {
  const encoded = dataUrlValue.slice(dataUrlValue.indexOf(',') + 1);
  try {
    return atob(encoded);
  } catch {
    return dataUrlValue;
  }
}

function canonicalAuthority(value: Record<string, unknown> | undefined): number {
  const provenance = record(value?.provenance);
  if (provenance?.metadata === 'manual' || provenance?.metadata === 'accepted' || value?.acceptedAsIs === true) {
    return 2;
  }
  return value ? 1 : 0;
}

function sourceImages(
  payload: unknown,
  character: Record<string, unknown>,
): { valid: SourceImage[]; malformed: number } {
  const root = record(payload);
  const candidates = [
    { value: character.imageData, canonical: false },
    ...(Array.isArray(character.images) ? character.images : []).map((value) => ({ value, canonical: false })),
    ...(Array.isArray(root?.references) ? root.references : []).map((value) => ({ value, canonical: true })),
  ];
  const valid: SourceImage[] = [];
  let malformed = 0;
  for (const candidate of candidates) {
    const { value } = candidate;
    if (value == null || value === '') continue;
    const image = dataUrl(value);
    if (!image) malformed += 1;
    else if (!valid.some((current) => imageFingerprint(current.dataUrl) === imageFingerprint(image))) {
      const source = record(value);
      valid.push({
        id: typeof source?.id === 'string' && source.id ? source.id : null,
        dataUrl: image,
        ...(typeof source?.thumbnailDataUrl === 'string' ? { thumbnailDataUrl: source.thumbnailDataUrl } : {}),
        ...(candidate.canonical && source ? { canonical: source } : {}),
      });
    } else {
      const source = record(value);
      const survivor = valid.find((current) => imageFingerprint(current.dataUrl) === imageFingerprint(image));
      if (source && survivor && typeof source.id === 'string' && source.id) {
        if (candidate.canonical && canonicalAuthority(source) > canonicalAuthority(survivor.canonical)) {
          survivor.canonical = { ...(survivor.canonical || {}), ...source };
          if (typeof source.thumbnailDataUrl === 'string') survivor.thumbnailDataUrl = source.thumbnailDataUrl;
        }
        // Preserve a later canonical alias so its character relationship can be remapped to the surviving bytes.
        valid.push({
          id: source.id,
          dataUrl: image,
          alias: true,
        });
      }
    }
  }
  return { valid, malformed };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function canonicalCharacter(source: Record<string, unknown>, id: string, worldId: string, now: number) {
  const character: Record<string, unknown> = {
    id,
    worldId,
    linkedWorldId: worldId,
    name: source.name,
    createdAt: typeof source.createdAt === 'number' && Number.isFinite(source.createdAt) ? source.createdAt : now,
    updatedAt: now,
  };
  for (const key of ['genre', 'role', 'description', 'appearance', 'backstory', 'powers'] as const) {
    const value = stringValue(source[key]);
    if (value !== undefined) character[key] = value;
  }
  const sourceDefaults = record(source.defaultVisualState);
  if (sourceDefaults) {
    const defaults: Record<string, unknown> = {};
    for (const key of ['wardrobeDescription', 'hairState'] as const) {
      const value = stringValue(sourceDefaults[key]);
      if (value !== undefined) defaults[key] = value;
    }
    for (const key of ['carriedItems', 'injuries', 'temporaryChanges'] as const) {
      const value = stringList(sourceDefaults[key]);
      if (value !== undefined) defaults[key] = value;
    }
    character.defaultVisualState = defaults;
  }
  const sourceDefaultsSources = record(source.defaultVisualStateSources);
  if (sourceDefaultsSources) {
    const sources: Record<string, 'local' | 'manual'> = {};
    for (const key of ['wardrobeDescription', 'hairState', 'carriedItems', 'injuries', 'temporaryChanges'] as const) {
      const value = sourceDefaultsSources[key];
      if (value === 'local' || value === 'manual') sources[key] = value;
    }
    character.defaultVisualStateSources = sources;
  }
  return character;
}

const SUBJECT_TYPES = new Set<ReferenceSubjectType>(['character', 'location', 'interaction', 'prop', 'style']);
const REFERENCE_USES = new Set<ReferenceUse>([
  'identity',
  'appearance',
  'expression',
  'pose',
  'action',
  'establishing',
  'spatial',
  'landmark',
  'detail',
  'relationship',
  'design',
  'state',
  'rendering',
]);
const FACET_ENUMS = {
  framing: new Set([
    'extreme-close-up',
    'close-up',
    'medium-close-up',
    'medium',
    'three-quarter',
    'full-body',
    'wide',
    'establishing',
    'detail',
  ]),
  cameraElevation: new Set(['eye-level', 'high', 'low', 'overhead', 'aerial', 'ground-level']),
  viewDirection: new Set([
    'front',
    'three-quarter-front',
    'left-profile',
    'right-profile',
    'three-quarter-rear',
    'rear',
  ]),
  identityCoverage: new Set(['face', 'upper-body', 'full-body']),
  spaceType: new Set(['interior', 'exterior', 'threshold']),
  timeOfDay: new Set(['dawn', 'morning', 'midday', 'afternoon', 'dusk', 'night']),
} as const;

function canonicalFacets(value: unknown): ReferenceFacets {
  const source = record(value);
  if (!source) return {};
  const facets: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(FACET_ENUMS)) {
    const candidate = source[key];
    if (typeof candidate === 'string' && values.has(candidate as never)) facets[key] = candidate;
  }
  for (const key of [
    'interactionType',
    'spatialArrangement',
    'lighting',
    'visibility',
    'appearanceState',
    'expression',
    'pose',
    'activity',
    'weather',
    'season',
    'physicalContact',
  ]) {
    const candidate = stringValue(source[key]);
    if (candidate !== undefined) facets[key] = candidate;
  }
  const heldProps = stringList(source.heldProps);
  if (heldProps !== undefined) facets.heldProps = heldProps;
  const screenPositions = record(source.screenPositions);
  if (screenPositions) {
    const positions = Object.fromEntries(
      Object.entries(screenPositions).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    if (Object.keys(positions).length) facets.screenPositions = positions;
  }
  return facets as ReferenceFacets;
}

function canonicalConfidence(value: unknown): ReferenceAsset['confidence'] {
  const source = record(value);
  if (!source) return {};
  return Object.fromEntries(
    ['subject', 'links', 'use', 'facets'].flatMap((key) => {
      const candidate = source[key];
      return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1
        ? [[key, candidate]]
        : [];
    }),
  ) as ReferenceAsset['confidence'];
}

function canonicalReferenceAsset(image: SourceImage, id: string, worldId: string, characterId: string, now: number) {
  const asset: ReferenceAsset = {
    id,
    worldId,
    dataUrl: image.dataUrl,
    ...(image.thumbnailDataUrl ? { thumbnailDataUrl: image.thumbnailDataUrl } : {}),
    subjectType: 'character',
    use: 'identity',
    characterIds: [characterId],
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
  const canonical = image.canonical;
  if (!canonical) return asset;
  const subjectType = canonical.subjectType;
  if (typeof subjectType === 'string' && SUBJECT_TYPES.has(subjectType as ReferenceSubjectType)) {
    asset.subjectType = subjectType as ReferenceSubjectType;
  }
  const use = canonical.use;
  if (typeof use === 'string' && REFERENCE_USES.has(use as ReferenceUse)) asset.use = use as ReferenceUse;
  asset.facets = canonicalFacets(canonical.facets);
  asset.description = stringValue(canonical.description) || '';
  asset.confidence = canonicalConfidence(canonical.confidence);
  const proposedCharacterNames = stringList(canonical.proposedCharacterNames);
  if (proposedCharacterNames !== undefined) asset.proposedCharacterNames = proposedCharacterNames;
  const proposedLocationName = canonical.proposedLocationName;
  if (proposedLocationName === null) asset.proposedLocationName = null;
  else if (typeof proposedLocationName === 'string') asset.proposedLocationName = proposedLocationName;
  const provenance = record(canonical.provenance);
  if (
    provenance &&
    (provenance.source === 'uploaded' || provenance.source === 'generated' || provenance.source === 'migrated') &&
    (provenance.metadata === 'local' || provenance.metadata === 'manual' || provenance.metadata === 'accepted')
  ) {
    asset.provenance = provenance as ReferenceAsset['provenance'];
  }
  if (
    canonical.classificationState === 'pending' ||
    canonical.classificationState === 'ready' ||
    canonical.classificationState === 'needs-review' ||
    canonical.classificationState === 'could-not-classify'
  ) {
    asset.classificationState = canonical.classificationState;
  }
  if (typeof canonical.acceptedAsIs === 'boolean') asset.acceptedAsIs = canonical.acceptedAsIs;
  if (typeof canonical.autoUse === 'boolean') asset.autoUse = canonical.autoUse;
  if (
    typeof canonical.classificationVersion === 'number' &&
    Number.isInteger(canonical.classificationVersion) &&
    canonical.classificationVersion >= 0
  ) {
    asset.classificationVersion = canonical.classificationVersion;
  }
  if (typeof canonical.createdAt === 'number' && Number.isFinite(canonical.createdAt)) {
    asset.createdAt = canonical.createdAt;
  }
  if (typeof canonical.updatedAt === 'number' && Number.isFinite(canonical.updatedAt)) {
    asset.updatedAt = canonical.updatedAt;
  }
  return asset;
}

function pendingJob(asset: ReferenceAsset, now: number): ClassificationJob {
  return {
    id: `classification-${asset.id}`,
    assetId: asset.id,
    worldId: asset.worldId,
    status: 'pending',
    attemptCount: 0,
    assetVersion: asset.classificationVersion,
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
  const mint = (occupied: Set<string>, reserved = new Set<string>()) => {
    let id = options.newId();
    while (occupied.has(id) || reserved.has(id)) id = options.newId();
    occupied.add(id);
    return id;
  };
  const id = sourceId && !characterConflict ? sourceId : mint(occupiedCharacterIds);
  const images = sourceImages(payload, source);
  const incomingReferenceIds = new Set(images.valid.flatMap((image) => (image.id ? [image.id] : [])));
  const referenceConflicts: string[] = [];
  const referenceIdMap = new Map<string, string>();
  const assetIdByFingerprint = new Map<string, string>();
  const references: ReferenceAsset[] = [];
  for (const image of images.valid) {
    const fingerprint = imageFingerprint(image.dataUrl);
    const survivingId = assetIdByFingerprint.get(fingerprint);
    if (image.alias && survivingId) {
      if (image.id && !referenceIdMap.has(image.id)) referenceIdMap.set(image.id, survivingId);
      continue;
    }
    const assetId =
      image.id && !occupiedReferenceIds.has(image.id) ? image.id : mint(occupiedReferenceIds, incomingReferenceIds);
    if (image.id && assetId === image.id) occupiedReferenceIds.add(assetId);
    if (image.id) {
      if (assetId !== image.id) referenceConflicts.push(image.id);
      if (!referenceIdMap.has(image.id)) referenceIdMap.set(image.id, assetId);
    }
    const asset = canonicalReferenceAsset(image, assetId, options.worldId, id, options.now);
    references.push(asset);
    assetIdByFingerprint.set(fingerprint, assetId);
  }
  const character = canonicalCharacter(source, id, options.worldId, options.now);
  const preferredId =
    typeof source.preferredIdentityReferenceId === 'string'
      ? referenceIdMap.get(source.preferredIdentityReferenceId)
      : references[0]?.id;
  if (preferredId) character.preferredIdentityReferenceId = preferredId;
  if (typeof source.identityAnchorImageId === 'string') {
    const identityAnchorId = referenceIdMap.get(source.identityAnchorImageId);
    if (identityAnchorId) character.identityAnchorImageId = identityAnchorId;
  }
  return {
    preview: {
      name: source.name as string,
      worldId: options.worldId,
      validImageCount: references.length,
      malformedImageCount: images.malformed,
      idConflicts: [...(characterConflict && sourceId ? [sourceId] : []), ...referenceConflicts],
    },
    character,
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
