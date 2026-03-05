/**
 * World Builder Page
 */
const WorldsPage = (() => {
  let currentView = 'list';
  let editingId = null;

  // In-editor image list: [{ dataUrl, tag, description, embedding }]
  let editorImages = [];
  let editorPrimaryIndex = 0;
  // Index of the image slot currently being filled (for file picker)
  let _pendingSlotIdx = -1;

  const IMAGE_TAGS = ['establishing', 'interior', 'exterior', 'aerial', 'night', 'day', 'detail', 'landmark', 'custom'];
  const MAX_IMAGES = 6;

  async function render(param) {
    if (param === 'new') {
      currentView = 'edit';
      editingId = null;
    } else if (param) {
      // param is a world ID — switch to edit mode
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
        ` : worlds.map(w => {
          const migrated = DB.migrateWorld(w);
          const thumb = migrated.images?.[migrated.primaryImageIndex ?? 0]?.dataUrl || '';
          return `
          <div class="list-item" onclick="WorldsPage.editWorld('${w.id}')">
            <div class="list-item-avatar">
              ${thumb ? `<img src="${escHtml(thumb)}" alt="${escHtml(w.name)}">` : '&#127758;'}
            </div>
            <div class="list-item-info">
              <div class="list-item-title">${escHtml(w.name)}</div>
              <div class="list-item-desc">${escHtml(w.description || '').slice(0, 80)}</div>
            </div>
            <div class="list-item-actions">
              <button class="btn btn-sm btn-secondary" title="Export" onclick="event.stopPropagation();WorldsPage.exportWorld('${w.id}')">&#128229;</button>
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();WorldsPage.deleteWorld('${w.id}','${escHtml(w.name)}')">&#128465;</button>
            </div>
          </div>
        `}).join('')}
      </div>
    `;
  }

  async function renderEditor() {
    let world = { name: '', description: '', details: '', era: '', atmosphere: '', images: [], primaryImageIndex: 0 };
    if (editingId) {
      const saved = await DB.get(DB.STORES.worlds, editingId);
      if (saved) world = DB.migrateWorld(saved);
    }
    editorImages = (world.images || []).map(img => Object.assign({}, img));
    editorPrimaryIndex = world.primaryImageIndex ?? 0;

    return `
      <div class="slide-up">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="btn btn-sm btn-secondary" onclick="WorldsPage.backToList()">&#8592; Back</button>
          <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} World</h2>
          ${editingId ? `<button class="btn btn-sm btn-secondary" style="margin-left:auto;" title="Exports last saved version" onclick="WorldsPage.exportWorld('${editingId}')">&#128229; Export</button>` : ''}
        </div>

        <div class="card">
          <!-- Reference Images (up to ${MAX_IMAGES}) -->
          <div class="form-group">
            <label class="form-label">Reference Images (up to ${MAX_IMAGES})</label>
            <div class="char-img-gallery" id="world-img-gallery">
              ${renderGallerySlots(editorImages, editorPrimaryIndex)}
            </div>
            <input type="file" id="world-img-input" accept="image/*" class="hidden" onchange="WorldsPage.handleImage(event)">
            ${editorImages.length < MAX_IMAGES ? `<button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="WorldsPage.addImageSlot()">+ Add Image</button>` : ''}
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

        <button class="btn btn-primary btn-block mt-sm" id="world-save-btn" onclick="WorldsPage.saveWorld()">
          ${editingId ? 'Update' : 'Create'} World
        </button>
      </div>
    `;
  }

  function renderGallerySlots(images, primaryIdx) {
    return images.map((img, i) => `
      <div class="char-img-slot" data-idx="${i}">
        <div class="char-img-slot-preview ${!img.dataUrl ? 'char-img-slot-empty' : ''}" onclick="WorldsPage.pickImageForSlot(${i})">
          ${img.dataUrl ? `<img src="${escHtml(img.dataUrl)}" alt="Ref ${i+1}">` : '<span>&#128247; Upload</span>'}
        </div>
        <div class="char-img-meta">
          <select class="char-img-tag" data-idx="${i}" onchange="WorldsPage.updateTag(${i},this.value)">
            ${IMAGE_TAGS.map(t => `<option value="${t}" ${img.tag === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <input type="text" class="char-img-desc" data-idx="${i}" value="${escHtml(img.description || '')}" placeholder="e.g. Neon-lit alley at night" oninput="WorldsPage.updateDesc(${i},this.value)">
          <div class="char-img-actions">
            <button class="char-img-primary ${i === primaryIdx ? 'active' : ''}" title="Set as primary" onclick="WorldsPage.setPrimary(${i})">&#11088;</button>
            <button class="char-img-delete" title="Remove" onclick="WorldsPage.removeImage(${i})">&#x2715;</button>
          </div>
        </div>
      </div>
    `).join('');
  }

  function refreshGallery() {
    const gallery = document.getElementById('world-img-gallery');
    if (!gallery) return;
    gallery.innerHTML = renderGallerySlots(editorImages, editorPrimaryIndex);
    let addBtn = gallery.nextElementSibling;
    let steps = 0;
    // Walk past the hidden file input to find the "+ Add Image" button (≤5 siblings)
    while (addBtn && addBtn.tagName !== 'BUTTON' && steps < 5) {
      addBtn = addBtn.nextElementSibling;
      steps++;
    }
    if (addBtn && addBtn.tagName === 'BUTTON') {
      addBtn.style.display = editorImages.length < MAX_IMAGES ? '' : 'none';
    }
  }

  function addImageSlot() {
    if (editorImages.length >= MAX_IMAGES) return App.toast(`Maximum ${MAX_IMAGES} images`, 'error');
    editorImages.push({ dataUrl: '', tag: 'establishing', description: '', embedding: null, embeddingText: null });
    refreshGallery();
    pickImageForSlot(editorImages.length - 1);
  }

  function pickImageForSlot(idx) {
    _pendingSlotIdx = idx;
    document.getElementById('world-img-input').click();
  }

  function newWorld() {
    App.navigate('worlds', 'new');
  }

  async function editWorld(id) {
    App.navigate('worlds', id);
  }

  function backToList() {
    App.navigate('worlds', null);
  }

  // Legacy handler kept for backward compat
  function pickImage(idx) {
    pickImageForSlot(idx);
  }

  async function handleImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    const dataUrl = await DB.fileToDataURL(file);
    const idx = _pendingSlotIdx >= 0 ? _pendingSlotIdx : 0;
    if (idx >= editorImages.length) {
      editorImages.push({ dataUrl, tag: 'establishing', description: '', embedding: null, embeddingText: null });
    } else {
      editorImages[idx] = Object.assign({}, editorImages[idx], { dataUrl, embedding: null, embeddingText: null });
    }
    refreshGallery();
    event.target.value = '';

    // Auto-caption: if the slot has no description, generate one via vision model
    const img = editorImages[idx];
    if (img && !img.description?.trim()) {
      const descInput = document.querySelector(`.char-img-desc[data-idx="${idx}"]`);
      if (descInput) {
        descInput.disabled = true;
        descInput.placeholder = 'Generating caption\u2026';
      }
      const name = document.getElementById('world-name')?.value.trim() || '';
      const era = document.getElementById('world-era')?.value.trim() || '';
      const caption = await API.generateImageCaption(dataUrl, {
        type: 'world',
        name,
        era,
        tag: img.tag,
      }).catch(() => null);
      // Only apply if this slot wasn't replaced while we were waiting
      if (editorImages[idx] === img && !img.description?.trim() && caption) {
        img.description = caption;
        img.embedding = null;
        img.embeddingText = null;
      }
      if (descInput) {
        descInput.disabled = false;
        descInput.placeholder = 'e.g. Neon-lit alley at night';
        if (img.description) descInput.value = img.description;
      }
    }
  }

  function updateTag(idx, value) {
    if (editorImages[idx]) {
      editorImages[idx].tag = value;
      editorImages[idx].embedding = null; // tag is part of enriched embedding text
      editorImages[idx].embeddingText = null;
    }
  }

  function updateDesc(idx, value) {
    if (editorImages[idx]) {
      editorImages[idx].description = value;
      editorImages[idx].embedding = null; // invalidate stale embedding
      editorImages[idx].embeddingText = null;
    }
  }

  function setPrimary(idx) {
    editorPrimaryIndex = idx;
    document.querySelectorAll('#world-img-gallery .char-img-primary').forEach((btn, i) => {
      btn.classList.toggle('active', i === idx);
    });
  }

  function removeImage(idx) {
    editorImages.splice(idx, 1);
    if (editorPrimaryIndex >= editorImages.length) editorPrimaryIndex = Math.max(0, editorImages.length - 1);
    refreshGallery();
  }

  async function saveWorld() {
    const name = document.getElementById('world-name').value.trim();
    const description = document.getElementById('world-desc').value.trim();
    if (!name) return App.toast('World name is required', 'error');
    if (!description) return App.toast('Description is required', 'error');

    // Filter out empty slots (no dataUrl), remapping primary index to the filtered list
    const validImages = [];
    let primaryIdx = 0;
    editorImages.forEach((img, idx) => {
      if (!img || !img.dataUrl) return;
      if (idx === editorPrimaryIndex) primaryIdx = validImages.length;
      validImages.push(img);
    });
    if (validImages.length > 0 && primaryIdx >= validImages.length) primaryIdx = 0;

    // Generate (or re-generate) embeddings for images whose enriched text has changed
    const needsEmbedding = validImages.filter(img => {
      if (!img.description?.trim()) return false;
      const enriched = buildImageEmbeddingText(img, name);
      // Re-embed if text changed (new description, tag change, name change, or first-time)
      return img.embeddingText !== enriched || !img.embedding;
    });
    if (needsEmbedding.length > 0) {
      const saveBtn = document.getElementById('world-save-btn');
      if (saveBtn) saveBtn.textContent = 'Generating embeddings...';
      await Promise.all(needsEmbedding.map(async (img) => {
        const enriched = buildImageEmbeddingText(img, name);
        try {
          const emb = await API.generateEmbedding(enriched);
          if (emb) {
            img.embedding = emb;
            img.embeddingText = enriched;
          }
        } catch { /* skip on error */ }
      }));
      if (saveBtn) saveBtn.textContent = editingId ? 'Update World' : 'Create World';
    }

    const existingWorld = editingId ? await DB.get(DB.STORES.worlds, editingId) : null;

    const world = {
      id: editingId || DB.uuid(),
      name,
      description,
      era: document.getElementById('world-era').value.trim(),
      atmosphere: document.getElementById('world-atmosphere').value.trim(),
      details: document.getElementById('world-details').value.trim(),
      images: validImages,
      primaryImageIndex: primaryIdx,
      createdAt: existingWorld?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    await DB.put(DB.STORES.worlds, world);
    App.toast(`World ${editingId ? 'updated' : 'created'}!`, 'success');
    backToList();
  }

  async function exportWorld(id) {
    const world = await DB.get(DB.STORES.worlds, id);
    if (!world) return App.toast('World not found', 'error');
    const data = {
      worlds: [world],
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = world.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.download = `world-${safeName}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    App.toast('World exported!', 'success');
  }

  async function deleteWorld(id, name) {
    App.showModal(`
      <div class="modal-title">Delete World</div>
      <p>Are you sure you want to delete <strong>${escHtml(name)}</strong>?</p>
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

  return {
    render, newWorld, editWorld, backToList,
    pickImage, pickImageForSlot, handleImage, addImageSlot,
    updateTag, updateDesc, setPrimary, removeImage,
    saveWorld, exportWorld, deleteWorld, confirmDelete,
  };
})();
