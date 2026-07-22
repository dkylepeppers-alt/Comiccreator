import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
