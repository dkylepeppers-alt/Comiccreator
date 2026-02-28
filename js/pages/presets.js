/**
 * Prompt Presets Page
 */
const PresetsPage = (() => {
  let currentView = 'list';
  let editingId = null;

  async function render(param) {
    if (param === 'new') {
      currentView = 'edit';
      editingId = null;
    } else if (!param) {
      // Reset to list view on normal navigation (prevents stale edit state)
      currentView = 'list';
      editingId = null;
    }
    if (currentView === 'edit') return renderEditor();
    return renderList();
  }

  async function renderList() {
    const allPresets = await DB.getAll(DB.STORES.presets);
    // Deduplicate by ID (defensive guard against DB anomalies)
    const seen = new Set();
    const presets = allPresets.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    presets.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return `
      <div class="slide-up">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div>
            <h2 class="section-title" style="margin-bottom:4px;">Prompt Presets</h2>
            <p class="text-sm text-muted">Customize system prompts and sampler settings</p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="PresetsPage.newPreset()">+ New</button>
        </div>

        ${presets.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">&#9881;</div>
            <div class="empty-state-text">No presets yet.</div>
            <button class="btn btn-primary" onclick="PresetsPage.newPreset()">Create Preset</button>
          </div>
        ` : presets.map(p => `
          <div class="preset-card" onclick="PresetsPage.editPreset('${p.id}')">
            <div style="display:flex;justify-content:space-between;align-items:start;">
              <div>
                <div class="preset-card-name">${escHtml(p.name)}</div>
                <div class="text-sm text-muted">${escHtml(p.description || '')}</div>
              </div>
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();PresetsPage.deletePreset('${p.id}','${escHtml(p.name)}')">&#128465;</button>
            </div>
            <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;">
              <span class="text-sm" style="color:var(--accent);">Temp: ${p.temperature}</span>
              <span class="text-sm" style="color:var(--accent);">Top-P: ${p.topP}</span>
              <span class="text-sm" style="color:var(--accent);">Tokens: ${p.maxTokens}</span>
            </div>
            <div class="preset-card-preview mt-sm">${escHtml((p.systemPrompt || '').slice(0, 120))}${(p.systemPrompt || '').length > 120 ? '...' : ''}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function renderEditor() {
    let preset = { name: '', description: '', temperature: 0.7, topP: 0.9, maxTokens: 2048, systemPrompt: '', frequencyPenalty: 0, presencePenalty: 0 };
    if (editingId) {
      const saved = await DB.get(DB.STORES.presets, editingId);
      if (saved) preset = { ...preset, ...saved };
    }

    return `
      <div class="slide-up">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="btn btn-sm btn-secondary" onclick="PresetsPage.backToList()">&#8592; Back</button>
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

        <button class="btn btn-primary btn-block mt-sm" onclick="PresetsPage.savePreset()">
          ${editingId ? 'Update' : 'Create'} Preset
        </button>
      </div>
    `;
  }

  function newPreset() {
    currentView = 'edit';
    editingId = null;
    App.refreshPage();
  }

  async function editPreset(id) {
    currentView = 'edit';
    editingId = id;
    App.refreshPage();
  }

  function backToList() {
    currentView = 'list';
    editingId = null;
    App.refreshPage();
  }

  async function savePreset() {
    const name = document.getElementById('preset-name').value.trim();
    if (!name) return App.toast('Name is required', 'error');

    const preset = {
      id: editingId || DB.uuid(),
      name,
      description: document.getElementById('preset-desc').value.trim(),
      systemPrompt: document.getElementById('preset-system').value.trim(),
      temperature: parseFloat(document.getElementById('preset-temp').value),
      topP: parseFloat(document.getElementById('preset-topp').value),
      maxTokens: parseInt(document.getElementById('preset-tokens').value),
      frequencyPenalty: parseFloat(document.getElementById('preset-freq').value),
      presencePenalty: parseFloat(document.getElementById('preset-pres').value),
      createdAt: editingId ? (await DB.get(DB.STORES.presets, editingId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await DB.put(DB.STORES.presets, preset);
    App.toast(`Preset ${editingId ? 'updated' : 'created'}!`, 'success');
    backToList();
  }

  async function deletePreset(id, name) {
    App.showModal(`
      <div class="modal-title">Delete Preset</div>
      <p>Delete preset <strong>${escHtml(name)}</strong>?</p>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-danger btn-sm" onclick="PresetsPage.confirmDelete('${id}')">Delete</button>
      </div>
    `);
  }

  async function confirmDelete(id) {
    await DB.del(DB.STORES.presets, id);
    App.hideModal();
    App.toast('Preset deleted', 'info');
    App.refreshPage();
  }

  function onUnmount() {
    currentView = 'list';
    editingId = null;
  }

  return { render, onUnmount, newPreset, editPreset, backToList, savePreset, deletePreset, confirmDelete };
})();
