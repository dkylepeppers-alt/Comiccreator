import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getAll: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  putBatch: vi.fn(),
  uuid: vi.fn(() => 'generated-id'),
  STORES: {
    characters: 'characters',
    worlds: 'worlds',
    referenceAssets: 'referenceAssets',
    classificationJobs: 'classificationJobs',
  },
}));

vi.mock('../src/js/db.js', () => ({ default: db }));

import CharactersPage from '../src/js/pages/characters.js';

describe('Characters import action', () => {
  beforeEach(() => {
    db.getAll.mockImplementation(async (store: string) => (store === 'worlds' ? [{ id: 'atlas', name: 'Atlas' }] : []));
    db.get.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers an Import character action and a file input from the Characters list', async () => {
    const html = await CharactersPage.render();

    expect(html).toContain('Import character');
    expect(html).toContain('id="character-import-input"');
    expect(html).toContain('data-action-change="previewCharacterImport"');
  });

  it('exposes the import preview, confirmation, and cancellation handlers to delegated actions', () => {
    expect(CharactersPage.importCharacter).toEqual(expect.any(Function));
    expect(CharactersPage.previewCharacterImport).toEqual(expect.any(Function));
    expect(CharactersPage.confirmCharacterImport).toEqual(expect.any(Function));
    expect(CharactersPage.cancelCharacterImport).toEqual(expect.any(Function));
  });

  it('exports a schema-v3 payload with the character canonical references', async () => {
    db.get.mockResolvedValue({ id: 'mara', name: 'Mara', imageData: 'legacy' });
    db.getAll.mockImplementation(async (store: string) =>
      store === 'referenceAssets'
        ? [{ id: 'portrait', characterIds: ['mara'], dataUrl: 'data:image/png;base64,TUFSQQ==' }]
        : [],
    );
    const click = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ href: '', download: '', click })) });
    const createObjectURL = vi.fn(() => 'blob:character');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });

    await CharactersPage.exportCharacter('mara');

    const payload = JSON.parse(await (createObjectURL.mock.calls[0][0] as Blob).text());
    expect(payload).toMatchObject({
      schemaVersion: 3,
      character: { id: 'mara', name: 'Mara' },
      references: [{ id: 'portrait' }],
    });
    expect(payload.character).not.toHaveProperty('imageData');
    expect(click).toHaveBeenCalledOnce();
  });
});
