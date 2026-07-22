import type { ClassificationJob, ReferenceAsset } from './types.js';

export interface LegacyMigrationPlan {
  assignments: Record<string, string>;
  unresolved: Array<{ characterId: string; candidateWorldIds: string[] }>;
  worldImageCount: number;
  characterImageCount: number;
}

export interface LegacyImageRecord extends Record<string, unknown> {
  id?: string;
  dataUrl?: string;
  thumbnailDataUrl?: string;
}

export interface LegacyWorldRecord extends Record<string, unknown> {
  id: string;
  images?: Array<LegacyImageRecord | string | null | undefined>;
}

export interface LegacyCharacterRecord extends Record<string, unknown> {
  id: string;
  worldId?: string;
  images?: Array<LegacyImageRecord | string | null | undefined>;
}

export interface LegacyComicRecord extends Record<string, unknown> {
  id: string;
  worldId?: string;
  characterIds?: string[];
  referenceSchemaVersion?: number;
}

export interface LegacyMigrationInput {
  worlds: Array<Pick<LegacyWorldRecord, 'id' | 'images'>>;
  characters: Array<Pick<LegacyCharacterRecord, 'id' | 'images'>>;
  comics: Array<Pick<LegacyComicRecord, 'id' | 'worldId' | 'characterIds'>>;
}

export interface LegacyMigrationProgress {
  completed: number;
  total: number;
  currentSourceId: string | null;
  status: 'running' | 'complete';
  updatedAt: number;
}

export interface LegacyMigrationDependencies {
  listWorlds(): Promise<LegacyWorldRecord[]>;
  listCharacters(): Promise<LegacyCharacterRecord[]>;
  listComics(): Promise<LegacyComicRecord[]>;
  getAsset(id: string): Promise<ReferenceAsset | undefined>;
  putAssetAndJob(asset: ReferenceAsset, job: ClassificationJob): Promise<void>;
  putWorld(world: LegacyWorldRecord): Promise<void>;
  putCharacter(character: LegacyCharacterRecord): Promise<void>;
  putComic(comic: LegacyComicRecord): Promise<void>;
  saveProgress(progress: LegacyMigrationProgress): Promise<void>;
  newId(): string;
  now(): number;
}

interface PreparedImage {
  id: string;
  dataUrl: string;
  thumbnailDataUrl?: string;
}

function imageCount(records: Array<{ images?: Array<unknown> }>): number {
  return records.reduce(
    (total, record) =>
      total +
      (record.images || []).filter(
        (image) =>
          typeof image === 'string' ||
          (typeof image === 'object' && image !== null && typeof (image as { dataUrl?: unknown }).dataUrl === 'string'),
      ).length,
    0,
  );
}

export function planLegacyMigration(input: LegacyMigrationInput): LegacyMigrationPlan {
  const allWorldIds = input.worlds.map((world) => world.id).sort();
  const assignments: Record<string, string> = {};
  const unresolved: LegacyMigrationPlan['unresolved'] = [];

  for (const character of input.characters) {
    const candidateWorldIds = [
      ...new Set(
        input.comics
          .filter((comic) => comic.characterIds?.includes(character.id) && comic.worldId)
          .map((comic) => comic.worldId!),
      ),
    ].sort();
    if (candidateWorldIds.length === 1) {
      assignments[character.id] = candidateWorldIds[0];
    } else {
      unresolved.push({
        characterId: character.id,
        candidateWorldIds: candidateWorldIds.length > 0 ? candidateWorldIds : allWorldIds,
      });
    }
  }

  return {
    assignments,
    unresolved,
    worldImageCount: imageCount(input.worlds),
    characterImageCount: imageCount(input.characters),
  };
}

function preparedImage(image: LegacyImageRecord | string | null | undefined): PreparedImage | null {
  if (typeof image === 'string') return image ? { id: '', dataUrl: image } : null;
  if (!image || typeof image.dataUrl !== 'string' || !image.dataUrl) return null;
  return {
    id: typeof image.id === 'string' ? image.id : '',
    dataUrl: image.dataUrl,
    ...(typeof image.thumbnailDataUrl === 'string' ? { thumbnailDataUrl: image.thumbnailDataUrl } : {}),
  };
}

async function ensureWorldImageIds(
  worlds: LegacyWorldRecord[],
  dependencies: LegacyMigrationDependencies,
): Promise<LegacyWorldRecord[]> {
  const prepared: LegacyWorldRecord[] = [];
  for (const world of worlds) {
    let changed = false;
    const images = (world.images || []).map((source) => {
      const image = preparedImage(source);
      if (!image || image.id) return source;
      changed = true;
      return typeof source === 'string' ? { id: dependencies.newId(), dataUrl: source } : { ...source, id: dependencies.newId() };
    });
    const record = changed ? { ...world, images } : world;
    if (changed) await dependencies.putWorld(record);
    prepared.push(record);
  }
  return prepared;
}

