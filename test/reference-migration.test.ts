import { describe, expect, it, vi } from 'vitest';
import {
  planLegacyMigration,
  runLegacyMigration,
  type LegacyMigrationDependencies,
} from '../src/js/references/legacy-migration.js';
import type { ClassificationJob, ReferenceAsset } from '../src/js/references/types.js';

function migrationState() {
  const worlds = [
    {
      id: 'w1',
      name: 'World',
      images: [
        {
          id: 'world-image',
          dataUrl: 'data:image/png;base64,WORLD',
          thumbnailDataUrl: 'data:image/png;base64,THUMB',
          tag: 'establishing',
          embedding: [1, 2, 3],
          locationKey: 'old-yard',
        },
      ],
    },
  ];
  const characters = [
    {
      id: 'mara',
      name: 'Mara',
      images: [
        {
          id: 'character-image',
          dataUrl: 'data:image/png;base64,MARA',
          tag: 'front-view',
          referenceKey: 'front',
          referenceClassifications: { old: true },
          embedding: [4, 5, 6],
        },
      ],
    },
  ];
  const comics = [{ id: 'comic-1', worldId: 'w1', characterIds: ['mara'] }];
  const assets = new Map<string, ReferenceAsset>();
  const jobs = new Map<string, ClassificationJob>();
  const events: string[] = [];
  let id = 0;

  const dependencies: LegacyMigrationDependencies = {
    listWorlds: async () => structuredClone(worlds),
    listCharacters: async () => structuredClone(characters),
    listComics: async () => structuredClone(comics),
    getAsset: async (assetId) => assets.get(assetId),
    putAssetAndJob: async (asset, job) => {
      events.push(`asset:${asset.id}`);
      assets.set(asset.id, structuredClone(asset));
      jobs.set(job.id, structuredClone(job));
    },
    putWorld: async (world) => {
      events.push(`world:${world.id}`);
      worlds.splice(
        worlds.findIndex((candidate) => candidate.id === world.id),
        1,
        structuredClone(world),
      );
    },
    putCharacter: async (character) => {
      events.push(`character:${character.id}`);
      characters.splice(
        characters.findIndex((candidate) => candidate.id === character.id),
        1,
        structuredClone(character),
      );
    },
    putComic: async (comic) => {
      events.push(`comic:${comic.id}`);
      comics.splice(
        comics.findIndex((candidate) => candidate.id === comic.id),
        1,
        structuredClone(comic),
      );
    },
    saveProgress: vi.fn(async (progress) => {
      events.push(`progress:${progress.completed}`);
    }),
    newId: () => `generated-${++id}`,
    now: () => 100,
  };

  return { worlds, characters, comics, assets, jobs, events, dependencies };
}

describe('legacy reference migration planning', () => {
  it('auto-assigns one-world characters and requests ambiguous assignments', () => {
    const plan = planLegacyMigration({
      worlds: [{ id: 'w1' }, { id: 'w2' }],
      characters: [
        { id: 'solo', images: [] },
        { id: 'shared', images: [] },
      ],
      comics: [
        { id: 'c1', worldId: 'w1', characterIds: ['solo', 'shared'] },
        { id: 'c2', worldId: 'w2', characterIds: ['shared'] },
      ],
    });

    expect(plan.assignments.solo).toBe('w1');
    expect(plan.unresolved).toEqual([{ characterId: 'shared', candidateWorldIds: ['w1', 'w2'] }]);
    expect(plan.worldImageCount).toBe(0);
    expect(plan.characterImageCount).toBe(0);
  });

  it('offers every world for characters with no historical world', () => {
    const plan = planLegacyMigration({
      worlds: [{ id: 'w2' }, { id: 'w1' }],
      characters: [{ id: 'orphan', images: [] }],
      comics: [],
    });

    expect(plan.unresolved).toEqual([{ characterId: 'orphan', candidateWorldIds: ['w1', 'w2'] }]);
  });
});

describe('legacy reference migration execution', () => {
  it('creates and verifies canonical records before removing embedded images', async () => {
    const state = migrationState();
    const plan = planLegacyMigration({
      worlds: state.worlds,
      characters: state.characters,
      comics: state.comics,
    });

    await runLegacyMigration(plan, {}, state.dependencies);

    expect([...state.assets.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worldId: 'w1',
          dataUrl: 'data:image/png;base64,WORLD',
          thumbnailDataUrl: 'data:image/png;base64,THUMB',
          characterIds: [],
          classificationState: 'pending',
        }),
        expect.objectContaining({
          worldId: 'w1',
          dataUrl: 'data:image/png;base64,MARA',
          characterIds: ['mara'],
          classificationState: 'pending',
        }),
      ]),
    );
    expect(JSON.stringify([...state.assets.values()])).not.toMatch(
      /embedding|referenceKey|referenceClassifications|locationKey|"tag"/,
    );
    expect(state.worlds[0].images).toEqual([]);
    expect(state.characters[0].images).toEqual([]);
    expect(state.comics[0].referenceSchemaVersion).toBe(1);
    expect(state.events.indexOf('asset:legacy-world-w1-world-image')).toBeLessThan(
      state.events.indexOf('world:w1'),
    );
    expect(state.dependencies.saveProgress).toHaveBeenCalledTimes(2);
  });

  it('refuses unresolved ownership before writing anything', async () => {
    const state = migrationState();
    state.comics.push({ id: 'comic-2', worldId: 'w2', characterIds: ['mara'] });
    state.worlds.push({ id: 'w2', name: 'Other', images: [] });
    const plan = planLegacyMigration({
      worlds: state.worlds,
      characters: state.characters,
      comics: state.comics,
    });

    await expect(runLegacyMigration(plan, {}, state.dependencies)).rejects.toThrow(
      'Choose one parent world for character "mara"',
    );
    expect(state.assets.size).toBe(0);
  });

  it('resumes after interruption without duplicating or losing image bytes', async () => {
    const state = migrationState();
    const plan = planLegacyMigration({
      worlds: state.worlds,
      characters: state.characters,
      comics: state.comics,
    });
    let interrupted = false;
    state.dependencies.saveProgress = vi.fn(async () => {
      if (!interrupted) {
        interrupted = true;
        throw new Error('interrupted');
      }
    });

    await expect(runLegacyMigration(plan, {}, state.dependencies)).rejects.toThrow('interrupted');
    await runLegacyMigration(plan, {}, state.dependencies);

    expect([...state.assets.values()].map((asset) => asset.dataUrl).sort()).toEqual([
      'data:image/png;base64,MARA',
      'data:image/png;base64,WORLD',
    ]);
    expect(state.assets.size).toBe(2);
    expect(state.worlds[0].images).toEqual([]);
    expect(state.characters[0].images).toEqual([]);
  });
});
