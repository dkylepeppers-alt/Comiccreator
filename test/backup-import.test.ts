import { describe, expect, it, vi } from 'vitest';
import {
  buildBackup,
  parseBackup,
  importBackup,
  type BackupImportDependencies,
} from '../src/js/settings/backup-import.js';

const STORES = {
  characters: 'characters',
  worlds: 'worlds',
  locations: 'locations',
  referenceAssets: 'referenceAssets',
  classificationJobs: 'classificationJobs',
  comics: 'comics',
  pages: 'pages',
  presets: 'presets',
  imagePresets: 'imagePresets',
} as const;

function makeDependencies(overrides: Partial<BackupImportDependencies> = {}): BackupImportDependencies {
  return {
    stores: STORES,
    put: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([]),
    normalizeCharacter: vi.fn((record: unknown) => ({ record })),
    normalizeWorld: vi.fn((record: unknown) => ({ record })),
    ...overrides,
  };
}

describe('parseBackup', () => {
  it('parses a complete backup with all six collections', () => {
    const payload = parseBackup(
      JSON.stringify({
        characters: [{ id: 'c1' }],
        worlds: [{ id: 'w1' }],
        comics: [{ id: 'co1' }],
        pages: [{ id: 'p1' }],
        presets: [{ id: 'pr1' }],
        imagePresets: [{ id: 'ip1' }],
      }),
    );
    expect(payload.characters).toEqual([{ id: 'c1' }]);
    expect(payload.worlds).toEqual([{ id: 'w1' }]);
    expect(payload.comics).toEqual([{ id: 'co1' }]);
    expect(payload.pages).toEqual([{ id: 'p1' }]);
    expect(payload.presets).toEqual([{ id: 'pr1' }]);
    expect(payload.imagePresets).toEqual([{ id: 'ip1' }]);
  });

  it('tolerates missing collections, leaving them undefined', () => {
    const payload = parseBackup(JSON.stringify({ characters: [{ id: 'c1' }] }));
    expect(payload.characters).toEqual([{ id: 'c1' }]);
    expect(payload.worlds).toBeUndefined();
    expect(payload.comics).toBeUndefined();
    expect(payload.pages).toBeUndefined();
    expect(payload.presets).toBeUndefined();
    expect(payload.imagePresets).toBeUndefined();
  });

  it('accepts empty-array collections as present but empty', () => {
    const payload = parseBackup(JSON.stringify({ characters: [] }));
    expect(payload.characters).toEqual([]);
  });

  it('throws the exact legacy message for an invalid non-array collection', () => {
    expect(() => parseBackup(JSON.stringify({ characters: { not: 'an array' } }))).toThrow('Invalid characters data');
    expect(() => parseBackup(JSON.stringify({ worlds: 'nope' }))).toThrow('Invalid worlds data');
    expect(() => parseBackup(JSON.stringify({ comics: 42 }))).toThrow('Invalid comics data');
    expect(() => parseBackup(JSON.stringify({ pages: { id: 'x' } }))).toThrow('Invalid pages data');
    expect(() => parseBackup(JSON.stringify({ presets: 'nope' }))).toThrow('Invalid presets data');
    expect(() => parseBackup(JSON.stringify({ imagePresets: 1 }))).toThrow('Invalid imagePresets data');
  });

  it('throws when entries lack a truthy id field', () => {
    expect(() => parseBackup(JSON.stringify({ characters: [{ id: 'ok' }, { name: 'no id' }] }))).toThrow(
      'Invalid characters data',
    );
    expect(() => parseBackup(JSON.stringify({ worlds: [{ id: '' }] }))).toThrow('Invalid worlds data');
    expect(() => parseBackup(JSON.stringify({ comics: [{ id: null }] }))).toThrow('Invalid comics data');
    expect(() => parseBackup(JSON.stringify({ pages: [null] }))).toThrow('Invalid pages data');
  });

  it('validates collections in write order, throwing on the first invalid one', () => {
    expect(() =>
      parseBackup(
        JSON.stringify({
          characters: [{ id: 'c1' }],
          worlds: 'invalid',
          comics: 'also invalid',
        }),
      ),
    ).toThrow('Invalid worlds data');
  });

  it('retains version metadata and ignores unknown top-level properties', () => {
    const payload = parseBackup(
      JSON.stringify({
        schemaVersion: 2,
        characters: [{ id: 'c1' }],
        exportedAt: '2026-01-01T00:00:00.000Z',
        unknown: true,
      }),
    );
    expect(payload.characters).toEqual([{ id: 'c1' }]);
    expect(payload.exportedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(payload.schemaVersion).toBe(2);
    expect((payload as Record<string, unknown>).unknown).toBeUndefined();
  });

  it('propagates a SyntaxError for malformed JSON', () => {
    expect(() => parseBackup('{ not valid json')).toThrow();
  });

  it('throws for a null JSON root instead of silently returning an empty payload', () => {
    // A `null` root previously threw when the legacy inline importData() did `data.characters`
    // on it (TypeError: Cannot read properties of null), which the caller's catch converted into
    // the "Invalid backup file" toast. Restoring that behavior here (rather than falling back to
    // `{}` and returning an empty-but-"valid" payload) keeps a corrupted/truncated `null`-root
    // export on the error path instead of silently importing nothing while reporting success.
    expect(() => parseBackup(JSON.stringify(null))).toThrow();
  });
});

describe('importBackup', () => {
  it('normalizes character and world records via the supplied dependencies before writing', async () => {
    const dependencies = makeDependencies({
      normalizeCharacter: vi.fn((record: unknown) => ({
        record: { ...(record as Record<string, unknown>), normalized: 'char' },
      })),
      normalizeWorld: vi.fn((record: unknown) => ({
        record: { ...(record as Record<string, unknown>), normalized: 'world' },
      })),
    });
    const payload = parseBackup(JSON.stringify({ characters: [{ id: 'c1' }], worlds: [{ id: 'w1' }] }));

    await importBackup(payload, dependencies);

    expect(dependencies.normalizeCharacter).toHaveBeenCalledWith({ id: 'c1', worldId: 'w1' });
    expect(dependencies.normalizeWorld).toHaveBeenCalledWith({ id: 'w1' });
    expect(dependencies.put).toHaveBeenCalledWith('characters', {
      id: 'c1',
      worldId: 'w1',
      normalized: 'char',
    });
    expect(dependencies.put).toHaveBeenCalledWith('worlds', { id: 'w1', normalized: 'world' });
  });

  it('writes comics, pages, presets, and imagePresets unmodified (no normalizer)', async () => {
    const dependencies = makeDependencies();
    const payload = parseBackup(
      JSON.stringify({
        comics: [{ id: 'co1' }],
        pages: [{ id: 'p1' }],
        presets: [{ id: 'pr1' }],
        imagePresets: [{ id: 'ip1' }],
      }),
    );

    await importBackup(payload, dependencies);

    expect(dependencies.put).toHaveBeenCalledWith('comics', { id: 'co1', referenceSchemaVersion: 1 });
    expect(dependencies.put).toHaveBeenCalledWith('pages', { id: 'p1' });
    expect(dependencies.put).toHaveBeenCalledWith('presets', { id: 'pr1' });
    expect(dependencies.put).toHaveBeenCalledWith('imagePresets', { id: 'ip1' });
  });

  it('writes present collections sequentially in the exact legacy order, and records within a collection in array order', async () => {
    const calls: Array<[string, unknown]> = [];
    const dependencies = makeDependencies({
      put: vi.fn(async (storeName: string, record: unknown) => {
        calls.push([storeName, record]);
      }),
    });
    const payload = parseBackup(
      JSON.stringify({
        imagePresets: [{ id: 'ip1' }, { id: 'ip2' }],
        presets: [{ id: 'pr1' }],
        pages: [{ id: 'p1' }, { id: 'p2' }],
        comics: [{ id: 'co1' }],
        worlds: [{ id: 'w1' }],
        characters: [{ id: 'c1' }, { id: 'c2' }],
      }),
    );

    await importBackup(payload, dependencies);

    expect(calls.map(([storeName]) => storeName)).toEqual([
      'worlds',
      'characters',
      'characters',
      'comics',
      'pages',
      'pages',
      'presets',
      'imagePresets',
      'imagePresets',
    ]);
    expect(calls.map(([, record]) => (record as { id: string }).id)).toEqual([
      'w1',
      'c1',
      'c2',
      'co1',
      'p1',
      'p2',
      'pr1',
      'ip1',
      'ip2',
    ]);
  });

  it('skips collections absent from the payload', async () => {
    const dependencies = makeDependencies();
    const payload = parseBackup(JSON.stringify({ presets: [{ id: 'pr1' }] }));

    await importBackup(payload, dependencies);

    expect(dependencies.put).toHaveBeenCalledTimes(1);
    expect(dependencies.put).toHaveBeenCalledWith('presets', { id: 'pr1' });
  });

  it('propagates a normalizer failure and stops further writes', async () => {
    const dependencies = makeDependencies({
      normalizeCharacter: vi.fn(() => {
        throw new Error('bad character record');
      }),
    });
    const payload = parseBackup(JSON.stringify({ characters: [{ id: 'c1' }], worlds: [{ id: 'w1' }] }));

    await expect(importBackup(payload, dependencies)).rejects.toThrow('bad character record');
    expect(dependencies.put).not.toHaveBeenCalled();
  });

  it('propagates a write failure and stops further writes', async () => {
    const put = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const dependencies = makeDependencies({ put });
    const payload = parseBackup(JSON.stringify({ characters: [{ id: 'c1' }], worlds: [{ id: 'w1' }] }));

    await expect(importBackup(payload, dependencies)).rejects.toThrow('disk full');
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('worlds', { id: 'w1' });
  });
});

describe('schema-v2 backups', () => {
  it('exports only canonical schema-version-2 collections', async () => {
    const records: Record<string, unknown[]> = {
      worlds: [{ id: 'w1', name: 'Atlas', images: [{ dataUrl: 'old', embedding: [1] }] }],
      locations: [{ id: 'l1', worldId: 'w1', name: 'Yard', aliases: [] }],
      characters: [{ id: 'c1', worldId: 'w1', name: 'Mara', images: [{ dataUrl: 'old' }] }],
      referenceAssets: [{ id: 'r1', worldId: 'w1', dataUrl: 'data:image/png;base64,abc' }],
      classificationJobs: [{ id: 'j1', assetId: 'r1', worldId: 'w1' }],
      comics: [{ id: 'co1', referenceSchemaVersion: 2 }],
      pages: [{ id: 'p1', comicId: 'co1' }],
      presets: [{ id: 'pr1' }],
      imagePresets: [{ id: 'ip1' }],
    };
    const dependencies = makeDependencies({
      getAll: vi.fn(async (storeName: string) => records[storeName] || []),
    });

    const payload = await buildBackup(dependencies, new Date('2026-07-22T00:00:00.000Z'));

    expect(payload.schemaVersion).toBe(2);
    expect(payload.referenceAssets).toEqual(records.referenceAssets);
    expect(payload.locations).toEqual(records.locations);
    expect(JSON.stringify(payload)).not.toMatch(/embedding|referenceKey|locationKey|"tag"|"images"/);
  });

  it('converts an unversioned backup before atomically writing canonical stores', async () => {
    const dependencies = makeDependencies({ putBatch: vi.fn().mockResolvedValue(undefined) });
    const payload = parseBackup(
      JSON.stringify({
        worlds: [{ id: 'w1', name: 'Atlas', images: ['data:image/png;base64,world'] }],
        characters: [
          {
            id: 'c1',
            name: 'Mara',
            worldId: 'w1',
            images: [{ id: 'portrait', dataUrl: 'data:image/png;base64,char' }],
          },
        ],
        comics: [{ id: 'co1', worldId: 'w1', characterIds: ['c1'] }],
      }),
    );

    await importBackup(payload, dependencies);

    expect(dependencies.putBatch).toHaveBeenCalledOnce();
    const writes = vi.mocked(dependencies.putBatch!).mock.calls[0][0];
    expect(writes).toContainEqual([
      'referenceAssets',
      expect.objectContaining({ id: 'portrait', worldId: 'w1', characterIds: ['c1'] }),
    ]);
    expect(writes).toContainEqual(['comics', expect.objectContaining({ id: 'co1', referenceSchemaVersion: 1 })]);
    expect(dependencies.put).not.toHaveBeenCalled();
  });

  it('rejects ambiguous legacy character ownership before writing', async () => {
    const dependencies = makeDependencies({ putBatch: vi.fn().mockResolvedValue(undefined) });
    const payload = parseBackup(
      JSON.stringify({
        worlds: [{ id: 'w1' }, { id: 'w2' }],
        characters: [{ id: 'c1', images: [{ id: 'r1', dataUrl: 'data:image/png;base64,char' }] }],
        comics: [
          { id: 'co1', worldId: 'w1', characterIds: ['c1'] },
          { id: 'co2', worldId: 'w2', characterIds: ['c1'] },
        ],
      }),
    );

    await expect(importBackup(payload, dependencies)).rejects.toThrow('parent world');
    expect(dependencies.putBatch).not.toHaveBeenCalled();
  });
});
