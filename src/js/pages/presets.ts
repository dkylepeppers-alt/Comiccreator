// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml } from '../utils.js';
import DB from '../db.js';
import { createPresetPage } from '../preset-page.js';

/**
 * Prompt Presets Page
 */
const PresetsPage: PageModule & Record<string, any> = createPresetPage({
  store: DB.STORES.presets,
  navKey: 'presets',
  label: 'Preset',
  deleteModalTitle: 'Delete Preset',
  title: 'Prompt Presets',
  subtitle: 'Customize system prompts and sampler settings',
  emptyIcon: '&#9881;',
  emptyText: 'No presets yet.',
  listItem: (p) => `
        <div class="preset-card" data-action="editPreset" data-args="${escHtml(JSON.stringify([p.id]))}">
          <div style="display:flex;justify-content:space-between;align-items:start;">
            <div>
              <div class="preset-card-name">${escHtml(p.name)}</div>
              <div class="text-sm text-muted">${escHtml(p.description || '')}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-action="deletePreset" data-args="${escHtml(JSON.stringify([p.id, p.name]))}">&#128465;</button>
          </div>
          <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;">
            <span class="text-sm" style="color:var(--accent);">Temp: ${p.temperature}</span>
            <span class="text-sm" style="color:var(--accent);">Top-P: ${p.topP}</span>
            <span class="text-sm" style="color:var(--accent);">Tokens: ${p.maxTokens}</span>
          </div>
          <div class="preset-card-preview mt-sm">${escHtml((p.systemPrompt || '').slice(0, 120))}${(p.systemPrompt || '').length > 120 ? '...' : ''}</div>
        </div>
      `,
  defaults: {
    name: '',
    description: '',
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    systemPrompt: '',
    frequencyPenalty: 0,
    presencePenalty: 0,
  },
  editorHtml: (preset, editingId) => `
    <div class="slide-up">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <button class="btn btn-sm btn-secondary" data-action="backToList">&#8592; Back</button>
        <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} Preset</h2>
      </div>

      <div class="card">
        <div class="form-group">
          <label class="form-label">Preset Name *</label>
          <input type="text" id="preset-name" value="${escHtml(preset.name)}" placeholder="e.g. Dark & Gritty">
        </div>

        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" id="preset-desc" value="${escHtml(preset.description || '')}" placeholder="Brief description...">
        </div>

        <div class="form-group">
          <label class="form-label">System Prompt</label>
          <textarea id="preset-system" rows="6" placeholder="Custom system instructions for the LLM...">${escHtml(preset.systemPrompt)}</textarea>
          <div class="form-hint">This overrides the default comic generation prompt. Use {genre}, {characters}, and {world} as placeholders.</div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title mb-sm">Sampler Settings</h3>

        <div class="form-group">
          <label class="form-label">Temperature: <span id="preset-temp-val">${preset.temperature}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">0</span>
            <input type="range" id="preset-temp" min="0" max="2" step="0.05" value="${preset.temperature}" oninput="document.getElementById('preset-temp-val').textContent=this.value">
            <span class="text-sm text-muted">2</span>
          </div>
          <div class="form-hint">Lower = more focused, higher = more creative</div>
        </div>

        <div class="form-group">
          <label class="form-label">Top-P: <span id="preset-topp-val">${preset.topP}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">0</span>
            <input type="range" id="preset-topp" min="0" max="1" step="0.05" value="${preset.topP}" oninput="document.getElementById('preset-topp-val').textContent=this.value">
            <span class="text-sm text-muted">1</span>
          </div>
          <div class="form-hint">Nucleus sampling - lower values are more deterministic</div>
        </div>

        <div class="form-group">
          <label class="form-label">Max Tokens: <span id="preset-tokens-val">${preset.maxTokens}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">256</span>
            <input type="range" id="preset-tokens" min="256" max="8192" step="256" value="${preset.maxTokens}" oninput="document.getElementById('preset-tokens-val').textContent=this.value">
            <span class="text-sm text-muted">8192</span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Frequency Penalty: <span id="preset-freq-val">${preset.frequencyPenalty || 0}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">0</span>
            <input type="range" id="preset-freq" min="0" max="2" step="0.1" value="${preset.frequencyPenalty || 0}" oninput="document.getElementById('preset-freq-val').textContent=this.value">
            <span class="text-sm text-muted">2</span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Presence Penalty: <span id="preset-pres-val">${preset.presencePenalty || 0}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">0</span>
            <input type="range" id="preset-pres" min="0" max="2" step="0.1" value="${preset.presencePenalty || 0}" oninput="document.getElementById('preset-pres-val').textContent=this.value">
            <span class="text-sm text-muted">2</span>
          </div>
        </div>
      </div>

      <button class="btn btn-primary btn-block mt-sm" data-action="savePreset">
        ${editingId ? 'Update' : 'Create'} Preset
      </button>
    </div>
  `,
  collectFields: () => {
    const name = document.getElementById('preset-name').value.trim();
    if (!name) {
      App.toast('Name is required', 'error');
      return null;
    }
    return {
      name,
      description: document.getElementById('preset-desc').value.trim(),
      systemPrompt: document.getElementById('preset-system').value.trim(),
      temperature: parseFloat(document.getElementById('preset-temp').value),
      topP: parseFloat(document.getElementById('preset-topp').value),
      maxTokens: parseInt(document.getElementById('preset-tokens').value),
      frequencyPenalty: parseFloat(document.getElementById('preset-freq').value),
      presencePenalty: parseFloat(document.getElementById('preset-pres').value),
    };
  },
});
export default PresetsPage;