async function ensureCharacterImageIds(
  characters: LegacyCharacterRecord[],
  dependencies: LegacyMigrationDependencies,
): Promise<LegacyCharacterRecord[]> {
  const prepared: LegacyCharacterRecord[] = [];
  for (const character of characters) {
    let changed = false;
    const images = (character.images || []).map((source) => {
      const image = preparedImage(source);
      if (!image || image.id) return source;
      changed = true;
      return typeof source === 'string' ? { id: dependencies.newId(), dataUrl: source } : { ...source, id: dependencies.newId() };
    });
    const record = changed ? { ...character, images } : character;
    if (changed) await dependencies.putCharacter(record);
    prepared.push(record);
  }
  return prepared;
}

function canonicalAsset(
  assetId: string,
  worldId: string,
  characterIds: string[],
  image: PreparedImage,
  now: number,
): ReferenceAsset {
  return {
    id: assetId,
    worldId,
    dataUrl: image.dataUrl,
    ...(image.thumbnailDataUrl ? { thumbnailDataUrl: image.thumbnailDataUrl } : {}),
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

async function preserveAssetBeforeRemoval(
  asset: ReferenceAsset,
  dependencies: LegacyMigrationDependencies,
): Promise<void> {
  const existing = await dependencies.getAsset(asset.id);
  if (existing && existing.dataUrl !== asset.dataUrl) {
    throw new Error(`Reference migration ID collision for "${asset.id}"`);
  }
  if (!existing) await dependencies.putAssetAndJob(asset, pendingJob(asset, asset.createdAt));
  const preserved = await dependencies.getAsset(asset.id);
  if (!preserved || preserved.dataUrl !== asset.dataUrl) {
    throw new Error(`Reference migration could not preserve image "${asset.id}"`);
  }
}

function sourceImageId(source: LegacyImageRecord | string | null | undefined): string | null {
  const image = preparedImage(source);
  return image?.id || null;
}

export async function runLegacyMigration(
  plan: LegacyMigrationPlan,
  assignments: Record<string, string>,
  dependencies: LegacyMigrationDependencies,
): Promise<void> {
  const worlds = await dependencies.listWorlds();
  const worldIds = new Set(worlds.map((world) => world.id));
  const characters = await dependencies.listCharacters();
  const resolvedAssignments = { ...plan.assignments, ...assignments };

  for (const unresolved of plan.unresolved) {
    const selected = resolvedAssignments[unresolved.characterId];
    if (!selected) throw new Error(`Choose one parent world for character "${unresolved.characterId}"`);
  }
  for (const character of characters) {
    const selected = resolvedAssignments[character.id];
    if (!selected) throw new Error(`Choose one parent world for character "${character.id}"`);
    if (!worldIds.has(selected)) throw new Error(`Unknown parent world "${selected}" for character "${character.id}"`);
  }

  const preparedWorlds = await ensureWorldImageIds(worlds, dependencies);
  const preparedCharacters = await ensureCharacterImageIds(characters, dependencies);
  const total = plan.worldImageCount + plan.characterImageCount;
  const remaining = imageCount(preparedWorlds) + imageCount(preparedCharacters);
  let completed = Math.max(0, total - remaining);

  for (const initialWorld of preparedWorlds) {
    let world = initialWorld;
    for (const source of [...(world.images || [])]) {
      const image = preparedImage(source);
      if (!image?.id) continue;
      const asset = canonicalAsset(`legacy-world-${world.id}-${image.id}`, world.id, [], image, dependencies.now());
      await preserveAssetBeforeRemoval(asset, dependencies);
      world = {
        ...world,
        images: (world.images || []).filter((candidate) => sourceImageId(candidate) !== image.id),
      };
      await dependencies.putWorld(world);
      completed += 1;
      await dependencies.saveProgress({
        completed,
        total,
        currentSourceId: image.id,
        status: completed === total ? 'complete' : 'running',
        updatedAt: dependencies.now(),
      });
    }
  }

  for (const initialCharacter of preparedCharacters) {
    let character = initialCharacter;
    const worldId = resolvedAssignments[character.id];
    for (const source of [...(character.images || [])]) {
      const image = preparedImage(source);
      if (!image?.id) continue;
      const asset = canonicalAsset(
        `legacy-character-${character.id}-${image.id}`,
        worldId,
        [character.id],
        image,
        dependencies.now(),
      );
      await preserveAssetBeforeRemoval(asset, dependencies);
      const { imageData: _legacyImageData, ...withoutImageData } = character;
      character = {
        ...withoutImageData,
        worldId,
        images: (character.images || []).filter((candidate) => sourceImageId(candidate) !== image.id),
      };
      await dependencies.putCharacter(character);
      completed += 1;
      await dependencies.saveProgress({
        completed,
        total,
        currentSourceId: image.id,
        status: completed === total ? 'complete' : 'running',
        updatedAt: dependencies.now(),
      });
    }
  }

  for (const comic of await dependencies.listComics()) {
    if (comic.referenceSchemaVersion === 1) continue;
    await dependencies.putComic({ ...comic, referenceSchemaVersion: 1 });
  }
}
