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

  const IMAGE_TAGS = ['default', 'front-view', 'side-view', 'back-view', 'close-up', 'action-pose', 'alternate-outfit', 'expression', 'character-sheet', 'character-in-world', 'custom'];
  const MAX_IMAGES = 20;

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
    let char = { name: '', role: 'hero', description: '', appearance: '', backstory: '', powers: '', images: [], primaryImageIndex: 0, linkedWorldId: '' };
    if (editingId) {
      const saved = await DB.get(DB.STORES.characters, editingId);
      if (saved) char = DB.migrateCharacter(saved);
    }
    editorImages = (char.images || []).map(img => Object.assign({}, img));
    editorPrimaryIndex = char.primaryImageIndex ?? 0;
    editorName = char.name || '';

    const worlds = await DB.getAll(DB.STORES.worlds);

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
              <button class="btn btn-secondary btn-sm" id="char-gen-refs-btn" onclick="CharactersPage.generateReferences()" style="${editorImages.some(img => img.dataUrl) ? '' : 'display:none'}" title="Generate reference images from your uploaded image">&#127912; Generate References</button>
              ${editorImages.some(img => img.dataUrl) && char.linkedWorldId ? `<button class="btn btn-secondary btn-sm" id="char-gen-world-btn" onclick="CharactersPage.generateWorldInteractions()" title="Generate images of this character interacting with their linked world">&#127758; Generate in World</button>` : ''}
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
            <label class="form-label">Linked World</label>
            <select id="char-linked-world" onchange="CharactersPage.refreshGallery()">
              <option value="">— None —</option>
              ${worlds.map(w => `<option value="${w.id}" ${char.linkedWorldId === w.id ? 'selected' : ''}>${escHtml(w.name)}</option>`).join('')}
            </select>
            <div class="form-hint">Link this character to a world to enable character-in-world reference images and interaction shots</div>
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
            ${img.dataUrl && img.aiGenerated ? `<button class="char-img-regen" title="Regenerate this reference" onclick="CharactersPage.regenerateImage(${i})">&#128260;</button>` : ''}
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
      const linkedWorldId = document.getElementById('char-linked-world')?.value || '';
      // Rebuild toolbar contents to reflect current state
      let btns = '';
      if (editorImages.length < MAX_IMAGES) {
        btns += '<button class="btn btn-secondary btn-sm" onclick="CharactersPage.addImageSlot()">+ Add Image</button>';
      }
      if (hasImages) {
        btns += '<button class="btn btn-secondary btn-sm" id="char-caption-all-btn" onclick="CharactersPage.recaptionAll()">&#128221; Caption All</button>';
        btns += '<button class="btn btn-secondary btn-sm" id="char-gen-refs-btn" onclick="CharactersPage.generateReferences()" title="Generate reference images from your uploaded image">&#127912; Generate References</button>';
        if (linkedWorldId) {
          btns += '<button class="btn btn-secondary btn-sm" id="char-gen-world-btn" onclick="CharactersPage.generateWorldInteractions()" title="Generate images of this character interacting with their linked world">&#127758; Generate in World</button>';
        }
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

  /**
   * Generate reference image variations from the primary uploaded image.
   * Shows a selection modal letting the user choose which variations to generate.
   */
  function generateReferences() {
    // Use the user-selected primary image as the source for all variations
    const primaryCandidate = editorImages[editorPrimaryIndex];
    const primaryImg = (primaryCandidate && primaryCandidate.dataUrl)
      ? primaryCandidate
      : editorImages.find(img => img.dataUrl);
    if (!primaryImg) return App.toast('Upload at least one image first', 'error');

    const slotsAvailable = MAX_IMAGES - editorImages.filter(img => img.dataUrl).length;
    if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

    const variations = API.CHARACTER_REF_VARIATIONS;
    // Count existing images per tag
    const existingTagCounts = {};
    for (const img of editorImages.filter(i => i.dataUrl)) {
      existingTagCounts[img.tag] = (existingTagCounts[img.tag] || 0) + 1;
    }
    const variationTagCounts = {};
    for (const v of variations) {
      variationTagCounts[v.tag] = (variationTagCounts[v.tag] || 0) + 1;
    }
    const queuedTagCounts = Object.assign({}, existingTagCounts);
    const available = variations.filter(v => {
      const defined = variationTagCounts[v.tag] || 1;
      const queued = queuedTagCounts[v.tag] || 0;
      if (queued < defined) {
        queuedTagCounts[v.tag] = queued + 1;
        return true;
      }
      return false;
    });

    if (available.length === 0) return App.toast('All reference variations already exist or gallery is full', 'info');

    // Build selection modal — show ALL available variations, pre-check up to slotsAvailable
    const checkboxes = available.map((v, i) => {
      const checked = i < slotsAvailable ? 'checked' : '';
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
        <input type="checkbox" class="char-ref-pick" data-idx="${i}" ${checked}>
        <span><strong>${escHtml(v.tag)}</strong> — ${escHtml(v.desc)}</span>
      </label>`;
    }).join('');

    App.showModal(`
      <div class="modal-title">Select Reference Images to Generate</div>
      <p class="text-sm text-muted" style="margin-bottom:12px;">Choose which reference image types to generate (${slotsAvailable} slot${slotsAvailable !== 1 ? 's' : ''} available):</p>
      <div style="max-height:45vh;overflow-y:auto;">${checkboxes}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-primary" id="char-ref-confirm-btn" onclick="CharactersPage._doGenerateReferences()">Generate Selected</button>
      </div>
    `);
    // Store available variations and slot limit for the confirm handler
    CharactersPage._pendingRefVariations = available;
    CharactersPage._pendingRefSlots = slotsAvailable;
  }

  /** Execute reference generation for the user-selected variations. */
  async function _doGenerateReferences() {
    const picks = document.querySelectorAll('.char-ref-pick:checked');
    const selectedIdxs = Array.from(picks).map(cb => parseInt(cb.dataset.idx, 10));
    if (selectedIdxs.length === 0) return App.toast('Select at least one variation', 'error');

    const maxSlots = CharactersPage._pendingRefSlots ?? selectedIdxs.length;
    if (selectedIdxs.length > maxSlots) return App.toast(`Only ${maxSlots} slot${maxSlots !== 1 ? 's' : ''} available — deselect some options`, 'error');

    const selectedVariations = selectedIdxs.map(i => CharactersPage._pendingRefVariations[i]).filter(Boolean);
    App.hideModal();

    const primaryCandidate = editorImages[editorPrimaryIndex];
    const primaryImg = (primaryCandidate && primaryCandidate.dataUrl)
      ? primaryCandidate
      : editorImages.find(img => img.dataUrl);
    if (!primaryImg) return App.toast('Upload at least one image first', 'error');

    const name = document.getElementById('char-name')?.value.trim() || 'the character';
    const appearance = document.getElementById('char-appearance')?.value.trim() || '';

    const genBtn = document.getElementById('char-gen-refs-btn');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating\u2026'; }

    let done = 0;
    let failed = 0;
    for (const variation of selectedVariations) {
      done++;
      if (genBtn) genBtn.textContent = `Generating ${done}/${selectedVariations.length}\u2026`;

      const prompt = variation.prompt;

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
        const caption = await API.generateImageCaption(dataUrl, {
          type: 'character', name, role: document.getElementById('char-role')?.value || '', tag: variation.tag, appearance,
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

    const name = document.getElementById('char-name')?.value.trim() || 'the character';
    const appearance = document.getElementById('char-appearance')?.value.trim() || '';

    // Re-derive the prompt from the tag variation or use stored prompt
    let prompt = img.generationPrompt;
    if (!prompt) {
      const variation = API.CHARACTER_REF_VARIATIONS.find(v => v.tag === img.tag);
      if (variation) {
        prompt = variation.prompt;
      } else {
        prompt = `Generate a ${img.tag.replace(/-/g, ' ')} of the character in the reference image, clean background`;
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
      const caption = await API.generateImageCaption(dataUrl, {
        type: 'character', name, role: document.getElementById('char-role')?.value || '', tag: img.tag, appearance,
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
   * Generate images showing this character interacting within their linked world.
   * Shows a selection modal letting the user choose which variations to generate.
   */
  async function generateWorldInteractions() {
    const primaryCandidate = editorImages[editorPrimaryIndex];
    const primaryImg = (primaryCandidate && primaryCandidate.dataUrl)
      ? primaryCandidate
      : editorImages.find(img => img.dataUrl);
    if (!primaryImg) return App.toast('Upload at least one character image first', 'error');

    const linkedWorldId = document.getElementById('char-linked-world')?.value || '';
    if (!linkedWorldId) return App.toast('Link this character to a world first', 'error');

    const world = await DB.get(DB.STORES.worlds, linkedWorldId);
    if (!world) return App.toast('Linked world not found', 'error');

    const name = document.getElementById('char-name')?.value.trim() || 'the character';

    const slotsAvailable = MAX_IMAGES - editorImages.filter(img => img.dataUrl).length;
    if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

    const variations = API.CHARACTER_WORLD_VARIATIONS;
    const available = variations;

    // Build selection modal with world info
    const checkboxes = available.map((v, i) => {
      const label = v.desc
        .replace(/\{charName\}/g, name)
        .replace(/\{worldName\}/g, world.name);
      const checked = i < slotsAvailable ? 'checked' : '';
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
        <input type="checkbox" class="char-world-pick" data-idx="${i}" ${checked}>
        <span><strong>${escHtml(v.tag)}</strong> — ${escHtml(label)}</span>
      </label>`;
    }).join('');

    App.showModal(`
      <div class="modal-title">Generate Character in World</div>
      <p class="text-sm text-muted" style="margin-bottom:12px;">Generate images of <strong>${escHtml(name)}</strong> in <strong>${escHtml(world.name)}</strong> (${slotsAvailable} slot${slotsAvailable !== 1 ? 's' : ''} available):</p>
      <div style="max-height:45vh;overflow-y:auto;">${checkboxes}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-primary" onclick="CharactersPage._doGenerateWorldInteractions()">Generate Selected</button>
      </div>
    `);
    CharactersPage._pendingWorldVariations = available;
    CharactersPage._pendingWorldData = { world, name, slotsAvailable };
  }

  /** Execute character-in-world generation for the user-selected variations. */
  async function _doGenerateWorldInteractions() {
    const picks = document.querySelectorAll('.char-world-pick:checked');
    const selectedIdxs = Array.from(picks).map(cb => parseInt(cb.dataset.idx, 10));
    if (selectedIdxs.length === 0) return App.toast('Select at least one variation', 'error');

    const maxSlots = CharactersPage._pendingWorldData?.slotsAvailable ?? selectedIdxs.length;
    if (selectedIdxs.length > maxSlots) return App.toast(`Only ${maxSlots} slot${maxSlots !== 1 ? 's' : ''} available — deselect some options`, 'error');

    const selectedVariations = selectedIdxs.map(i => CharactersPage._pendingWorldVariations[i]).filter(Boolean);
    const { world, name } = CharactersPage._pendingWorldData;
    App.hideModal();

    const primaryCandidate = editorImages[editorPrimaryIndex];
    const primaryImg = (primaryCandidate && primaryCandidate.dataUrl)
      ? primaryCandidate
      : editorImages.find(img => img.dataUrl);
    if (!primaryImg) return App.toast('Upload at least one character image first', 'error');

    const appearance = document.getElementById('char-appearance')?.value.trim() || '';
    const charAppearanceNote = appearance ? ` (${appearance})` : '';

    const genBtn = document.getElementById('char-gen-world-btn');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating\u2026'; }

    let done = 0;
    let failed = 0;
    for (const variation of selectedVariations) {
      done++;
      if (genBtn) genBtn.textContent = `Generating ${done}/${selectedVariations.length}\u2026`;

      const prompt = variation.prompt
        .replace(/\{charName\}/g, name)
        .replace(/\{charAppearanceNote\}/g, charAppearanceNote)
        .replace(/\{worldName\}/g, world.name)
        .replace(/\{worldDescription\}/g, world.description || 'as shown in the world reference');

      const desc = variation.desc
        .replace(/\{charName\}/g, name)
        .replace(/\{worldName\}/g, world.name);

      const migratedWorld = DB.migrateWorld(world);
      const worldPrimaryImg = migratedWorld.images?.[migratedWorld.primaryImageIndex ?? 0] || migratedWorld.images?.[0];

      const refUrls = worldPrimaryImg?.dataUrl
        ? [primaryImg.dataUrl, worldPrimaryImg.dataUrl]
        : [primaryImg.dataUrl];

      const dataUrl = await API.generateRefVariation(null, prompt, { imageDataUrls: refUrls }).catch(() => null);

      if (dataUrl) {
        const newImg = {
          dataUrl,
          tag: variation.tag,
          description: desc,
          embedding: null,
          embeddingText: null,
          aiGenerated: true,
          generationPrompt: prompt,
        };
        editorImages.push(newImg);
        refreshGallery();

        const caption = await API.generateImageCaption(dataUrl, {
          type: 'character-in-world', name, tag: variation.tag, appearance,
          worldName: world.name,
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

    if (genBtn) { genBtn.disabled = false; genBtn.textContent = '\u{1F30E} Generate in World'; }
    if (failed > 0) {
      App.toast(`Generated ${done - failed}/${done} world interaction images (${failed} failed)`, 'info');
    } else {
      App.toast(`Generated ${done} world interaction image(s)`, 'success');
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
    // Update star button states in place
    document.querySelectorAll('.char-img-primary').forEach((btn, i) => {
      btn.classList.toggle('active', i === editorPrimaryIndex);
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
    if (primaryIdx >= validImages.length) primaryIdx = validImages.length > 0 ? 0 : -1;

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
      linkedWorldId: document.getElementById('char-linked-world')?.value || '',
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
    refreshGallery,
    newCharacter, editCharacter, backToList,
    pickImage, pickImageForSlot, handleImage, addImageSlot,
    updateTag, updateDesc, setPrimary, removeImage, recaptionImage, recaptionAll,
    generateReferences, _doGenerateReferences, regenerateImage,
    generateWorldInteractions, _doGenerateWorldInteractions,
    _pendingRefVariations: null, _pendingRefSlots: 0,
    _pendingWorldVariations: null, _pendingWorldData: null,
    saveCharacter, exportCharacter, deleteCharacter, confirmDelete,
  };
})();
