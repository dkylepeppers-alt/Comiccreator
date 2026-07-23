import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getAll: vi.fn(),
  get: vi.fn(),
  putBatch: vi.fn(),
  uuid: vi.fn(() => 'generated-reference'),
  STORES: {
    characters: 'characters',
    worlds: 'worlds',
    referenceAssets: 'referenceAssets',
    classificationJobs: 'classificationJobs',
  },
}));
const classifier = vi.hoisted(() => ({ getAvailability: vi.fn() }));
const queue = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../src/js/db.js', () => ({ default: db }));
vi.mock('../src/js/references/local-classifier.js', () => ({ localReferenceClassifier: classifier }));
vi.mock('../src/js/reference-workspace-runtime.js', () => ({
  addUploadedReference: vi.fn(),
  closeReferenceEditor: vi.fn(),
  fileToDataUrl: vi.fn(),
  openReferenceEditor: vi.fn(),
  referenceClassificationQueue: queue,
  referenceRepository: { getAsset: vi.fn(), listByCharacter: vi.fn() },
  referenceWorkspace: { handleAction: vi.fn(), render: vi.fn() },
}));

import CharactersPage from '../src/js/pages/characters.js';

describe('character import completion', () => {
  const app = { hideModal: vi.fn(), refreshPage: vi.fn(), showModal: vi.fn(), toast: vi.fn() };

  beforeEach(() => {
    vi.stubGlobal('App', app);
    vi.stubGlobal('document', {
      getElementById: vi.fn((id: string) => (id === 'character-import-world' ? { value: 'atlas' } : null)),
    });
    vi.stubGlobal(
      'FileReader',
      class {
        result = JSON.stringify({ id: 'mara', name: 'Mara', imageData: 'data:image/png;base64,TUFSQQ==' });
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsText() {
          this.onload?.();
        }
      },
    );
    db.getAll.mockImplementation(async (store: string) => (store === 'worlds' ? [{ id: 'atlas', name: 'Atlas' }] : []));
    db.putBatch.mockResolvedValue(undefined);
    classifier.getAvailability.mockRejectedValue(new Error('plugin unavailable'));
    queue.run.mockReset();
    for (const method of Object.values(app)) method.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a committed import successful when post-commit availability lookup fails', async () => {
    await CharactersPage.previewCharacterImport({ files: [{}], value: '' });
    await CharactersPage.confirmCharacterImport();

    expect(db.putBatch).toHaveBeenCalledOnce();
    expect(app.toast).toHaveBeenCalledWith('Imported Mara', 'success');
    expect(app.refreshPage).toHaveBeenCalledOnce();
    expect(app.toast).not.toHaveBeenCalledWith('plugin unavailable', 'error');
    expect(queue.run).not.toHaveBeenCalled();
  });
});
