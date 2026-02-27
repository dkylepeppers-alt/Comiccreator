/**
 * World Builder Page
 */
const WorldsPage = (() => {
  let currentView = 'list';
  let editingId = null;

  async function render(param) {
    if (param === 'new') {
      currentView = 'edit';
      editingId = null;
    }
    if (currentView === 'edit') return renderEditor();
    return renderList();
  }

  async function renderList() {
    const worlds = await DB.getAll(DB.STORES.worlds);
    worlds.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return `
      <div class="slide-up">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div>
            <h2 class="section-title" style="margin-bottom:4px;">World Builder</h2>
            <p class="text-sm text-muted">Create settings for your comics</p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="WorldsPage.newWorld()">+ New</button>
        </div>

        ${worlds.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">&#127758;</div>
            <div class="empty-state-text">No worlds yet. Build your first setting!</div>
            <button class="btn btn-primary" onclick="WorldsPage.newWorld()">Create World</button>
          </div>
        ` : worlds.map(w => `
          <div class="list-item" onclick="WorldsPage.editWorld('${w.id}')">
            <div class="list-item-avatar">
              ${w.images && w.images[0] ? `<img src="${w.images[0]}" alt="${escHtml(w.name)}">` : '&#127758;'}
            </div>
            <div class="list-item-info">
              <div class="list-item-title">${escHtml(w.name)}</div>
              <div class="list-item-desc">${escHtml(w.description || '').slice(0, 80)}</div>
            </div>
            <div class="list-item-actions">
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();WorldsPage.deleteWorld('${w.id}','${escHtml(w.name)}')">&#128465;</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function renderEditor() {
    let world = { name: '', description: '', details: '', era: '', atmosphere: '', images: [] };
    if (editingId) {
      const saved = await DB.get(DB.STORES.worlds, editingId);
      if (saved) world = saved;
    }
    const images = world.images || [];

    return `
      <div class="slide-up">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="btn btn-sm btn-secondary" onclick="WorldsPage.backToList()">&#8592; Back</button>
          <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} World</h2>
        </div>

        <div class="card">
          <!-- Reference Images (up to 3) -->
          <div class="form-group">
            <label class="form-label">Reference Images (up to 3)</label>
            <div class="img-upload-grid" id="world-images">
              ${[0, 1, 2].map(i => `
                <div class="img-upload" data-idx="${i}" onclick="WorldsPage.pickImage(${i})">
                  ${images[i] ? `<img src="${images[i]}" alt="Ref ${i+1}">` : `<span>&#128247; Image ${i+1}</span>`}
                </div>
              `).join('')}
            </div>
            <input type="file" id="world-img-input" accept="image/*" class="hidden" onchange="WorldsPage.handleImage(event)">
          </div>

          <div class="form-group">
            <label class="form-label">World Name *</label>
            <input type="text" id="world-name" value="${escHtml(world.name)}" placeholder="e.g. Neo-Tokyo 2099">
          </div>

          <div class="form-group">
            <label class="form-label">Description *</label>
            <textarea id="world-desc" rows="3" placeholder="What makes this world unique...">${escHtml(world.description)}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Era / Time Period</label>
            <input type="text" id="world-era" value="${escHtml(world.era || '')}" placeholder="e.g. Distant future, Medieval, Modern day">
          </div>

          <div class="form-group">
            <label class="form-label">Atmosphere / Mood</label>
            <textarea id="world-atmosphere" rows="2" placeholder="e.g. Gritty and dark with neon-lit streets...">${escHtml(world.atmosphere || '')}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Additional Details</label>
            <textarea id="world-details" rows="3" placeholder="Key locations, technology level, magic systems, factions...">${escHtml(world.details || '')}</textarea>
          </div>
        </div>

        <button class="btn btn-primary btn-block mt-sm" onclick="WorldsPage.saveWorld()">
          ${editingId ? 'Update' : 'Create'} World
        </button>
      </div>
    `;
  }

  let activeImageIdx = 0;

  function newWorld() {
    currentView = 'edit';
    editingId = null;
    App.refreshPage();
  }

  async function editWorld(id) {
    currentView = 'edit';
    editingId = id;
    App.refreshPage();
  }

  function backToList() {
    currentView = 'list';
    editingId = null;
    App.refreshPage();
  }

  function pickImage(idx) {
    activeImageIdx = idx;
    document.getElementById('world-img-input').click();
  }

  async function handleImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    const dataUrl = await DB.fileToDataURL(file);
    const slots = document.querySelectorAll('#world-images .img-upload');
    const slot = slots[activeImageIdx];
    if (slot) {
      slot.innerHTML = `<img src="${dataUrl}" alt="Ref">`;
      slot.dataset.imageData = dataUrl;
    }
  }

  async function saveWorld() {
    const name = document.getElementById('world-name').value.trim();
    const description = document.getElementById('world-desc').value.trim();
    if (!name) return App.toast('World name is required', 'error');
    if (!description) return App.toast('Description is required', 'error');

    // Gather images
    const slots = document.querySelectorAll('#world-images .img-upload');
    const newImages = [];
    let existingImages = [];
    if (editingId) {
      const existing = await DB.get(DB.STORES.worlds, editingId);
      existingImages = existing?.images || [];
    }
    slots.forEach((slot, i) => {
      if (slot.dataset.imageData) {
        newImages[i] = slot.dataset.imageData;
      } else if (existingImages[i]) {
        newImages[i] = existingImages[i];
      }
    });
    const images = newImages.filter(Boolean);

    const world = {
      id: editingId || DB.uuid(),
      name,
      description,
      era: document.getElementById('world-era').value.trim(),
      atmosphere: document.getElementById('world-atmosphere').value.trim(),
      details: document.getElementById('world-details').value.trim(),
      images,
      createdAt: editingId ? (await DB.get(DB.STORES.worlds, editingId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await DB.put(DB.STORES.worlds, world);
    App.toast(`World ${editingId ? 'updated' : 'created'}!`, 'success');
    backToList();
  }

  async function deleteWorld(id, name) {
    App.showModal(`
      <div class="modal-title">Delete World</div>
      <p>Are you sure you want to delete <strong>${name}</strong>?</p>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-danger btn-sm" onclick="WorldsPage.confirmDelete('${id}')">Delete</button>
      </div>
    `);
  }

  async function confirmDelete(id) {
    await DB.del(DB.STORES.worlds, id);
    App.hideModal();
    App.toast('World deleted', 'info');
    App.refreshPage();
  }

  return { render, newWorld, editWorld, backToList, pickImage, handleImage, saveWorld, deleteWorld, confirmDelete };
})();
