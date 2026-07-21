import { describe, expect, it, vi } from 'vitest';
import { parseBackup, importBackup, type BackupImportDependencies } from '../src/js/settings/backup-import.js';

const STORES = {
  characters: 'characters',
  worlds: 'worlds',
  comics: 'comics',
  pages: 'pages',
  presets: 'presets',
  imagePresets: 'imagePresets',
} as const;

function makeDependencies(overrides: Partial<BackupImportDependencies> = {}): BackupImportDependencies {
  return {
    stores: STORES,
    put: vi.fn().mockResolvedValue(undefined),
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

  it('ignores unknown top-level properties like exportedAt', () => {
    const payload = parseBackup(
      JSON.stringify({ characters: [{ id: 'c1' }], exportedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 99 }),
    );
    expect(payload.characters).toEqual([{ id: 'c1' }]);
    expect((payload as Record<string, unknown>).exportedAt).toBeUndefined();
    expect((payload as Record<string, unknown>).schemaVersion).toBeUndefined();
  });

  it('propagates a SyntaxError for malformed JSON', () => {
    expect(() => parseBackup('{ not valid json')).toThrow();
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

    expect(dependencies.normalizeCharacter).toHaveBeenCalledWith({ id: 'c1' });
    expect(dependencies.normalizeWorld).toHaveBeenCalledWith({ id: 'w1' });
    expect(dependencies.put).toHaveBeenCalledWith('characters', { id: 'c1', normalized: 'char' });
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

    expect(dependencies.put).toHaveBeenCalledWith('comics', { id: 'co1' });
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
      'characters',
      'characters',
      'worlds',
      'comics',
      'pages',
      'pages',
      'presets',
      'imagePresets',
      'imagePresets',
    ]);
    expect(calls.map(([, record]) => (record as { id: string }).id)).toEqual([
      'c1',
      'c2',
      'w1',
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
    expect(put).toHaveBeenCalledWith('characters', { id: 'c1' });
  });
});
