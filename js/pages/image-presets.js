/**
 * Image Style Presets Page
 * Manage reusable image style prompt prefixes for comic generation.
 */
const ImagePresetsPage = (() => {
  let currentView = 'list';
  let editingId = null;

  async function render(param) {
    if (param === 'new') {
      currentView = 'edit';
      editingId = null;
    } else if (param) {
      currentView = 'edit';
      editingId = param;
    } else {
      currentView = 'list';
      editingId = null;
    }
    if (currentView === 'edit') return renderEditor();
    return renderList();
  }

  async function renderList() {
    const presets = dedupeByNameLatest(await DB.getAll(DB.STORES.imagePresets));

    return `
      <div class="slide-up">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div>
            <h2 class="section-title" style="margin-bottom:4px;">Image Style Presets</h2>
            <p class="text-sm text-muted">Reusable art style prefixes for image generation</p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="ImagePresetsPage.newPreset()">+ New</button>
        </div>

        ${presets.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">&#127912;</div>
            <div class="empty-state-text">No image presets yet.</div>
            <button class="btn btn-primary" onclick="ImagePresetsPage.newPreset()">Create Preset</button>
          </div>
        ` : presets.map(p => `
          <div class="preset-card" onclick="ImagePresetsPage.editPreset('${p.id}')">
            <div style="display:flex;justify-content:space-between;align-items:start;">
              <div>
                <div class="preset-card-name">${escHtml(p.name)}</div>
                <div class="text-sm text-muted">${escHtml(p.description || '')}</div>
              </div>
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();ImagePresetsPage.deletePreset('${p.id}')">&#128465;</button>
            </div>
            <div class="preset-card-preview mt-sm">${escHtml((p.promptPrefix || '').slice(0, 120))}${(p.promptPrefix || '').length > 120 ? '...' : ''}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function renderEditor() {
    let preset = { name: '', description: '', promptPrefix: '' };
    if (editingId) {
      const saved = await DB.get(DB.STORES.imagePresets, editingId);
      if (saved) preset = { ...preset, ...saved };
    }

    return `
      <div class="slide-up">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="btn btn-sm btn-secondary" onclick="ImagePresetsPage.backToList()">&#8592; Back</button>
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

        <button class="btn btn-primary btn-block mt-sm" onclick="ImagePresetsPage.savePreset()">
          ${editingId ? 'Update' : 'Create'} Preset
        </button>
      </div>
    `;
  }

  function newPreset() {
    App.navigate('image-presets', 'new');
  }

  async function editPreset(id) {
    App.navigate('image-presets', id);
  }

  function backToList() {
    App.navigate('image-presets', null);
  }

  async function savePreset() {
    const name = document.getElementById('imgpreset-name').value.trim();
    if (!name) return App.toast('Name is required', 'error');

    const promptPrefix = document.getElementById('imgpreset-prefix').value.trim();
    if (!promptPrefix) return App.toast('Prompt prefix is required', 'error');

    const preset = {
      id: editingId || DB.uuid(),
      name,
      description: document.getElementById('imgpreset-desc').value.trim(),
      promptPrefix,
      createdAt: editingId ? (await DB.get(DB.STORES.imagePresets, editingId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await DB.put(DB.STORES.imagePresets, preset);
    App.toast(`Image preset ${editingId ? 'updated' : 'created'}!`, 'success');
    backToList();
  }

  async function deletePreset(id) {
    const preset = await DB.get(DB.STORES.imagePresets, id);
    const name = preset?.name || 'this preset';
    App.showModal(`
      <div class="modal-title">Delete Image Preset</div>
      <p>Delete preset <strong>${escHtml(name)}</strong>?</p>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-danger btn-sm" onclick="ImagePresetsPage.confirmDelete('${id}')">Delete</button>
      </div>
    `);
  }

  async function confirmDelete(id) {
    await DB.del(DB.STORES.imagePresets, id);
    App.hideModal();
    App.toast('Image preset deleted', 'info');
    App.refreshPage();
  }

  function onUnmount() {
    currentView = 'list';
    editingId = null;
  }

  return { render, onUnmount, newPreset, editPreset, backToList, savePreset, deletePreset, confirmDelete };
})();
