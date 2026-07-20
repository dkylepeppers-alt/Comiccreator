// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml, newId, normalizeLocationKey } from '../utils.js';
import DB from '../db.js';
import API from '../api.js';
import {
  MAX_IMAGES,
  createGalleryEditor,
  renderEntityList,
  exportEntityRecord,
  showDeleteEntityModal,
  confirmDeleteEntity,
  embedImagesForSave,
} from '../entity-gallery.js';

/**
 * World Builder Page
 */
let currentView: string = 'list';
let editingId: string | null = null;

const IMAGE_TAGS: string[] = [
  'establishing',
  'exterior',
  'exterior-street',
  'exterior-rooftop',
  'exterior-alley',
  'exterior-entrance',
  'exterior-courtyard',
  'interior',
  'interior-living-room',
  'interior-bedroom',
  'interior-kitchen',
  'interior-bathroom',
  'interior-office',
  'interior-hallway',
  'interior-dining-room',
  'interior-basement',
  'interior-attic',
  'aerial',
  'night',
  'day',
  'detail',
  'landmark',
  'character-interaction',
  'custom',
];

const gallery = createGalleryEditor({
  idPrefix: 'world',
  imageTags: IMAGE_TAGS,
  defaultTag: 'establishing',
  newImageExtra: () => ({ locationKey: null }),
  descPlaceholder: 'e.g. Neon-lit alley at night',
  anchorBadgeTitle: 'Default world anchor — used when a planned location has no exact match',
  anchorButtonTitle: 'Set as default world anchor',
  slotExtraInputs: (img, i) =>
    `<input type="text" class="char-img-lockey" data-idx="${i}" value="${escHtml(img.locationKey || '')}" placeholder="location key, e.g. main-street" data-action-input="updateLocationKey" data-args="[${i}]" title="Unique key the story planner uses to pick this image as the location anchor">`,
  captionMeta: () => ({
    type: 'world',
    name: document.getElementById('world-name')?.value.trim() || '',
    era: document.getElementById('world-era')?.value.trim() || '',
  }),
  fallbackName: 'the location',
  refVariations: () => API.WORLD_REF_VARIATIONS,
  resolveRefPrompt: (v) => {
    const curName = document.getElementById('world-name')?.value.trim() || 'the location';
    const curDesc = document.getElementById('world-desc')?.value.trim() || '';
    return (v?.prompt || '')
      .replace(/\{name\}/g, curName)
      .replace(/\{description\}/g, curDesc || 'as shown in the reference image');
  },
  fallbackRegenPrompt: (img) => {
    const name = document.getElementById('world-name')?.value.trim() || 'the location';
    const description = document.getElementById('world-desc')?.value.trim() || '';
    const variation = API.WORLD_REF_VARIATIONS.find((v) => v.tag === img.tag);
    if (variation) {
      return variation.prompt
        .replace(/\{name\}/g, name)
        .replace(/\{description\}/g, description || 'as shown in the reference image');
    }
    return `${img.tag} view of ${name}, ${description || 'as shown in the reference'}`;
  },
  // Async: add interactions button if 2+ characters are linked
  afterToolbarRefresh: (toolbar, hasImages) => {
    if (!hasImages || !editingId) return;
    DB.getAll(DB.STORES.characters)
      .then((chars) => {
        const linked = chars.filter((c) => c.linkedWorldId === editingId);
        if (linked.length >= 2 && toolbar.parentNode) {
          const interBtn =
            '<button class="btn btn-secondary btn-sm" id="world-gen-interactions-btn" data-action="generateCharacterInteractions" title="Generate images of linked characters interacting in this world">&#129489; Generate Interactions</button>';
          if (!toolbar.querySelector('#world-gen-interactions-btn')) {
            toolbar.insertAdjacentHTML('beforeend', interBtn);
          }
        }
      })
      .catch((err) => {
        App.logError('WorldsPage.refreshGallery: failed to load characters', err, { worldId: editingId });
        App.toast('Could not load characters for interaction images. Check the error log for details.', 'error');
      });
  },
  slotHintIds: ['world-ref-slots', 'world-inter-slots'],
  anchorSetToast: () => 'Default world anchor set — used when a planned location has no exact key match',
  anchorFallbackLabel: (img) => img.locationKey || img.description || img.tag || 'first gallery image',
  anchorRemovedToast: (label) =>
    `Default anchor removed — falling back to "${label}". Pick a different anchor if needed.`,
  anchorRemovedEmptyToast: 'Default anchor removed — this world has no anchor until you add an image.',
});

