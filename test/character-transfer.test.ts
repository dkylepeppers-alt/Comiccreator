import { describe, expect, it, vi } from 'vitest';
import { buildCharacterExport, commitCharacterImport, planCharacterImport } from '../src/js/character-transfer.js';

describe('character transfer planning', () => {
  it('accepts a wrapped current export and creates canonical pending references', () => {
    const plan = planCharacterImport(
      {
        schemaVersion: 2,
        character: {
          id: 'mara',
          name: 'Mara',
          description: 'A courier',
          imageData: 'data:image/png;base64,TUFSQQ==',
        },
      },
      {
        worldId: 'atlas',
        existingCharacterIds: [],
        existingReferenceIds: [],
        newId: (() => {
          let index = 0;
          return () => `new-${++index}`;
        })(),
        now: 100,
      },
    );

    expect(plan.preview).toEqual({
      name: 'Mara',
      worldId: 'atlas',
      validImageCount: 1,
      malformedImageCount: 0,
      idConflicts: [],
    });
    expect(plan.character).toMatchObject({
      id: 'mara',
      worldId: 'atlas',
      linkedWorldId: 'atlas',
      name: 'Mara',
      preferredIdentityReferenceId: 'new-1',
    });
    expect(plan.references).toEqual([
      expect.objectContaining({
        id: 'new-1',
        worldId: 'atlas',
        characterIds: ['mara'],
        dataUrl: 'data:image/png;base64,TUFSQQ==',
        classificationState: 'pending',
      }),
    ]);
    expect(plan.jobs).toEqual([
      expect.objectContaining({ id: 'classification-new-1', assetId: 'new-1', worldId: 'atlas', status: 'pending' }),
    ]);
  });

  it('accepts bare legacy records, skips malformed images, and deduplicates byte-identical data', () => {
    const plan = planCharacterImport(
      {
        id: 'theo',
        name: 'Theo',
        description: 'A pilot',
        imageData: 'data:image/png;base64,VEhFTw==',
        images: [{ dataUrl: 'data:image/png;base64,VE hF\nTw==' }, { dataUrl: 'not-an-image' }, { nope: true }],
        tags: ['old'],
        referenceKey: 'front',
        embedding: [1, 2],
        classificationState: 'ready',
      },
      { worldId: 'atlas', existingCharacterIds: [], existingReferenceIds: [], newId: () => 'reference-1', now: 100 },
    );

    expect(plan.preview).toMatchObject({ validImageCount: 1, malformedImageCount: 2 });
    expect(plan.references).toHaveLength(1);
    expect(plan.character).not.toHaveProperty('imageData');
    expect(plan.character).not.toHaveProperty('images');
    expect(JSON.stringify(plan.character)).not.toMatch(/tags|referenceKey|embedding|classificationState/);
  });

  it('deduplicates byte-identical images even when their data URL media types differ', () => {
    const plan = planCharacterImport(
      {
        name: 'Mara',
        images: ['data:image/png;base64,TUFSQQ==', 'data:image/jpeg;base64,TUFSQQ=='],
      },
      {
        worldId: 'atlas',
        existingCharacterIds: [],
        existingReferenceIds: [],
        newId: (() => {
          let index = 0;
          return () => `r${++index}`;
        })(),
        now: 100,
      },
    );

    expect(plan.references).toHaveLength(1);
  });

  it('skips image data URLs with invalid base64 payloads', () => {
    const plan = planCharacterImport(
      { name: 'Mara', images: ['data:image/png;base64,a'] },
      { worldId: 'atlas', existingCharacterIds: [], existingReferenceIds: [], newId: () => 'r1', now: 100 },
    );

    expect(plan.preview).toMatchObject({ validImageCount: 0, malformedImageCount: 1 });
  });

  it('remaps colliding character and canonical reference IDs without overwriting either record', () => {
    const ids = ['mara-imported', 'portrait-imported'];
    const plan = planCharacterImport(
      {
        schemaVersion: 3,
        character: { id: 'mara', name: 'Mara', preferredIdentityReferenceId: 'portrait' },
        references: [
          {
            id: 'portrait',
            worldId: 'old-world',
            dataUrl: 'data:image/png;base64,TUFSQQ==',
            characterIds: ['mara'],
            subjectType: 'character',
            use: 'identity',
            classificationState: 'ready',
          },
        ],
      },
      {
        worldId: 'atlas',
        existingCharacterIds: ['mara'],
        existingReferenceIds: ['portrait'],
        newId: () => ids.shift()!,
        now: 100,
      },
    );

    expect(plan.preview.idConflicts).toEqual(['mara', 'portrait']);
    expect(plan.character).toMatchObject({ id: 'mara-imported', preferredIdentityReferenceId: 'portrait-imported' });
    expect(plan.references).toEqual([
      expect.objectContaining({ id: 'portrait-imported', characterIds: ['mara-imported'] }),
    ]);
  });

  it('commits every canonical record in one batch only after planning succeeds', async () => {
    const putBatch = vi.fn().mockResolvedValue(undefined);
    const plan = planCharacterImport(
      { id: 'mara', name: 'Mara', imageData: 'data:image/png;base64,TUFSQQ==' },
      { worldId: 'atlas', existingCharacterIds: [], existingReferenceIds: [], newId: () => 'r1', now: 100 },
    );

    await commitCharacterImport(plan, { putBatch });

    expect(putBatch).toHaveBeenCalledTimes(1);
    expect(putBatch).toHaveBeenCalledWith([
      ['characters', plan.character],
      ['referenceAssets', plan.references[0]],
      ['classificationJobs', plan.jobs[0]],
    ]);
  });

  it('exports schema v3 with canonical character references and supports lossless re-import', () => {
    const exported = buildCharacterExport(
      { id: 'mara', worldId: 'atlas', name: 'Mara', preferredIdentityReferenceId: 'portrait' },
      [
        {
          id: 'portrait',
          worldId: 'atlas',
          dataUrl: 'data:image/png;base64,TUFSQQ==',
          characterIds: ['mara'],
          subjectType: 'character',
          use: 'identity',
        },
      ],
    );

    expect(exported).toMatchObject({ schemaVersion: 3, character: { id: 'mara' }, references: [{ id: 'portrait' }] });
    const imported = planCharacterImport(exported, {
      worldId: 'new-atlas',
      existingCharacterIds: [],
      existingReferenceIds: [],
      newId: () => 'unused',
      now: 100,
    });
    expect(imported.character).toMatchObject({ preferredIdentityReferenceId: 'portrait' });
    expect(imported.references).toEqual([
      expect.objectContaining({ id: 'portrait', dataUrl: 'data:image/png;base64,TUFSQQ==' }),
    ]);
  });
});
