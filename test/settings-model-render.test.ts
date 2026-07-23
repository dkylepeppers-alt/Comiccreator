// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    STORES: {
      worlds: 'worlds',
      characters: 'characters',
      comics: 'comics',
      pages: 'pages',
      presets: 'presets',
      imagePresets: 'imagePresets',
      locations: 'locations',
      referenceAssets: 'referenceAssets',
      classificationJobs: 'classificationJobs',
    },
    getSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
    getAll: vi.fn(async () => []),
    setSetting: vi.fn(),
  },
}));

vi.mock('../src/js/db.js', () => ({ default: dbMock }));

// settings.ts calls API.fetchTextModels/fetchImageModels via the real API module by default.
// We mock it here so we can hand back a deliberately malformed model record (missing `id`) that
// makes renderModelList -> model-catalog.ts's extractProvider() throw, without touching
// model-catalog.ts or api.ts themselves.
vi.mock('../src/js/api.js', () => ({
  default: {
    fetchTextModels: vi.fn(),
    fetchImageModels: vi.fn(),
    FALLBACK_TEXT_MODELS: ['fallback-text-a', 'fallback-text-b'],
    FALLBACK_IMAGE_MODELS: ['fallback-image-a'],
  },
}));

vi.mock('../src/js/references/local-classifier.js', () => ({
  localReferenceClassifier: { getAvailability: vi.fn(), download: vi.fn() },
}));

vi.mock('../src/js/reference-workspace-runtime.js', () => ({
  referenceClassificationQueue: { getProgress: vi.fn(), resumeAfterLocalModelDownload: vi.fn() },
  referenceRepository: { listDiagnostics: vi.fn() },
}));

import API from '../src/js/api.js';
import SettingsPage from '../src/js/pages/settings.js';
import { localReferenceClassifier } from '../src/js/references/local-classifier.js';
import { referenceClassificationQueue, referenceRepository } from '../src/js/reference-workspace-runtime.js';

describe('settings.ts loadModels render-failure recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getSetting.mockImplementation(async (_key: string, fallback: unknown) => fallback);
    dbMock.getAll.mockResolvedValue([]);
    vi.mocked(referenceClassificationQueue.getProgress).mockResolvedValue({
      total: 0,
      pending: 0,
      running: 0,
      complete: 0,
      failed: 0,
      paused: false,
    });
    vi.mocked(referenceRepository.listDiagnostics).mockResolvedValue([]);
    document.body.innerHTML = `
      <div id="text-model-status" class="hidden"></div>
      <div id="text-model-count"></div>
      <div id="text-model-list"></div>
      <div id="caption-model-status" class="hidden"></div>
      <div id="caption-model-count"></div>
      <div id="caption-model-list"></div>
    `;
    (global as any).App = {
      toast: vi.fn(),
      logError: vi.fn(),
    };
    vi.mocked(API.fetchTextModels).mockReset();
  });

  it('recovers to the fallback UI when renderModelList throws on a malformed fetched model', async () => {
    // A real (fetched, not fallback) model missing both `id` and `owned_by` — extractProvider()
    // falls through to `model.id.indexOf('/')` with no null guard and throws a TypeError.
    (API.fetchTextModels as any).mockResolvedValue([{ name: 'Broken Model' }]);

    await SettingsPage.refreshModels('text');

    const statusEl = document.getElementById('text-model-status');
    const listEl = document.getElementById('text-model-list');
    const captionStatusEl = document.getElementById('caption-model-status');

    // Recovered into the same fallback UI a fetch failure would have produced.
    expect(statusEl.textContent).toBe('Failed to load models. Using fallback list.');
    expect(statusEl.classList.contains('hidden')).toBe(false);
    expect(listEl.innerHTML).toContain('fallback-text-a');
    expect(captionStatusEl.textContent).toBe('Using fallback list.');
    expect(captionStatusEl.classList.contains('hidden')).toBe(false);
    expect((global as any).App.logError).toHaveBeenCalled();
  });

  it('shows the caption fallback status when text-model fetching fails', async () => {
    (API.fetchTextModels as any).mockRejectedValue(new Error('catalog unavailable'));

    await SettingsPage.refreshModels('text');

    const captionStatusEl = document.getElementById('caption-model-status');
    const captionListEl = document.getElementById('caption-model-list');

    expect(captionStatusEl.textContent).toBe('Using fallback list.');
    expect(captionStatusEl.classList.contains('hidden')).toBe(false);
    expect(captionListEl.innerHTML).toContain('fallback-text-a');
  });

  it('renders normally when the fetched catalog is well-formed', async () => {
    (API.fetchTextModels as any).mockResolvedValue([{ id: 'openai/gpt-4o', name: 'GPT-4o', owned_by: 'openai' }]);

    await SettingsPage.refreshModels('text');

    const statusEl = document.getElementById('text-model-status');
    const listEl = document.getElementById('text-model-list');

    expect(statusEl.classList.contains('hidden')).toBe(true);
    expect(listEl.innerHTML).toContain('GPT-4o');
  });

  it('resumes queued classification after local model download completes', async () => {
    document.body.innerHTML = '<button id="local-llm-download-btn"></button><div id="local-llm-status"></div>';
    vi.mocked(localReferenceClassifier.download).mockResolvedValue(undefined);
    vi.mocked(localReferenceClassifier.getAvailability).mockResolvedValue({ status: 'available' });

    await SettingsPage.downloadLocalModel();

    expect(referenceClassificationQueue.resumeAfterLocalModelDownload).toHaveBeenCalledOnce();
  });

  it('renders a clearly local, explicitly exported diagnostic surface', async () => {
    vi.mocked(referenceRepository.listDiagnostics).mockResolvedValue([
      {
        id: 'd1',
        assetId: 'r1',
        worldId: 'w1',
        createdAt: 1,
        error: { stage: 'inference', code: 'busy' },
      },
    ] as any);

    const html = await SettingsPage.render();

    expect(html).toContain('Local diagnostic log (1)');
    expect(html).toContain('Stored only on this device');
    expect(html).toContain('data-action="exportClassificationDiagnostics"');
    expect(html).not.toContain('data:image');
  });
});