const entityCfg = {
  store: DB.STORES.worlds,
  label: 'World',
  collectionKey: 'worlds',
  filePrefix: 'world',
};

async function render(param?: string | null): Promise<string> {
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
  return renderEntityList({
    store: DB.STORES.worlds,
    newMethod: 'newWorld',
    title: 'World Builder',
    subtitle: 'Create settings for your comics',
    emptyIcon: '&#127758;',
    emptyText: 'No worlds yet. Build your first setting!',
    emptyButtonLabel: 'Create World',
    listItem: (w) => {
      const migrated = DB.migrateWorld(w);
      const thumb = migrated.images?.[migrated.primaryImageIndex ?? 0]?.dataUrl || '';
      return `
        <div class="list-item" data-action="editWorld" data-args="${escHtml(JSON.stringify([w.id]))}">
          <div class="list-item-avatar">
            ${thumb ? `<img src="${escHtml(thumb)}" alt="${escHtml(w.name)}">` : '&#127758;'}
          </div>
          <div class="list-item-info">
            <div class="list-item-title">${escHtml(w.name)}</div>
            <div class="list-item-desc">${escHtml(w.description || '').slice(0, 80)}</div>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-secondary" title="Export" data-action="exportWorld" data-args="${escHtml(JSON.stringify([w.id]))}">&#128229;</button>
            <button class="btn btn-sm btn-danger" data-action="deleteWorld" data-args="${escHtml(JSON.stringify([w.id, w.name]))}">&#128465;</button>
          </div>
        </div>
      `;
    },
  });
}

