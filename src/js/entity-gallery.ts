// @ts-nocheck
import { escHtml, newId } from './utils.js';
import DB from './db.js';
import API from './api.js';

/**
 * Shared reference-image gallery subsystem for the Character and World builder
 * pages. Both pages manage the same in-editor image list (upload, caption,
 * AI-generated reference variations, primary/anchor selection) with only small
 * per-entity differences; those differences are injected via `GalleryConfig`.
 *
 * `createGalleryEditor(config)` returns the gallery functions plus a mutable
 * `state` object the owning page initializes in its renderEditor() and reads
 * back in its save handler. All DOM ids follow the `${idPrefix}-*` naming both
 * pages already use (`char-img-gallery`, `world-img-toolbar`, ...). Generated
 * markup uses data-action attributes resolved against the current page module
 * by app.ts's delegated dispatcher, so the page's public method names must
 * stay stable.
 */

export const MAX_IMAGES: number = 20;

/**
 * config fields:
 * - idPrefix: DOM id prefix ('char' | 'world')
 * - imageTags: tag options for the per-image <select>
 * - defaultTag: tag assigned to newly created image slots
 * - newImageExtra: () => extra fields merged into newly created image objects
 * - descPlaceholder: placeholder for the per-image description input
 * - anchorBadgeTitle / anchorButtonTitle: anchor UI tooltip texts
 * - slotExtraInputs: (img, i) => extra HTML inside the slot meta block
 * - captionMeta: () => caption metadata read from the editor DOM (no tag)
 * - fallbackName: name used in generation prompts when the name field is empty
 * - refVariations: () => predefined reference-variation list from the API module
 * - resolveRefPrompt: (variation) => prompt text (placeholder resolution etc.)
 * - fallbackRegenPrompt: (img) => prompt when a regenerated image has none stored
 * - toolbarExtraHtml: (hasImages) => extra toolbar buttons appended on refresh
 * - afterToolbarRefresh: (toolbar, hasImages) => post-refresh hook (async adds)
 * - slotHintIds: element ids of open dropdown slot-count hints to keep in sync
 * - anchorSetToast: (name) => toast shown when an anchor is set
 * - anchorFallbackLabel: (img) => label describing the fallback anchor image
 * - anchorRemovedToast: (label) => toast when the anchor image is removed
 * - anchorRemovedEmptyToast: toast when the anchor is removed and no images remain
 */
