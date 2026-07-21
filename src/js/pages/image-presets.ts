// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml } from '../utils.js';
import DB from '../db.js';
import { createPresetPage } from '../preset-page.js';

/**
 * Image Style Presets Page
 * Manage reusable image style prompt prefixes for comic generation.
 */
const ImagePresetsPage: PageModule & Record<string, any> = createPresetPage({
  store: DB.STORES.imagePresets,
  navKey: 'image-presets',
  label: 'Image preset',
  deleteModalTitle: 'Delete Image Preset',
  title: 'Image Style Presets',
  subtitle: 'Reusable art style prefixes for image generation',
  emptyIcon: '&#127912;',
  emptyText: 'No image presets yet.',
  listItem: (p) => `
        <div class="preset-card" data-action="editPreset" data-args="${escHtml(JSON.stringify([p.id]))}">
          <div style="display:flex;justify-content:space-between;align-items:start;">
            <div>
              <div class="preset-card-name">${escHtml(p.name)}</div>
              <div class="text-sm text-muted">${escHtml(p.description || '')}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-action="deletePreset" data-args="${escHtml(JSON.stringify([p.id]))}">&#128465;</button>
          </div>
          <div class="preset-card-preview mt-sm">${escHtml((p.promptPrefix || '').slice(0, 120))}${(p.promptPrefix || '').length > 120 ? '...' : ''}</div>
        </div>
      `,
  defaults: { name: '', description: '', promptPrefix: '' },
  editorHtml: (preset, editingId) => `
    <div class="slide-up">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <button class="btn btn-sm btn-secondary" data-action="backToList">&#8592; Back</button>
        <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} Image Style Preset</h2>
      </div>

      <div class="card">
        <div class="form-group">
          <label class="form-label">Preset Name *</label>
          <input type="text" id="imgpreset-name" value="${escHtml(preset.name)}" placeholder="e.g. Watercolor">
        </div>

        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" id="imgpreset-desc" value="${escHtml(preset.description || '')}" placeholder="Brief description of the style...">
        </div>

        <div class="form-group">
          <label class="form-label">Prompt Prefix *</label>
          <textarea id="imgpreset-prefix" rows="4" placeholder="e.g. watercolor painting, soft edges, gentle color washes, artistic">${escHtml(preset.promptPrefix || '')}</textarea>
          <div class="form-hint">This text is prepended to every image prompt when this preset is selected during comic creation.</div>
        </div>
      </div>

      <button class="btn btn-primary btn-block mt-sm" data-action="savePreset">
        ${editingId ? 'Update' : 'Create'} Preset
      </button>
    </div>
  `,
  collectFields: () => {
    const name = document.getElementById('imgpreset-name').value.trim();
    if (!name) {
      App.toast('Name is required', 'error');
      return null;
    }
    const promptPrefix = document.getElementById('imgpreset-prefix').value.trim();
    if (!promptPrefix) {
      App.toast('Prompt prefix is required', 'error');
      return null;
    }
    return {
      name,
      description: document.getElementById('imgpreset-desc').value.trim(),
      promptPrefix,
    };
  },
});
export default ImagePresetsPage;