async function renderEditor() {
  let world = {
    name: '',
    description: '',
    details: '',
    era: '',
    atmosphere: '',
    images: [],
    primaryImageIndex: 0,
    defaultAnchorImageId: null,
  };
  if (editingId) {
    const saved = await DB.get(DB.STORES.worlds, editingId);
    if (saved) world = DB.normalizeWorldRecord(saved).record;
  }
  gallery.state.images = (world.images || []).map((img) => Object.assign({}, img));
  gallery.state.primaryIndex = world.primaryImageIndex ?? 0;
  gallery.state.anchorImageId = world.defaultAnchorImageId ?? null;
  gallery.state.name = world.name || '';
  const editorImages = gallery.state.images;

  // Find characters linked to this world
  const linkedChars = editingId
    ? (await DB.getAll(DB.STORES.characters)).filter((c) => c.linkedWorldId === editingId)
    : [];

  return `
    <div class="slide-up">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <button class="btn btn-sm btn-secondary" data-action="backToList">&#8592; Back</button>
        <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} World</h2>
        ${editingId ? `<button class="btn btn-sm btn-secondary" style="margin-left:auto;" title="Exports last saved version" data-action="exportWorld" data-args="${escHtml(JSON.stringify([editingId]))}">&#128229; Export</button>` : ''}
      </div>

      <div class="card">
        <!-- Reference Images (up to ${MAX_IMAGES}) -->
        <div class="form-group">
          <label class="form-label">Reference Images (up to ${MAX_IMAGES})</label>
          <div class="char-img-gallery" id="world-img-gallery">
            ${gallery.renderGallerySlots()}
          </div>
          <input type="file" id="world-img-input" accept="image/*" class="hidden" data-action-change="handleImage">
          <div class="char-img-toolbar" id="world-img-toolbar">
            ${editorImages.length < MAX_IMAGES ? `<button class="btn btn-secondary btn-sm" data-action="addImageSlot">+ Add Image</button>` : ''}
            <button class="btn btn-secondary btn-sm" id="world-caption-all-btn" data-action="recaptionAll" style="${editorImages.some((img) => img.dataUrl) ? '' : 'display:none'}">&#128221; Caption All</button>
            <button class="btn btn-secondary btn-sm" id="world-gen-refs-btn" data-action="generateReferences" style="${editorImages.some((img) => img.dataUrl) ? '' : 'display:none'}" title="Generate reference images from your uploaded image">&#127912; Generate References</button>
            ${editorImages.some((img) => img.dataUrl) && linkedChars.length >= 2 ? `<button class="btn btn-secondary btn-sm" id="world-gen-interactions-btn" data-action="generateCharacterInteractions" title="Generate images of linked characters interacting in this world">&#129489; Generate Interactions</button>` : ''}
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

        ${
          linkedChars.length > 0
            ? `
        <div class="form-group">
          <label class="form-label">Linked Characters (${linkedChars.length})</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${linkedChars
              .map(
                (c) => `
              <div class="chip" data-navigate="characters" data-param="${c.id}" style="cursor:pointer;" title="Edit ${escHtml(c.name)}">
                ${escHtml(c.name)}${c.role ? ` <span class="text-muted" style="font-size:0.75em;">(${escHtml(c.role)})</span>` : ''}
              </div>
            `,
              )
              .join('')}
          </div>
          <div class="form-hint">Characters linked to this world. Click a character to edit them.</div>
        </div>
        `
            : ''
        }
      </div>

      <button class="btn btn-primary btn-block mt-sm" id="world-save-btn" data-action="saveWorld">
        ${editingId ? 'Update' : 'Create'} World
      </button>
    </div>
  `;
}

function newWorld() {
  App.navigate('worlds', 'new');
}

async function editWorld(id: string): Promise<void> {
  App.navigate('worlds', id);
}

function backToList() {
  App.navigate('worlds', null);
}

// Legacy handler kept for backward compat
function pickImage(idx: number): void {
  gallery.pickImageForSlot(idx);
}

/**
 * Toggle an inline dropdown panel for generating character interaction images.
 * Requires at least 2 characters linked to this world and at least one world image.
 */
async function generateCharacterInteractions() {
  // Toggle: close if already open
  const existing = document.getElementById('world-inter-dropdown');
  if (existing) {
    existing.remove();
    return;
  }

  if (!editingId) return App.toast('Save the world first before generating interactions', 'error');

  const primaryCandidate = gallery.state.images[gallery.state.primaryIndex];
  const worldImg =
    primaryCandidate && primaryCandidate.dataUrl ? primaryCandidate : gallery.state.images.find((img) => img.dataUrl);
  if (!worldImg) return App.toast('Upload at least one world image first', 'error');

  const allChars = await DB.getAll(DB.STORES.characters);
  const linkedChars = allChars.filter((c) => c.linkedWorldId === editingId);
  if (linkedChars.length < 2) return App.toast('Link at least 2 characters to this world first', 'error');

  const worldName = document.getElementById('world-name')?.value.trim() || 'the world';
  const worldDesc = document.getElementById('world-desc')?.value.trim() || '';

  const slotsAvailable = MAX_IMAGES - gallery.state.images.filter((img) => img.dataUrl).length;
  if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

  // Pick up to 4 characters for the interaction shot
  const castChars = linkedChars.slice(0, 4);
  const castNames = castChars.map((c) => c.name).join(', ');
  const castDesc = castChars
    .map((c) => {
      const appearances = c.appearance ? ` (${c.appearance.trim()})` : '';
      return `${c.name}${appearances}`;
    })
    .join('; ');

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

  // Build <option> list from predefined interaction prompts + custom
  const options = interactionPrompts.map((v, i) => `<option value="${i}">${escHtml(v.desc)}</option>`).join('');

  // Build linked characters display
  const charList = castChars
    .map(
      (c) =>
        `<strong>${escHtml(c.name)}</strong>${c.appearance ? ` <span class="text-muted">(${escHtml(c.appearance.slice(0, 60))})</span>` : ''}`,
    )
    .join(', ');

  const toolbar = document.getElementById('world-img-toolbar');
  if (!toolbar) return;

  const panel = document.createElement('div');
  panel.id = 'world-inter-dropdown';
  panel.className = 'gen-ref-dropdown';
  panel.innerHTML = `
    <div class="gen-ref-hint">Characters: ${charList}</div>
    <div class="gen-ref-row">
      <select id="world-inter-type">${options}<option value="custom">✏️ Custom prompt</option></select>
    </div>
    <textarea id="world-inter-prompt" class="gen-ref-prompt" placeholder="Describe the character interaction scene you want to generate…">${escHtml(interactionPrompts[0].prompt)}</textarea>
    <div class="gen-ref-hint" id="world-inter-slots">${slotsAvailable} image slot${slotsAvailable !== 1 ? 's' : ''} available</div>
    <div class="gen-ref-actions">
      <button class="btn btn-primary btn-sm" id="world-inter-go-btn" data-action="_doGenerateCharacterInteractions">Generate</button>
      <button class="btn btn-secondary btn-sm" data-action="generateCharacterInteractions">Close</button>
    </div>
  `;
  toolbar.insertAdjacentElement('afterend', panel);

  // Store context for the generate handler
  WorldsPage._pendingInteractionData = {
    prompts: interactionPrompts,
    castChars,
    castNames,
    castDesc,
    worldName,
    worldDesc,
    worldImg,
  };

  // Update prompt textarea when dropdown selection changes
  document.getElementById('world-inter-type').addEventListener('change', (e) => {
    const idx = e.target.value;
    const promptEl = document.getElementById('world-inter-prompt');
    if (idx === 'custom') {
      promptEl.value = '';
      promptEl.focus();
    } else {
      promptEl.value = interactionPrompts[parseInt(idx, 10)]?.prompt || '';
    }
  });
}

/** Execute character interaction generation from the inline dropdown panel. */
async function _doGenerateCharacterInteractions() {
  const typeSelect = document.getElementById('world-inter-type');
  const promptEl = document.getElementById('world-inter-prompt');
  if (!typeSelect || !promptEl) return;

  const slotsAvailable = MAX_IMAGES - gallery.state.images.filter((img) => img.dataUrl).length;
  if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

  const prompt = promptEl.value.trim();
  if (!prompt) return App.toast('Enter a prompt describing the interaction scene to generate', 'error');

  const data = WorldsPage._pendingInteractionData;
  if (!data) return App.toast('Interaction data not found — close and reopen the panel', 'error');

  const selectedIdx = typeSelect.value;
  const variation = selectedIdx !== 'custom' ? data.prompts[parseInt(selectedIdx, 10)] : null;

  const { castChars, castNames, worldName, worldImg } = data;

  // Collect primary images for each character to use as references
  const charRefUrls = castChars
    .map((c) => {
      const m = DB.migrateCharacter(c);
      const img = m.images?.[m.primaryImageIndex ?? 0] || m.images?.[0];
      return img?.dataUrl || null;
    })
    .filter(Boolean);

  const refUrls = [worldImg.dataUrl, ...charRefUrls];

  const goBtn = document.getElementById('world-inter-go-btn');
  if (goBtn) {
    goBtn.disabled = true;
    goBtn.textContent = 'Generating…';
  }

  const dataUrl = await API.generateRefVariation(null, prompt, { imageDataUrls: refUrls }).catch(() => null);

  if (dataUrl) {
    const desc = variation ? variation.desc : `Character interaction in ${worldName}`;
    const newImg = {
      id: newId(),
      dataUrl,
      tag: 'character-interaction',
      description: desc,
      embedding: null,
      embeddingText: null,
      aiGenerated: true,
      generationPrompt: prompt,
      locationKey: null,
    };
    gallery.state.images.push(newImg);
    gallery.refreshGallery();

    const caption = await API.generateImageCaption(dataUrl, {
      type: 'character-interaction',
      name: worldName,
      tag: 'character-interaction',
      characterNames: castNames,
      worldName,
    }).catch(() => null);
    if (caption) {
      newImg.description = caption;
      newImg.embedding = null;
      newImg.embeddingText = null;
      gallery.refreshGallery();
    }
    App.toast('Interaction image generated', 'success');
  } else {
    App.toast('Generation failed — try again or adjust the prompt', 'error');
  }

  if (goBtn) {
    goBtn.disabled = false;
    goBtn.textContent = 'Generate';
  }
  // Update slot count
  const slotsEl = document.getElementById('world-inter-slots');
  if (slotsEl) {
    const remaining = MAX_IMAGES - gallery.state.images.filter((img) => img.dataUrl).length;
    slotsEl.textContent = `${remaining} image slot${remaining !== 1 ? 's' : ''} available`;
  }
}

/** Update an image's location key (normalized to slug form on save). */
function updateLocationKey(idx: number, input: any): void {
  if (gallery.state.images[idx]) {
    gallery.state.images[idx].locationKey = input.value.trim() || null;
  }
}

async function saveWorld() {
  const name = document.getElementById('world-name').value.trim();
  const description = document.getElementById('world-desc').value.trim();
  if (!name) return App.toast('World name is required', 'error');
  if (!description) return App.toast('Description is required', 'error');

  // Filter out empty slots (no dataUrl), remapping primary index to the filtered list
  const validImages = [];
  let primaryIdx = -1;
  gallery.state.images.forEach((img, idx) => {
    if (!img || !img.dataUrl) return;
    if (idx === gallery.state.primaryIndex) primaryIdx = validImages.length;
    validImages.push(img);
  });
  if (primaryIdx >= validImages.length) primaryIdx = validImages.length > 0 ? 0 : -1;

  await embedImagesForSave(validImages, name, 'world-save-btn', editingId ? 'Update World' : 'Create World');

  // Normalize location keys and reject duplicates within this world so the
  // planner's locationKey → anchor mapping stays unambiguous
  const seenKeys = new Set();
  for (const img of validImages) {
    const norm = normalizeLocationKey(img.locationKey) || null;
    img.locationKey = norm;
    if (norm) {
      if (seenKeys.has(norm)) {
        return App.toast(`Duplicate location key "${norm}" — each key must be unique within a world`, 'error');
      }
      seenKeys.add(norm);
    }
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
    defaultAnchorImageId: gallery.state.anchorImageId,
    createdAt: existingWorld?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  await DB.put(DB.STORES.worlds, DB.normalizeWorldRecord(world).record);
  App.toast(`World ${editingId ? 'updated' : 'created'}!`, 'success');
  backToList();
}

async function exportWorld(id: string): Promise<void> {
  return exportEntityRecord(entityCfg, id);
}

async function deleteWorld(id: string, name: string): Promise<void> {
  showDeleteEntityModal(entityCfg, id, name);
}

async function confirmDelete(id: string): Promise<void> {
  return confirmDeleteEntity(entityCfg, id);
}

const WorldsPage: PageModule & Record<string, any> = {
  render,
  newWorld,
  editWorld,
  backToList,
  pickImage,
  pickImageForSlot: gallery.pickImageForSlot,
  handleImage: gallery.handleImage,
  addImageSlot: gallery.addImageSlot,
  updateTag: gallery.updateTag,
  updateDesc: gallery.updateDesc,
  updateLocationKey,
  setPrimary: gallery.setPrimary,
  setAnchor: gallery.setAnchor,
  removeImage: gallery.removeImage,
  recaptionImage: gallery.recaptionImage,
  recaptionAll: gallery.recaptionAll,
  generateReferences: gallery.generateReferences,
  _doGenerateReferences: gallery._doGenerateReferences,
  regenerateImage: gallery.regenerateImage,
  generateCharacterInteractions,
  _doGenerateCharacterInteractions,
  _pendingInteractionData: null,
  saveWorld,
  exportWorld,
  deleteWorld,
  confirmDelete,
};
export default WorldsPage;