export function createGalleryEditor(config) {
  // In-editor image list: [{ id, dataUrl, tag, description, ... }]
  const state = {
    images: [],
    primaryIndex: 0,
    // Stable image ID of the anchor image (authoritative for generation)
    anchorImageId: null,
    name: '',
    // Index of the image slot currently being filled (for file picker)
    pendingSlotIdx: -1,
  };

  function newImage(fields) {
    return Object.assign(
      { id: newId(), dataUrl: '', tag: config.defaultTag, description: '' },
      config.newImageExtra ? config.newImageExtra() : null,
      fields,
    );
  }

  function renderGallerySlots(): string {
    const entityName = state.name;
    return state.images
      .map((img, i) => {
        const isAnchor = !!img.id && img.id === state.anchorImageId;
        return `
    <div class="char-img-slot" data-idx="${i}">
      <div class="char-img-slot-preview ${!img.dataUrl ? 'char-img-slot-empty' : ''}" data-action="pickImageForSlot" data-args="[${i}]">
        ${img.dataUrl ? `<img src="${escHtml(img.dataUrl)}" alt="Ref ${i + 1}">` : '<span>&#128247; Upload</span>'}
        ${isAnchor ? `<span class="char-img-anchor-badge" title="${config.anchorBadgeTitle}">&#9875; Anchor</span>` : ''}
      </div>
      <div class="char-img-meta">
        <div style="display:flex;align-items:center;gap:6px;">
          <select class="char-img-tag" data-idx="${i}" data-action-change="updateTag" data-args="[${i}]" style="flex:1;">
            ${config.imageTags.map((t) => `<option value="${t}" ${img.tag === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <input type="text" class="char-img-desc" data-idx="${i}" value="${escHtml(img.description || '')}" placeholder="${config.descPlaceholder}" data-action-input="updateDesc" data-args="[${i}]">
        ${config.slotExtraInputs ? config.slotExtraInputs(img, i) : ''}
        <div class="char-img-actions">
          <button class="char-img-primary ${i === state.primaryIndex ? 'active' : ''}" title="Set as thumbnail" data-action="setPrimary" data-args="[${i}]">&#11088;</button>
          ${img.dataUrl ? `<button class="char-img-anchor ${isAnchor ? 'active' : ''}" title="${config.anchorButtonTitle}" data-action="setAnchor" data-args="[${i}]">&#9875;</button>` : ''}
          ${img.dataUrl ? `<button class="char-img-caption" title="Auto-caption this image" data-action="recaptionImage" data-args="[${i}]">&#128221;</button>` : ''}
          ${img.dataUrl && img.aiGenerated ? `<button class="char-img-regen" title="Regenerate this reference" data-action="regenerateImage" data-args="[${i}]">&#128260;</button>` : ''}
          <button class="char-img-delete" title="Remove" data-action="removeImage" data-args="[${i}]">&#x2715;</button>
        </div>
      </div>
    </div>
  `;
      })
      .join('');
  }

  function refreshGallery() {
    const gallery = document.getElementById(`${config.idPrefix}-img-gallery`);
    if (!gallery) return;
    // Sync entity name from DOM (available after initial render)
    const nameEl = document.getElementById(`${config.idPrefix}-name`);
    if (nameEl) state.name = nameEl.value.trim();
    gallery.innerHTML = renderGallerySlots();
    // Rebuild toolbar contents to reflect current state
    const toolbar = document.getElementById(`${config.idPrefix}-img-toolbar`);
    if (toolbar) {
      const hasImages = state.images.some((img) => img.dataUrl);
      let btns = '';
      if (state.images.length < MAX_IMAGES) {
        btns += '<button class="btn btn-secondary btn-sm" data-action="addImageSlot">+ Add Image</button>';
      }
      if (hasImages) {
        btns += `<button class="btn btn-secondary btn-sm" id="${config.idPrefix}-caption-all-btn" data-action="recaptionAll">&#128221; Caption All</button>`;
        btns += `<button class="btn btn-secondary btn-sm" id="${config.idPrefix}-gen-refs-btn" data-action="generateReferences" title="Generate reference images from your uploaded image">&#127912; Generate References</button>`;
      }
      if (config.toolbarExtraHtml) btns += config.toolbarExtraHtml(hasImages);
      toolbar.innerHTML = btns;
      if (config.afterToolbarRefresh) config.afterToolbarRefresh(toolbar, hasImages);
    }
    // Keep slot-count hints in any open dropdown panels in sync
    const remaining = MAX_IMAGES - state.images.filter((img) => img.dataUrl).length;
    const slotText = `${remaining} image slot${remaining !== 1 ? 's' : ''} available`;
    for (const hintId of config.slotHintIds || []) {
      const el = document.getElementById(hintId);
      if (el) el.textContent = slotText;
    }
  }

  function addImageSlot() {
    if (state.images.length >= MAX_IMAGES) return App.toast(`Maximum ${MAX_IMAGES} images`, 'error');
    state.images.push(newImage());
    refreshGallery();
    // Immediately open file picker for the new slot
    pickImageForSlot(state.images.length - 1);
  }

  function pickImageForSlot(idx: number): void {
    state.pendingSlotIdx = idx;
    document.getElementById(`${config.idPrefix}-img-input`).click();
  }

  /** Change handler for the hidden file input; `input` is the matched element. */
  async function handleImage(input: any): Promise<void> {
    const file = input.files[0];
    if (!file) {
      // File picker was cancelled — remove the empty slot created by addImageSlot()
      if (
        state.pendingSlotIdx >= 0 &&
        state.pendingSlotIdx < state.images.length &&
        !state.images[state.pendingSlotIdx].dataUrl
      ) {
        state.images.splice(state.pendingSlotIdx, 1);
        if (state.primaryIndex >= state.images.length) state.primaryIndex = Math.max(0, state.images.length - 1);
        refreshGallery();
      }
      state.pendingSlotIdx = -1;
      return;
    }
    const dataUrl = await DB.fileToDataURL(file);
    const idx = state.pendingSlotIdx >= 0 ? state.pendingSlotIdx : 0;
    if (idx >= state.images.length) {
      state.images.push(newImage({ dataUrl }));
    } else {
      state.images[idx] = Object.assign({ id: newId() }, state.images[idx], {
        dataUrl,
      });
    }
    refreshGallery();
    // Reset file input so same file can be re-picked
    input.value = '';

    // Auto-caption: if the slot has no description, generate one via vision model
    const img = state.images[idx];
    if (img && !img.description?.trim()) {
      const descInput = document.querySelector(`.char-img-desc[data-idx="${idx}"]`);
      if (descInput) {
        descInput.disabled = true;
        descInput.placeholder = 'Generating caption…';
      }
      const caption = await API.generateImageCaption(dataUrl, {
        ...config.captionMeta(),
        tag: img.tag,
      }).catch(() => null);
      // Only apply if this slot wasn't replaced while we were waiting
      if (state.images[idx] === img && !img.description?.trim() && caption) {
        img.description = caption;
      }
      if (descInput) {
        descInput.disabled = false;
        descInput.placeholder = config.descPlaceholder;
        if (img.description) descInput.value = img.description;
      }
    }
  }

  async function recaptionImage(idx: number): Promise<void> {
    const img = state.images[idx];
    if (!img || !img.dataUrl) return App.toast('No image to caption', 'error');

    const descInput = document.querySelector(`.char-img-desc[data-idx="${idx}"]`);
    const captionBtn = document.querySelector(`.char-img-slot[data-idx="${idx}"] .char-img-caption`);
    if (descInput) {
      descInput.disabled = true;
      descInput.placeholder = 'Generating caption…';
    }
    if (captionBtn) captionBtn.disabled = true;

    const caption = await API.generateImageCaption(img.dataUrl, {
      ...config.captionMeta(),
      tag: img.tag,
    }).catch(() => null);

    if (caption) {
      img.description = caption;
      if (descInput) descInput.value = caption;
    } else {
      App.toast('Caption generation failed or is unsupported by this model', 'error');
    }

    if (descInput) {
      descInput.disabled = false;
      descInput.placeholder = config.descPlaceholder;
    }
    if (captionBtn) captionBtn.disabled = false;
  }

  async function recaptionAll() {
    const imagesWithData = state.images.filter((img) => img.dataUrl);
    if (!imagesWithData.length) return App.toast('No images to caption', 'error');

    const captionAllBtn = document.getElementById(`${config.idPrefix}-caption-all-btn`);
    if (captionAllBtn) {
      captionAllBtn.disabled = true;
      captionAllBtn.textContent = 'Captioning…';
    }

    const meta = config.captionMeta();

    let done = 0;
    let failed = 0;
    for (let i = 0; i < state.images.length; i++) {
      const img = state.images[i];
      if (!img.dataUrl) continue;
      done++;
      if (captionAllBtn) captionAllBtn.textContent = `Captioning ${done}/${imagesWithData.length}…`;

      const descInput = document.querySelector(`.char-img-desc[data-idx="${i}"]`);
      if (descInput) {
        descInput.disabled = true;
        descInput.placeholder = 'Generating caption…';
      }

      const caption = await API.generateImageCaption(img.dataUrl, { ...meta, tag: img.tag }).catch(() => null);

      if (caption && state.images[i] === img) {
        img.description = caption;
        if (descInput) descInput.value = caption;
      } else {
        failed++;
      }
      if (descInput) {
        descInput.disabled = false;
        descInput.placeholder = config.descPlaceholder;
      }
    }

    if (captionAllBtn) {
      captionAllBtn.disabled = false;
      captionAllBtn.textContent = '\u{1F4DD} Caption All';
    }
    if (failed > 0) {
      App.toast(`Captioned ${done - failed}/${done} images (${failed} failed)`, 'info');
    } else {
      App.toast(`Captioned ${done} image(s)`, 'success');
    }
    refreshGallery();
  }

  /** Best uploaded image to use as the generation source: primary if set, else first with data. */
  function primarySourceImage() {
    const primaryCandidate = state.images[state.primaryIndex];
    return primaryCandidate && primaryCandidate.dataUrl ? primaryCandidate : state.images.find((img) => img.dataUrl);
  }

  /**
   * Toggle an inline dropdown panel for generating reference image variations:
   * a type selector, an editable prompt, and a one-click generate button.
   */
  function generateReferences() {
    // Toggle: close if already open
    const existing = document.getElementById(`${config.idPrefix}-ref-dropdown`);
    if (existing) {
      existing.remove();
      return;
    }

    const primaryImg = primarySourceImage();
    if (!primaryImg) return App.toast('Upload at least one image first', 'error');

    const slotsAvailable = MAX_IMAGES - state.images.filter((img) => img.dataUrl).length;
    if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

    const variations = config.refVariations();

    // Build <option> list from predefined variations + a custom option
    const options = variations
      .map((v, i) => `<option value="${i}">${escHtml(v.tag)} — ${escHtml(v.desc)}</option>`)
      .join('');

    const toolbar = document.getElementById(`${config.idPrefix}-img-toolbar`);
    if (!toolbar) return;

    const panel = document.createElement('div');
    panel.id = `${config.idPrefix}-ref-dropdown`;
    panel.className = 'gen-ref-dropdown';
    panel.innerHTML = `
    <div class="gen-ref-row">
      <select id="${config.idPrefix}-ref-type">${options}<option value="custom">✏️ Custom prompt</option></select>
    </div>
    <textarea id="${config.idPrefix}-ref-prompt" class="gen-ref-prompt" placeholder="Describe the reference image you want to generate…">${escHtml(config.resolveRefPrompt(variations[0]))}</textarea>
    <div class="gen-ref-hint" id="${config.idPrefix}-ref-slots">${slotsAvailable} image slot${slotsAvailable !== 1 ? 's' : ''} available</div>
    <div class="gen-ref-actions">
      <button class="btn btn-primary btn-sm" id="${config.idPrefix}-ref-go-btn" data-action="_doGenerateReferences">Generate</button>
      <button class="btn btn-secondary btn-sm" data-action="generateReferences">Close</button>
    </div>
  `;
    toolbar.insertAdjacentElement('afterend', panel);

    // Update prompt textarea when dropdown selection changes
    document.getElementById(`${config.idPrefix}-ref-type`).addEventListener('change', (e) => {
      const idx = e.target.value;
      const promptEl = document.getElementById(`${config.idPrefix}-ref-prompt`);
      if (idx === 'custom') {
        promptEl.value = '';
        promptEl.focus();
      } else {
        promptEl.value = config.resolveRefPrompt(variations[parseInt(idx, 10)]);
      }
    });
  }

  /** Execute reference generation from the inline dropdown panel. */
  async function _doGenerateReferences() {
    const typeSelect = document.getElementById(`${config.idPrefix}-ref-type`);
    const promptEl = document.getElementById(`${config.idPrefix}-ref-prompt`);
    if (!typeSelect || !promptEl) return;

    const slotsAvailable = MAX_IMAGES - state.images.filter((img) => img.dataUrl).length;
    if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

    const prompt = promptEl.value.trim();
    if (!prompt) return App.toast('Enter a prompt describing the image to generate', 'error');

    const variations = config.refVariations();
    const selectedIdx = typeSelect.value;
    const variation = selectedIdx !== 'custom' ? variations[parseInt(selectedIdx, 10)] : null;
    const tag = variation ? variation.tag : 'custom';

    const primaryImg = primarySourceImage();
    if (!primaryImg) return App.toast('Upload at least one image first', 'error');

    const goBtn = document.getElementById(`${config.idPrefix}-ref-go-btn`);
    if (goBtn) {
      goBtn.disabled = true;
      goBtn.textContent = 'Generating…';
    }

    const dataUrl = await API.generateRefVariation(primaryImg.dataUrl, prompt).catch(() => null);

    if (dataUrl) {
      const newImg = newImage({ dataUrl, tag, aiGenerated: true, generationPrompt: prompt });
      state.images.push(newImg);
      refreshGallery();

      // Auto-caption the generated image
      const meta = { ...config.captionMeta(), tag };
      if (!meta.name) meta.name = config.fallbackName;
      const caption = await API.generateImageCaption(dataUrl, meta).catch(() => null);
      if (caption) {
        newImg.description = caption;
        refreshGallery();
      }
      App.toast('Reference image generated', 'success');
    } else {
      App.toast('Generation failed — try again or adjust the prompt', 'error');
    }

    if (goBtn) {
      goBtn.disabled = false;
      goBtn.textContent = 'Generate';
    }
    // Update slot count in dropdown
    const slotsEl = document.getElementById(`${config.idPrefix}-ref-slots`);
    if (slotsEl) {
      const remaining = MAX_IMAGES - state.images.filter((img) => img.dataUrl).length;
      slotsEl.textContent = `${remaining} image slot${remaining !== 1 ? 's' : ''} available`;
    }
  }

  /**
   * Regenerate a single AI-generated reference image.
   * Uses the primary uploaded image as the source and the stored generation prompt.
   */
  async function regenerateImage(idx: number): Promise<void> {
    const img = state.images[idx];
    if (!img || !img.aiGenerated) return App.toast('This image was not AI-generated', 'error');

    const primaryImg = state.images.find((src) => src.dataUrl && !src.aiGenerated);
    if (!primaryImg) return App.toast('No source image found for regeneration', 'error');

    // Re-derive the prompt from the tag variation or use stored prompt
    const prompt = img.generationPrompt || config.fallbackRegenPrompt(img);

    const preview = document.querySelector(`.char-img-slot[data-idx="${idx}"] .char-img-slot-preview`);
    if (preview) preview.style.opacity = '0.5';
    const regenBtn = document.querySelector(`.char-img-slot[data-idx="${idx}"] .char-img-regen`);
    if (regenBtn) regenBtn.disabled = true;

    const dataUrl = await API.generateRefVariation(primaryImg.dataUrl, prompt).catch(() => null);

    if (dataUrl) {
      img.dataUrl = dataUrl;
      img.generationPrompt = prompt;

      // Re-caption
      const meta = { ...config.captionMeta(), tag: img.tag };
      if (!meta.name) meta.name = config.fallbackName;
      const caption = await API.generateImageCaption(dataUrl, meta).catch(() => null);
      if (caption) {
        img.description = caption;
      }
      refreshGallery();
      App.toast('Reference image regenerated', 'success');
    } else {
      if (preview) preview.style.opacity = '1';
      if (regenBtn) regenBtn.disabled = false;
      App.toast('Regeneration failed', 'error');
    }
  }

  function updateTag(idx: number, select: any): void {
    if (state.images[idx]) {
      state.images[idx].tag = select.value;
    }
  }

  function updateDesc(idx: number, input: any): void {
    if (state.images[idx]) {
      state.images[idx].description = input.value;
    }
  }

  function setPrimary(idx: number): void {
    // Toggle: clicking the already-active star deselects it
    state.primaryIndex = idx === state.primaryIndex ? -1 : idx;
    // Update star button states in place
    document.querySelectorAll(`#${config.idPrefix}-img-gallery .char-img-primary`).forEach((btn, i) => {
      btn.classList.toggle('active', i === state.primaryIndex);
    });
  }

  /** Set the anchor to the image at idx (explicit control, spec §12.1). */
  function setAnchor(idx: number): void {
    const img = state.images[idx];
    if (!img?.dataUrl) return App.toast('Upload an image first', 'error');
    if (!img.id) img.id = newId();
    state.anchorImageId = img.id;
    refreshGallery();
    App.toast(config.anchorSetToast(state.name), 'success');
  }

  function removeImage(idx: number): void {
    const removed = state.images[idx];
    state.images.splice(idx, 1);
    if (state.primaryIndex >= state.images.length) state.primaryIndex = Math.max(0, state.images.length - 1);
    // Deleting the active anchor: fall back deterministically and tell the user
    // exactly which image becomes the anchor so they can pick a different one.
    if (removed?.id && removed.id === state.anchorImageId) {
      const fallback = state.images.find((img) => img.dataUrl);
      state.anchorImageId = fallback?.id || null;
      if (fallback) {
        App.toast(config.anchorRemovedToast(config.anchorFallbackLabel(fallback)), 'info');
      } else {
        App.toast(config.anchorRemovedEmptyToast, 'info');
      }
    }
    refreshGallery();
  }

  return {
    state,
    renderGallerySlots,
    refreshGallery,
    addImageSlot,
    pickImageForSlot,
    handleImage,
    recaptionImage,
    recaptionAll,
    generateReferences,
    _doGenerateReferences,
    regenerateImage,
    updateTag,
    updateDesc,
    setPrimary,
    setAnchor,
    removeImage,
  };
}

/**
 * Shared list-view scaffold for entity pages (header, + New button, empty
 * state, newest-first item list). Per-item markup stays in cfg.listItem.
 */
export async function renderEntityList(cfg): Promise<string> {
  const records = await DB.getAll(cfg.store);
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return `
    <div class="slide-up">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <h2 class="section-title" style="margin-bottom:4px;">${cfg.title}</h2>
          <p class="text-sm text-muted">${cfg.subtitle}</p>
        </div>
        <button class="btn btn-primary btn-sm" data-action="${cfg.newMethod}">+ New</button>
      </div>

      ${
        records.length === 0
          ? `
        <div class="empty-state">
          <div class="empty-state-icon">${cfg.emptyIcon}</div>
          <div class="empty-state-text">${cfg.emptyText}</div>
          <button class="btn btn-primary" data-action="${cfg.newMethod}">${cfg.emptyButtonLabel}</button>
        </div>
      `
          : records.map((r) => cfg.listItem(r)).join('')
      }
    </div>
  `;
}

/** Download an entity record as a JSON export file. */
export async function exportEntityRecord(cfg, id: string): Promise<void> {
  const record = await DB.get(cfg.store, id);
  if (!record) return App.toast(`${cfg.label} not found`, 'error');
  const data = {
    [cfg.collectionKey]: [record],
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = record.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  a.download = `${cfg.filePrefix}-${safeName}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  App.toast(`${cfg.label} exported!`, 'success');
}

/** Confirmation modal for deleting an entity; confirms via the page's confirmDelete action. */
export function showDeleteEntityModal(cfg, id: string, name: string): void {
  App.showModal(`
    <div class="modal-title">Delete ${cfg.label}</div>
    <p>Are you sure you want to delete <strong>${escHtml(name)}</strong>?</p>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
      <button class="btn btn-danger btn-sm" data-action="confirmDelete" data-args="${escHtml(JSON.stringify([id]))}">Delete</button>
    </div>
  `);
}

export async function confirmDeleteEntity(cfg, id: string): Promise<void> {
  await DB.del(cfg.store, id);
  App.hideModal();
  App.toast(`${cfg.label} deleted`, 'info');
  App.refreshPage();
}

/** @deprecated Temporary compatibility shim until the legacy galleries are replaced. */
export async function embedImagesForSave(
  _validImages: any[],
  _name: string,
  _saveBtnId: string,
  _restoreLabel: string,
): Promise<void> {
  return Promise.resolve();
}
