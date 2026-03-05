/**
 * Character Builder Page
 */
const CharactersPage = (() => {
  let currentView = 'list'; // 'list' or 'edit'
  let editingId = null;

  // In-editor image list: [{ dataUrl, tag, description, embedding }]
  let editorImages = [];
  let editorPrimaryIndex = 0;
  let editorName = '';
  // Index of the image slot currently being filled (for file picker)
  let _pendingSlotIdx = -1;

  const IMAGE_TAGS = ['default', 'front-view', 'side-view', 'back-view', 'close-up', 'action-pose', 'alternate-outfit', 'expression', 'custom'];
  const MAX_IMAGES = 12;

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
        ` : characters.map(c => {
          const migrated = DB.migrateCharacter(c);
          const thumb = migrated.images?.[migrated.primaryImageIndex ?? 0]?.dataUrl || migrated.imageData || '';
          return `
          <div class="list-item" onclick="CharactersPage.editCharacter('${c.id}')">
            <div class="list-item-avatar">
              ${thumb ? `<img src="${thumb}" alt="${escHtml(c.name)}">` : '&#129464;'}
            </div>
            <div class="list-item-info">
              <div class="list-item-title">${escHtml(c.name)}</div>
              <div class="list-item-desc">${escHtml(c.role || 'No role')} &middot; ${escHtml(c.description || '').slice(0, 60)}</div>
            </div>
            <div class="list-item-actions">
              <button class="btn btn-sm btn-secondary" title="Export" onclick="event.stopPropagation();CharactersPage.exportCharacter('${c.id}')">&#128229;</button>
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();CharactersPage.deleteCharacter('${c.id}','${escHtml(c.name)}')">&#128465;</button>
            </div>
          </div>
        `}).join('')}
      </div>
    `;
  }

  async function renderEditor() {
    let char = { name: '', role: 'hero', description: '', appearance: '', backstory: '', powers: '', images: [], primaryImageIndex: 0 };
    if (editingId) {
      const saved = await DB.get(DB.STORES.characters, editingId);
      if (saved) char = DB.migrateCharacter(saved);
    }
    editorImages = (char.images || []).map(img => Object.assign({}, img));
    editorPrimaryIndex = char.primaryImageIndex ?? 0;
    editorName = char.name || '';

    return `
      <div class="slide-up">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="btn btn-sm btn-secondary" onclick="CharactersPage.backToList()">&#8592; Back</button>
          <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} Character</h2>
          ${editingId ? `<button class="btn btn-sm btn-secondary" style="margin-left:auto;" title="Exports last saved version" onclick="CharactersPage.exportCharacter('${editingId}')">&#128229; Export</button>` : ''}
        </div>

        <div class="card">
          <!-- Reference Images (up to ${MAX_IMAGES}) -->
          <div class="form-group">
            <label class="form-label">Reference Images (up to ${MAX_IMAGES})</label>
            <div class="char-img-gallery" id="char-img-gallery">
              ${renderGallerySlots(editorImages, editorPrimaryIndex)}
            </div>
            <input type="file" id="char-img-input" accept="image/*" class="hidden" onchange="CharactersPage.handleImage(event)">
            <div class="char-img-toolbar" id="char-img-toolbar">
              ${editorImages.length < MAX_IMAGES ? `<button class="btn btn-secondary btn-sm" onclick="CharactersPage.addImageSlot()">+ Add Image</button>` : ''}
              <button class="btn btn-secondary btn-sm" id="char-caption-all-btn" onclick="CharactersPage.recaptionAll()" style="${editorImages.some(img => img.dataUrl) ? '' : 'display:none'}">&#128221; Caption All</button>
            </div>
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

        <button class="btn btn-primary btn-block mt-sm" id="char-save-btn" onclick="CharactersPage.saveCharacter()">
          ${editingId ? 'Update' : 'Create'} Character
        </button>
      </div>
    `;
  }

  function renderGallerySlots(images, primaryIdx) {
    const charName = editorName;
    return images.map((img, i) => {
      // Embedding status badge
      let embBadge = '';
      if (img.dataUrl) {
        if (img.embedding && img.embeddingText) {
          const enriched = (typeof buildImageEmbeddingText === 'function') ? buildImageEmbeddingText(img, charName) : '';
          if (enriched && img.embeddingText === enriched) {
            embBadge = '<span class="char-img-emb-badge emb-valid" title="Embedding up to date">&#10003; embedded</span>';
          } else {
            embBadge = '<span class="char-img-emb-badge emb-stale" title="Embedding outdated — save to update">&#8635; stale</span>';
          }
        } else if (img.description?.trim()) {
          embBadge = '<span class="char-img-emb-badge emb-missing" title="No embedding yet — save to generate">&mdash; not embedded</span>';
        }
      }
      return `
      <div class="char-img-slot" data-idx="${i}">
        <div class="char-img-slot-preview ${!img.dataUrl ? 'char-img-slot-empty' : ''}" onclick="CharactersPage.pickImageForSlot(${i})">
          ${img.dataUrl ? `<img src="${escHtml(img.dataUrl)}" alt="Ref ${i+1}">` : '<span>&#128247; Upload</span>'}
        </div>
        <div class="char-img-meta">
          <div style="display:flex;align-items:center;gap:6px;">
            <select class="char-img-tag" data-idx="${i}" onchange="CharactersPage.updateTag(${i},this.value)" style="flex:1;">
              ${IMAGE_TAGS.map(t => `<option value="${t}" ${img.tag === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            ${embBadge}
          </div>
          <input type="text" class="char-img-desc" data-idx="${i}" value="${escHtml(img.description || '')}" placeholder="e.g. Battle armor with sword drawn" oninput="CharactersPage.updateDesc(${i},this.value)">
          <div class="char-img-actions">
            <button class="char-img-primary ${i === primaryIdx ? 'active' : ''}" title="Set as primary" onclick="CharactersPage.setPrimary(${i})">&#11088;</button>
            ${img.dataUrl ? `<button class="char-img-caption" title="Auto-caption this image" onclick="CharactersPage.recaptionImage(${i})">&#128221;</button>` : ''}
            <button class="char-img-delete" title="Remove" onclick="CharactersPage.removeImage(${i})">&#x2715;</button>
          </div>
        </div>
      </div>
    `;}).join('');
  }

  function refreshGallery() {
    const gallery = document.getElementById('char-img-gallery');
    if (!gallery) return;
    // Sync editorName from DOM (available after initial render)
    const nameEl = document.getElementById('char-name');
    if (nameEl) editorName = nameEl.value.trim();
    gallery.innerHTML = renderGallerySlots(editorImages, editorPrimaryIndex);
    // Update toolbar button visibility
    const toolbar = document.getElementById('char-img-toolbar');
    if (toolbar) {
      const hasImages = editorImages.some(img => img.dataUrl);
      // Rebuild toolbar contents to reflect current state
      let btns = '';
      if (editorImages.length < MAX_IMAGES) {
        btns += '<button class="btn btn-secondary btn-sm" onclick="CharactersPage.addImageSlot()">+ Add Image</button>';
      }
      if (hasImages) {
        btns += '<button class="btn btn-secondary btn-sm" id="char-caption-all-btn" onclick="CharactersPage.recaptionAll()">&#128221; Caption All</button>';
      }
      toolbar.innerHTML = btns;
    }
  }

  function addImageSlot() {
    if (editorImages.length >= MAX_IMAGES) return App.toast(`Maximum ${MAX_IMAGES} images`, 'error');
    editorImages.push({ dataUrl: '', tag: 'default', description: '', embedding: null, embeddingText: null });
    refreshGallery();
    // Immediately open file picker for the new slot
    pickImageForSlot(editorImages.length - 1);
  }

  function pickImageForSlot(idx) {
    _pendingSlotIdx = idx;
    document.getElementById('char-img-input').click();
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

  // Legacy single-upload handler (kept for backward compat)
  function pickImage() {
    pickImageForSlot(0);
  }

  async function handleImage(event) {
    const file = event.target.files[0];
    if (!file) {
      // File picker was cancelled — remove the empty slot created by addImageSlot()
      if (_pendingSlotIdx >= 0 && _pendingSlotIdx < editorImages.length && !editorImages[_pendingSlotIdx].dataUrl) {
        editorImages.splice(_pendingSlotIdx, 1);
        if (editorPrimaryIndex >= editorImages.length) editorPrimaryIndex = Math.max(0, editorImages.length - 1);
        refreshGallery();
      }
      _pendingSlotIdx = -1;
      return;
    }
    const dataUrl = await DB.fileToDataURL(file);
    const idx = _pendingSlotIdx >= 0 ? _pendingSlotIdx : 0;
    if (idx >= editorImages.length) {
      editorImages.push({ dataUrl, tag: 'default', description: '', embedding: null, embeddingText: null });
    } else {
      editorImages[idx] = Object.assign({}, editorImages[idx], { dataUrl, embedding: null, embeddingText: null });
    }
    refreshGallery();
    // Reset file input so same file can be re-picked
    event.target.value = '';

    // Auto-caption: if the slot has no description, generate one via vision model
    const img = editorImages[idx];
    if (img && !img.description?.trim()) {
      const descInput = document.querySelector(`.char-img-desc[data-idx="${idx}"]`);
      if (descInput) {
        descInput.disabled = true;
        descInput.placeholder = 'Generating caption\u2026';
      }
      const name = document.getElementById('char-name')?.value.trim() || '';
      const role = document.getElementById('char-role')?.value || '';
      const appearance = document.getElementById('char-appearance')?.value.trim() || '';
      const caption = await API.generateImageCaption(dataUrl, {
        type: 'character',
        name,
        role,
        tag: img.tag,
        appearance,
      }).catch(() => null);
      // Only apply if this slot wasn't replaced while we were waiting
      if (editorImages[idx] === img && !img.description?.trim() && caption) {
        img.description = caption;
        img.embedding = null;
        img.embeddingText = null;
      }
      if (descInput) {
        descInput.disabled = false;
        descInput.placeholder = 'e.g. Battle armor with sword drawn';
        if (img.description) descInput.value = img.description;
      }
    }
  }

  async function recaptionImage(idx) {
    const img = editorImages[idx];
    if (!img || !img.dataUrl) return App.toast('No image to caption', 'error');

    const descInput = document.querySelector(`.char-img-desc[data-idx="${idx}"]`);
    const captionBtn = document.querySelector(`.char-img-caption[onclick*="recaptionImage(${idx})"]`);
    if (descInput) { descInput.disabled = true; descInput.placeholder = 'Generating caption\u2026'; }
    if (captionBtn) captionBtn.disabled = true;

    const name = document.getElementById('char-name')?.value.trim() || '';
    const role = document.getElementById('char-role')?.value || '';
    const appearance = document.getElementById('char-appearance')?.value.trim() || '';
    const caption = await API.generateImageCaption(img.dataUrl, {
      type: 'character',
      name,
      role,
      tag: img.tag,
      appearance,
    }).catch(() => null);

    if (caption) {
      img.description = caption;
      img.embedding = null;
      img.embeddingText = null;
      if (descInput) descInput.value = caption;
    } else {
      App.toast('Caption generation failed or is unsupported by this model', 'error');
    }

    if (descInput) {
      descInput.disabled = false;
      descInput.placeholder = 'e.g. Battle armor with sword drawn';
    }
    if (captionBtn) captionBtn.disabled = false;
  }

  async function recaptionAll() {
    const imagesWithData = editorImages.filter(img => img.dataUrl);
    if (!imagesWithData.length) return App.toast('No images to caption', 'error');

    const captionAllBtn = document.getElementById('char-caption-all-btn');
    if (captionAllBtn) { captionAllBtn.disabled = true; captionAllBtn.textContent = 'Captioning\u2026'; }

    const name = document.getElementById('char-name')?.value.trim() || '';
    const role = document.getElementById('char-role')?.value || '';
    const appearance = document.getElementById('char-appearance')?.value.trim() || '';

    let done = 0;
    let failed = 0;
    for (let i = 0; i < editorImages.length; i++) {
      const img = editorImages[i];
      if (!img.dataUrl) continue;
      done++;
      if (captionAllBtn) captionAllBtn.textContent = `Captioning ${done}/${imagesWithData.length}\u2026`;

      const descInput = document.querySelector(`.char-img-desc[data-idx="${i}"]`);
      if (descInput) { descInput.disabled = true; descInput.placeholder = 'Generating caption\u2026'; }

      const caption = await API.generateImageCaption(img.dataUrl, {
        type: 'character', name, role, tag: img.tag, appearance,
      }).catch(() => null);

      if (caption && editorImages[i] === img) {
        img.description = caption;
        img.embedding = null;
        img.embeddingText = null;
        if (descInput) descInput.value = caption;
      } else {
        failed++;
      }
      if (descInput) { descInput.disabled = false; descInput.placeholder = 'e.g. Battle armor with sword drawn'; }
    }

    if (captionAllBtn) { captionAllBtn.disabled = false; captionAllBtn.textContent = '\u{1F4DD} Caption All'; }
    if (failed > 0) {
      App.toast(`Captioned ${done - failed}/${done} images (${failed} failed)`, 'info');
    } else {
      App.toast(`Captioned ${done} image(s)`, 'success');
    }
    refreshGallery();
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
    // Update star button states in place
    document.querySelectorAll('.char-img-primary').forEach((btn, i) => {
      btn.classList.toggle('active', i === idx);
    });
  }

  function removeImage(idx) {
    editorImages.splice(idx, 1);
    if (editorPrimaryIndex >= editorImages.length) editorPrimaryIndex = Math.max(0, editorImages.length - 1);
    refreshGallery();
  }

  async function saveCharacter() {
    const name = document.getElementById('char-name').value.trim();
    const description = document.getElementById('char-desc').value.trim();
    if (!name) return App.toast('Name is required', 'error');
    if (!description) return App.toast('Description is required', 'error');

    // Filter out empty slots (no dataUrl)
    const validImages = editorImages.filter(img => img.dataUrl);
    let primaryIdx = editorPrimaryIndex;
    if (primaryIdx >= validImages.length) primaryIdx = 0;

    // Generate (or re-generate) embeddings for images whose enriched text has changed
    const needsEmbedding = validImages.filter(img => {
      if (!img.description?.trim()) return false;
      const enriched = buildImageEmbeddingText(img, name);
      // Re-embed if text changed (new description, tag change, name change, or first-time)
      return img.embeddingText !== enriched || !img.embedding;
    });
    if (needsEmbedding.length > 0) {
      const saveBtn = document.getElementById('char-save-btn');
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
      if (saveBtn) saveBtn.textContent = editingId ? 'Update Character' : 'Create Character';
    }

    const existingChar = editingId ? await DB.get(DB.STORES.characters, editingId) : null;

    const char = {
      id: editingId || DB.uuid(),
      name,
      role: document.getElementById('char-role').value,
      description,
      appearance: document.getElementById('char-appearance').value.trim(),
      backstory: document.getElementById('char-backstory').value.trim(),
      powers: document.getElementById('char-powers').value.trim(),
      images: validImages,
      primaryImageIndex: primaryIdx,
      imageData: '',  // clear legacy field when images[] is present
      createdAt: existingChar?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    await DB.put(DB.STORES.characters, char);
    App.toast(`Character ${editingId ? 'updated' : 'created'}!`, 'success');
    backToList();
  }

  async function exportCharacter(id) {
    const char = await DB.get(DB.STORES.characters, id);
    if (!char) return App.toast('Character not found', 'error');
    const data = {
      characters: [char],
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = char.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.download = `character-${safeName}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    App.toast('Character exported!', 'success');
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

  return {
    render,
    newCharacter, editCharacter, backToList,
    pickImage, pickImageForSlot, handleImage, addImageSlot,
    updateTag, updateDesc, setPrimary, removeImage, recaptionImage, recaptionAll,
    saveCharacter, exportCharacter, deleteCharacter, confirmDelete,
  };
})();
