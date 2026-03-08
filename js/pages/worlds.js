/**
 * World Builder Page
 */
const WorldsPage = (() => {
  let currentView = 'list';
  let editingId = null;

  // In-editor image list: [{ dataUrl, tag, description, embedding }]
  let editorImages = [];
  let editorPrimaryIndex = 0;
  let editorName = '';
  // Index of the image slot currently being filled (for file picker)
  let _pendingSlotIdx = -1;

  const IMAGE_TAGS = ['establishing', 'interior', 'exterior', 'aerial', 'night', 'day', 'detail', 'landmark', 'character-interaction', 'custom'];
  const MAX_IMAGES = 20;

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
    editorName = world.name || '';

    // Find characters linked to this world
    const linkedChars = editingId
      ? (await DB.getAll(DB.STORES.characters)).filter(c => c.linkedWorldId === editingId)
      : [];

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
            <div class="char-img-toolbar" id="world-img-toolbar">
              ${editorImages.length < MAX_IMAGES ? `<button class="btn btn-secondary btn-sm" onclick="WorldsPage.addImageSlot()">+ Add Image</button>` : ''}
              <button class="btn btn-secondary btn-sm" id="world-caption-all-btn" onclick="WorldsPage.recaptionAll()" style="${editorImages.some(img => img.dataUrl) ? '' : 'display:none'}">&#128221; Caption All</button>
              <button class="btn btn-secondary btn-sm" id="world-gen-refs-btn" onclick="WorldsPage.generateReferences()" style="${editorImages.some(img => img.dataUrl) ? '' : 'display:none'}" title="Generate reference images from your uploaded image">&#127912; Generate References</button>
              ${editorImages.some(img => img.dataUrl) && linkedChars.length >= 2 ? `<button class="btn btn-secondary btn-sm" id="world-gen-interactions-btn" onclick="WorldsPage.generateCharacterInteractions()" title="Generate images of linked characters interacting in this world">&#129489; Generate Interactions</button>` : ''}
            </div>
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

          ${linkedChars.length > 0 ? `
          <div class="form-group">
            <label class="form-label">Linked Characters (${linkedChars.length})</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${linkedChars.map(c => `
                <div class="chip" onclick="App.navigate('characters','${c.id}')" style="cursor:pointer;" title="Edit ${escHtml(c.name)}">
                  ${escHtml(c.name)}${c.role ? ` <span class="text-muted" style="font-size:0.75em;">(${escHtml(c.role)})</span>` : ''}
                </div>
              `).join('')}
            </div>
            <div class="form-hint">Characters linked to this world. Click a character to edit them.</div>
          </div>
          ` : ''}
        </div>

        <button class="btn btn-primary btn-block mt-sm" id="world-save-btn" onclick="WorldsPage.saveWorld()">
          ${editingId ? 'Update' : 'Create'} World
        </button>
      </div>
    `;
  }

  function renderGallerySlots(images, primaryIdx) {
    const worldName = editorName;
    return images.map((img, i) => {
      // Embedding status badge
      let embBadge = '';
      if (img.dataUrl) {
        if (img.embedding && img.embeddingText) {
          const enriched = (typeof buildImageEmbeddingText === 'function') ? buildImageEmbeddingText(img, worldName) : '';
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
        <div class="char-img-slot-preview ${!img.dataUrl ? 'char-img-slot-empty' : ''}" onclick="WorldsPage.pickImageForSlot(${i})">
          ${img.dataUrl ? `<img src="${escHtml(img.dataUrl)}" alt="Ref ${i+1}">` : '<span>&#128247; Upload</span>'}
        </div>
        <div class="char-img-meta">
          <div style="display:flex;align-items:center;gap:6px;">
            <select class="char-img-tag" data-idx="${i}" onchange="WorldsPage.updateTag(${i},this.value)" style="flex:1;">
              ${IMAGE_TAGS.map(t => `<option value="${t}" ${img.tag === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            ${embBadge}
          </div>
          <input type="text" class="char-img-desc" data-idx="${i}" value="${escHtml(img.description || '')}" placeholder="e.g. Neon-lit alley at night" oninput="WorldsPage.updateDesc(${i},this.value)">
          <div class="char-img-actions">
            <button class="char-img-primary ${i === primaryIdx ? 'active' : ''}" title="Set as primary" onclick="WorldsPage.setPrimary(${i})">&#11088;</button>
            ${img.dataUrl ? `<button class="char-img-caption" title="Auto-caption this image" onclick="WorldsPage.recaptionImage(${i})">&#128221;</button>` : ''}
            ${img.dataUrl && img.aiGenerated ? `<button class="char-img-regen" title="Regenerate this reference" onclick="WorldsPage.regenerateImage(${i})">&#128260;</button>` : ''}
            <button class="char-img-delete" title="Remove" onclick="WorldsPage.removeImage(${i})">&#x2715;</button>
          </div>
        </div>
      </div>
    `;}).join('');
  }

  function refreshGallery() {
    const gallery = document.getElementById('world-img-gallery');
    if (!gallery) return;
    // Sync editorName from DOM (available after initial render)
    const nameEl = document.getElementById('world-name');
    if (nameEl) editorName = nameEl.value.trim();
    gallery.innerHTML = renderGallerySlots(editorImages, editorPrimaryIndex);
    // Update toolbar button visibility — async check for linked characters
    const toolbar = document.getElementById('world-img-toolbar');
    if (toolbar) {
      const hasImages = editorImages.some(img => img.dataUrl);
      let btns = '';
      if (editorImages.length < MAX_IMAGES) {
        btns += '<button class="btn btn-secondary btn-sm" onclick="WorldsPage.addImageSlot()">+ Add Image</button>';
      }
      if (hasImages) {
        btns += '<button class="btn btn-secondary btn-sm" id="world-caption-all-btn" onclick="WorldsPage.recaptionAll()">&#128221; Caption All</button>';
        btns += '<button class="btn btn-secondary btn-sm" id="world-gen-refs-btn" onclick="WorldsPage.generateReferences()" title="Generate reference images from your uploaded image">&#127912; Generate References</button>';
      }
      toolbar.innerHTML = btns;
      // Async: add interactions button if 2+ characters are linked
      if (hasImages && editingId) {
        DB.getAll(DB.STORES.characters).then(chars => {
          const linked = chars.filter(c => c.linkedWorldId === editingId);
          if (linked.length >= 2 && toolbar.parentNode) {
            const interBtn = '<button class="btn btn-secondary btn-sm" id="world-gen-interactions-btn" onclick="WorldsPage.generateCharacterInteractions()" title="Generate images of linked characters interacting in this world">&#129489; Generate Interactions</button>';
            if (!toolbar.querySelector('#world-gen-interactions-btn')) {
              toolbar.insertAdjacentHTML('beforeend', interBtn);
            }
          }
        }).catch(err => {
          App.logError('WorldsPage.refreshGallery: failed to load characters', err, { worldId: editingId });
          App.toast('Could not load characters for interaction images. Check the error log for details.', 'error');
        });
      }
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

  async function recaptionImage(idx) {
    const img = editorImages[idx];
    if (!img || !img.dataUrl) return App.toast('No image to caption', 'error');

    const descInput = document.querySelector(`.char-img-desc[data-idx="${idx}"]`);
    const captionBtn = document.querySelector(`.char-img-caption[onclick*="recaptionImage(${idx})"]`);
    if (descInput) { descInput.disabled = true; descInput.placeholder = 'Generating caption\u2026'; }
    if (captionBtn) captionBtn.disabled = true;

    const name = document.getElementById('world-name')?.value.trim() || '';
    const era = document.getElementById('world-era')?.value.trim() || '';
    const caption = await API.generateImageCaption(img.dataUrl, {
      type: 'world',
      name,
      era,
      tag: img.tag,
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
      descInput.placeholder = 'e.g. Neon-lit alley at night';
    }
    if (captionBtn) captionBtn.disabled = false;
  }

  async function recaptionAll() {
    const imagesWithData = editorImages.filter(img => img.dataUrl);
    if (!imagesWithData.length) return App.toast('No images to caption', 'error');

    const captionAllBtn = document.getElementById('world-caption-all-btn');
    if (captionAllBtn) { captionAllBtn.disabled = true; captionAllBtn.textContent = 'Captioning\u2026'; }

    const name = document.getElementById('world-name')?.value.trim() || '';
    const era = document.getElementById('world-era')?.value.trim() || '';

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
        type: 'world', name, era, tag: img.tag,
      }).catch(() => null);

      if (caption && editorImages[i] === img) {
        img.description = caption;
        img.embedding = null;
        img.embeddingText = null;
        if (descInput) descInput.value = caption;
      } else {
        failed++;
      }
      if (descInput) { descInput.disabled = false; descInput.placeholder = 'e.g. Neon-lit alley at night'; }
    }

    if (captionAllBtn) { captionAllBtn.disabled = false; captionAllBtn.textContent = '\u{1F4DD} Caption All'; }
    if (failed > 0) {
      App.toast(`Captioned ${done - failed}/${done} images (${failed} failed)`, 'info');
    } else {
      App.toast(`Captioned ${done} image(s)`, 'success');
    }
    refreshGallery();
  }

  /**
   * Generate reference image variations from the primary uploaded image.
   * Shows a selection modal letting the user choose which variations to generate.
   */
  function generateReferences() {
    const primaryCandidate = editorImages[editorPrimaryIndex];
    const primaryImg = (primaryCandidate && primaryCandidate.dataUrl)
      ? primaryCandidate
      : editorImages.find(img => img.dataUrl);
    if (!primaryImg) return App.toast('Upload at least one image first', 'error');

    const variations = API.WORLD_REF_VARIATIONS;
    const existingTags = new Set(editorImages.filter(img => img.dataUrl).map(img => img.tag));
    const available = variations.filter(v => !existingTags.has(v.tag));

    const slotsAvailable = MAX_IMAGES - editorImages.filter(img => img.dataUrl).length;
    if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

    const batch = available.slice(0, slotsAvailable);
    if (batch.length === 0) return App.toast('All reference variations already exist or gallery is full', 'info');

    const checkboxes = batch.map((v, i) => {
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
        <input type="checkbox" class="world-ref-pick" data-idx="${i}" checked>
        <span><strong>${escHtml(v.tag)}</strong> — ${escHtml(v.desc)}</span>
      </label>`;
    }).join('');

    App.showModal(`
      <div class="modal-title">Select Reference Images to Generate</div>
      <p class="text-sm text-muted" style="margin-bottom:12px;">Choose which reference image types to generate (${slotsAvailable} slot${slotsAvailable !== 1 ? 's' : ''} available):</p>
      <div style="max-height:45vh;overflow-y:auto;">${checkboxes}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-primary" onclick="WorldsPage._doGenerateReferences()">Generate Selected</button>
      </div>
    `);
    WorldsPage._pendingRefVariations = batch;
  }

  /** Execute reference generation for the user-selected variations. */
  async function _doGenerateReferences() {
    const picks = document.querySelectorAll('.world-ref-pick:checked');
    const selectedIdxs = Array.from(picks).map(cb => parseInt(cb.dataset.idx, 10));
    if (selectedIdxs.length === 0) return App.toast('Select at least one variation', 'error');

    const selectedVariations = selectedIdxs.map(i => WorldsPage._pendingRefVariations[i]).filter(Boolean);
    App.hideModal();

    const primaryCandidate = editorImages[editorPrimaryIndex];
    const primaryImg = (primaryCandidate && primaryCandidate.dataUrl)
      ? primaryCandidate
      : editorImages.find(img => img.dataUrl);
    if (!primaryImg) return App.toast('Upload at least one image first', 'error');

    const name = document.getElementById('world-name')?.value.trim() || 'the location';
    const description = document.getElementById('world-desc')?.value.trim() || '';

    const genBtn = document.getElementById('world-gen-refs-btn');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating\u2026'; }

    let done = 0;
    let failed = 0;
    for (const variation of selectedVariations) {
      done++;
      if (genBtn) genBtn.textContent = `Generating ${done}/${selectedVariations.length}\u2026`;

      const prompt = variation.prompt
        .replace(/\{name\}/g, name)
        .replace(/\{description\}/g, description || 'as shown in the reference image');

      const dataUrl = await API.generateRefVariation(primaryImg.dataUrl, prompt).catch(() => null);

      if (dataUrl) {
        const newImg = {
          dataUrl,
          tag: variation.tag,
          description: '',
          embedding: null,
          embeddingText: null,
          aiGenerated: true,
          generationPrompt: prompt,
        };
        editorImages.push(newImg);
        refreshGallery();

        // Auto-caption the generated image
        const era = document.getElementById('world-era')?.value.trim() || '';
        const caption = await API.generateImageCaption(dataUrl, {
          type: 'world', name, era, tag: variation.tag,
        }).catch(() => null);
        if (caption) {
          newImg.description = caption;
          newImg.embedding = null;
          newImg.embeddingText = null;
          refreshGallery();
        }
      } else {
        failed++;
      }
    }

    if (genBtn) { genBtn.disabled = false; genBtn.textContent = '\u{1F3A8} Generate References'; }
    if (failed > 0) {
      App.toast(`Generated ${done - failed}/${done} references (${failed} failed)`, 'info');
    } else {
      App.toast(`Generated ${done} reference image(s)`, 'success');
    }
  }

  /**
   * Regenerate a single AI-generated reference image.
   * Uses the primary uploaded image as the source and the stored generation prompt.
   */
  async function regenerateImage(idx) {
    const img = editorImages[idx];
    if (!img || !img.aiGenerated) return App.toast('This image was not AI-generated', 'error');

    const primaryImg = editorImages.find(src => src.dataUrl && !src.aiGenerated);
    if (!primaryImg) return App.toast('No source image found for regeneration', 'error');

    const name = document.getElementById('world-name')?.value.trim() || 'the location';
    const description = document.getElementById('world-desc')?.value.trim() || '';

    // Re-derive the prompt from the tag variation or use stored prompt
    let prompt = img.generationPrompt;
    if (!prompt) {
      const variation = API.WORLD_REF_VARIATIONS.find(v => v.tag === img.tag);
      if (variation) {
        prompt = variation.prompt
          .replace(/\{name\}/g, name)
          .replace(/\{description\}/g, description || 'as shown in the reference image');
      } else {
        prompt = `${img.tag} view of ${name}, ${description || 'as shown in the reference'}`;
      }
    }

    const preview = document.querySelector(`.char-img-slot[data-idx="${idx}"] .char-img-slot-preview`);
    if (preview) preview.style.opacity = '0.5';
    const regenBtn = document.querySelector(`.char-img-slot[data-idx="${idx}"] .char-img-regen`);
    if (regenBtn) regenBtn.disabled = true;

    const dataUrl = await API.generateRefVariation(primaryImg.dataUrl, prompt).catch(() => null);

    if (dataUrl) {
      img.dataUrl = dataUrl;
      img.embedding = null;
      img.embeddingText = null;
      img.generationPrompt = prompt;

      // Re-caption
      const era = document.getElementById('world-era')?.value.trim() || '';
      const caption = await API.generateImageCaption(dataUrl, {
        type: 'world', name, era, tag: img.tag,
      }).catch(() => null);
      if (caption) {
        img.description = caption;
        img.embedding = null;
        img.embeddingText = null;
      }
      refreshGallery();
      App.toast('Reference image regenerated', 'success');
    } else {
      if (preview) preview.style.opacity = '1';
      if (regenBtn) regenBtn.disabled = false;
      App.toast('Regeneration failed', 'error');
    }
  }

  /**
   * Generate images of linked characters interacting with each other inside this world.
   * Shows a selection modal letting the user choose which interactions to generate.
   * Requires at least 2 characters linked to this world and at least one world image.
   */
  async function generateCharacterInteractions() {
    if (!editingId) return App.toast('Save the world first before generating interactions', 'error');

    const primaryCandidate = editorImages[editorPrimaryIndex];
    const worldImg = (primaryCandidate && primaryCandidate.dataUrl)
      ? primaryCandidate
      : editorImages.find(img => img.dataUrl);
    if (!worldImg) return App.toast('Upload at least one world image first', 'error');

    const allChars = await DB.getAll(DB.STORES.characters);
    const linkedChars = allChars.filter(c => c.linkedWorldId === editingId);
    if (linkedChars.length < 2) return App.toast('Link at least 2 characters to this world first', 'error');

    const worldName = document.getElementById('world-name')?.value.trim() || 'the world';
    const worldDesc = document.getElementById('world-desc')?.value.trim() || '';

    const slotsAvailable = MAX_IMAGES - editorImages.filter(img => img.dataUrl).length;
    if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

    // Pick up to 4 characters for the interaction shot
    const castChars = linkedChars.slice(0, 4);
    const castNames = castChars.map(c => c.name).join(', ');
    const castDesc = castChars.map(c => {
      const appearances = c.appearance ? ` (${c.appearance.trim()})` : '';
      return `${c.name}${appearances}`;
    }).join('; ');

    const interactionPrompts = [
      {
        tag: 'character-interaction',
        prompt: `${castNames} are together in ${worldName} (${worldDesc || 'as shown'}). Full-body ensemble shot showing all characters interacting with each other in the environment. Characters: ${castDesc}. Dynamic group composition with ${worldName}'s atmosphere and architecture visible in the background. Match the art style of the provided reference images.`,
        desc: `${castNames} — ensemble interaction in ${worldName}`,
      },
      {
        tag: 'character-interaction',
        prompt: `${castNames} in a dramatic confrontation or collaboration scene inside ${worldName} (${worldDesc || 'as shown'}). Each character distinctly visible: ${castDesc}. Cinematic wide shot capturing the tension and relationship between characters with the world's setting providing context. Match the art style of the provided reference images.`,
        desc: `${castNames} — dramatic scene in ${worldName}`,
      },
    ];

    const available = interactionPrompts.slice(0, slotsAvailable);

    // Build linked characters display
    const charList = castChars.map(c => `<strong>${escHtml(c.name)}</strong>${c.appearance ? ` <span class="text-muted">(${escHtml(c.appearance.slice(0, 60))})</span>` : ''}`).join(', ');

    const checkboxes = available.map((v, i) => {
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
        <input type="checkbox" class="world-inter-pick" data-idx="${i}" checked>
        <span>${escHtml(v.desc)}</span>
      </label>`;
    }).join('');

    App.showModal(`
      <div class="modal-title">Generate Character Interactions</div>
      <p class="text-sm text-muted" style="margin-bottom:8px;">Characters: ${charList}</p>
      <p class="text-sm text-muted" style="margin-bottom:12px;">Choose which interaction images to generate (${slotsAvailable} slot${slotsAvailable !== 1 ? 's' : ''} available):</p>
      <div style="max-height:45vh;overflow-y:auto;">${checkboxes}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-primary" onclick="WorldsPage._doGenerateCharacterInteractions()">Generate Selected</button>
      </div>
    `);
    WorldsPage._pendingInteractionData = { prompts: available, castChars, castNames, castDesc, worldName, worldDesc, worldImg };
  }

  /** Execute character interaction generation for the user-selected variations. */
  async function _doGenerateCharacterInteractions() {
    const picks = document.querySelectorAll('.world-inter-pick:checked');
    const selectedIdxs = Array.from(picks).map(cb => parseInt(cb.dataset.idx, 10));
    if (selectedIdxs.length === 0) return App.toast('Select at least one variation', 'error');

    const data = WorldsPage._pendingInteractionData;
    const selectedVariations = selectedIdxs.map(i => data.prompts[i]).filter(Boolean);
    App.hideModal();

    const { castChars, castNames, worldName, worldImg } = data;

    // Collect primary images for each character to use as references
    const charRefUrls = castChars
      .map(c => {
        const m = DB.migrateCharacter(c);
        const img = m.images?.[m.primaryImageIndex ?? 0] || m.images?.[0];
        return img?.dataUrl || null;
      })
      .filter(Boolean);

    const refUrls = [worldImg.dataUrl, ...charRefUrls];

    const genBtn = document.getElementById('world-gen-interactions-btn');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating\u2026'; }

    let done = 0;
    let failed = 0;
    for (const variation of selectedVariations) {
      done++;
      if (genBtn) genBtn.textContent = `Generating ${done}/${selectedVariations.length}\u2026`;
      const dataUrl = await API.generateRefVariation(null, variation.prompt, { imageDataUrls: refUrls }).catch(() => null);

      if (dataUrl) {
        const newImg = {
          dataUrl,
          tag: variation.tag,
          description: variation.desc,
          embedding: null,
          embeddingText: null,
          aiGenerated: true,
          generationPrompt: variation.prompt,
        };
        editorImages.push(newImg);
        refreshGallery();

        const caption = await API.generateImageCaption(dataUrl, {
          type: 'character-interaction', name: worldName, tag: variation.tag,
          characterNames: castNames, worldName,
        }).catch(() => null);
        if (caption) {
          newImg.description = caption;
          newImg.embedding = null;
          newImg.embeddingText = null;
          refreshGallery();
        }
      } else {
        failed++;
      }
    }

    if (genBtn) { genBtn.disabled = false; genBtn.textContent = '\u{1F9D1} Generate Interactions'; }
    if (failed > 0) {
      App.toast(`Generated ${done - failed}/${done} interaction images (${failed} failed)`, 'info');
    } else {
      App.toast(`Generated ${done} character interaction image(s)`, 'success');
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
    // Toggle: clicking the already-active star deselects it
    editorPrimaryIndex = (idx === editorPrimaryIndex) ? -1 : idx;
    document.querySelectorAll('#world-img-gallery .char-img-primary').forEach((btn, i) => {
      btn.classList.toggle('active', i === editorPrimaryIndex);
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
    let primaryIdx = -1;
    editorImages.forEach((img, idx) => {
      if (!img || !img.dataUrl) return;
      if (idx === editorPrimaryIndex) primaryIdx = validImages.length;
      validImages.push(img);
    });
    if (primaryIdx >= validImages.length) primaryIdx = validImages.length > 0 ? 0 : -1;

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
    updateTag, updateDesc, setPrimary, removeImage, recaptionImage, recaptionAll,
    generateReferences, _doGenerateReferences, regenerateImage,
    generateCharacterInteractions, _doGenerateCharacterInteractions,
    _pendingRefVariations: null, _pendingInteractionData: null,
    saveWorld, exportWorld, deleteWorld, confirmDelete,
  };
})();
