// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import API from '../src/js/api.js';
import SettingsPage from '../src/js/pages/settings.js';

describe('settings.ts loadModels render-failure recovery', () => {
  beforeEach(() => {
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
});
