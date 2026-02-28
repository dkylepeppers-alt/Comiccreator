/**
 * Character Builder Page
 */
const CharactersPage = (() => {
  let currentView = 'list'; // 'list' or 'edit'
  let editingId = null;

  async function render(param) {
    if (param === 'new') {
      currentView = 'edit';
      editingId = null;
    } else if (param) {
      // param is a character ID — switch to edit mode
      currentView = 'edit';
      editingId = param;
    } else {
      // Reset to list view on normal navigation (prevents stale edit state)
      currentView = 'list';
      editingId = null;
    }
    if (currentView === 'edit') return renderEditor();
    return renderList();
  }

  async function renderList() {
    const characters = await DB.getAll(DB.STORES.characters);
    characters.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return `
      <div class="slide-up">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div>
            <h2 class="section-title" style="margin-bottom:4px;">Character Builder</h2>
            <p class="text-sm text-muted">Design heroes, sidekicks, and villains</p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="CharactersPage.newCharacter()">+ New</button>
        </div>

        ${characters.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">&#129464;</div>
            <div class="empty-state-text">No characters yet. Create your first hero!</div>
            <button class="btn btn-primary" onclick="CharactersPage.newCharacter()">Create Character</button>
          </div>
        ` : characters.map(c => `
          <div class="list-item" onclick="CharactersPage.editCharacter('${c.id}')">
            <div class="list-item-avatar">
              ${c.imageData ? `<img src="${c.imageData}" alt="${escHtml(c.name)}">` : '&#129464;'}
            </div>
            <div class="list-item-info">
              <div class="list-item-title">${escHtml(c.name)}</div>
              <div class="list-item-desc">${escHtml(c.role || 'No role')} &middot; ${escHtml(c.description || '').slice(0, 60)}</div>
            </div>
            <div class="list-item-actions">
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();CharactersPage.deleteCharacter('${c.id}','${escHtml(c.name)}')">&#128465;</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function renderEditor() {
    let char = { name: '', role: 'hero', description: '', appearance: '', backstory: '', powers: '', imageData: '' };
    if (editingId) {
      const saved = await DB.get(DB.STORES.characters, editingId);
      if (saved) char = saved;
    }

    return `
      <div class="slide-up">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="btn btn-sm btn-secondary" onclick="CharactersPage.backToList()">&#8592; Back</button>
          <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} Character</h2>
        </div>

        <div class="card">
          <!-- Reference Image -->
          <div class="form-group">
            <label class="form-label">Reference Image</label>
            <div class="img-upload" id="char-img-upload" onclick="CharactersPage.pickImage()">
              ${char.imageData ? `<img src="${char.imageData}" alt="Reference">` : '<span>&#128247; Tap to upload</span>'}
            </div>
            <input type="file" id="char-img-input" accept="image/*" class="hidden" onchange="CharactersPage.handleImage(event)">
          </div>

          <div class="form-group">
            <label class="form-label">Name *</label>
            <input type="text" id="char-name" value="${escHtml(char.name)}" placeholder="e.g. Captain Nova">
          </div>

          <div class="form-group">
            <label class="form-label">Role</label>
            <select id="char-role">
              ${['hero', 'sidekick', 'villain', 'antihero', 'mentor', 'support', 'other'].map(r =>
                `<option value="${r}" ${char.role === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`
              ).join('')}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Description *</label>
            <textarea id="char-desc" rows="3" placeholder="Brief character summary...">${escHtml(char.description)}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Appearance</label>
            <textarea id="char-appearance" rows="3" placeholder="Physical appearance, costume, distinguishing features...">${escHtml(char.appearance)}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Backstory</label>
            <textarea id="char-backstory" rows="3" placeholder="Origin story, motivation...">${escHtml(char.backstory)}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Powers / Abilities</label>
            <textarea id="char-powers" rows="2" placeholder="Special abilities, skills, weapons...">${escHtml(char.powers)}</textarea>
          </div>
        </div>

        <button class="btn btn-primary btn-block mt-sm" onclick="CharactersPage.saveCharacter()">
          ${editingId ? 'Update' : 'Create'} Character
        </button>
      </div>
    `;
  }

  function newCharacter() {
    App.navigate('characters', 'new');
  }

  async function editCharacter(id) {
    App.navigate('characters', id);
  }

  function backToList() {
    App.navigate('characters', null);
  }

  function pickImage() {
    document.getElementById('char-img-input').click();
  }

  async function handleImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    const dataUrl = await DB.fileToDataURL(file);
    const upload = document.getElementById('char-img-upload');
    upload.innerHTML = `<img src="${dataUrl}" alt="Reference">`;
    upload.dataset.imageData = dataUrl;
  }

  async function saveCharacter() {
    const name = document.getElementById('char-name').value.trim();
    const description = document.getElementById('char-desc').value.trim();
    if (!name) return App.toast('Name is required', 'error');
    if (!description) return App.toast('Description is required', 'error');

    const upload = document.getElementById('char-img-upload');
    const char = {
      id: editingId || DB.uuid(),
      name,
      role: document.getElementById('char-role').value,
      description,
      appearance: document.getElementById('char-appearance').value.trim(),
      backstory: document.getElementById('char-backstory').value.trim(),
      powers: document.getElementById('char-powers').value.trim(),
      imageData: upload.dataset?.imageData || (editingId ? (await DB.get(DB.STORES.characters, editingId))?.imageData : '') || '',
      createdAt: editingId ? (await DB.get(DB.STORES.characters, editingId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await DB.put(DB.STORES.characters, char);
    App.toast(`Character ${editingId ? 'updated' : 'created'}!`, 'success');
    backToList();
  }

  async function deleteCharacter(id, name) {
    App.showModal(`
      <div class="modal-title">Delete Character</div>
      <p>Are you sure you want to delete <strong>${escHtml(name)}</strong>?</p>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-danger btn-sm" onclick="CharactersPage.confirmDelete('${id}')">Delete</button>
      </div>
    `);
  }

  async function confirmDelete(id) {
    await DB.del(DB.STORES.characters, id);
    App.hideModal();
    App.toast('Character deleted', 'info');
    App.refreshPage();
  }

  return { render, newCharacter, editCharacter, backToList, pickImage, handleImage, saveCharacter, deleteCharacter, confirmDelete };
})();
