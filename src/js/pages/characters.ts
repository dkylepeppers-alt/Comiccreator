// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml, newId } from '../utils.js';
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
 * Character Builder Page
 */
let currentView: string = 'list'; // 'list' or 'edit'
let editingId: string | null = null;

const IMAGE_TAGS: string[] = [
  'default',
  'front-view',
  'side-view',
  'back-view',
  'close-up',
  'action-pose',
  'alternate-outfit',
  'expression',
  'character-sheet',
  'character-in-world',
  'custom',
];

const gallery = createGalleryEditor({
  idPrefix: 'char',
  imageTags: IMAGE_TAGS,
  defaultTag: 'default',
  descPlaceholder: 'e.g. Battle armor with sword drawn',
  anchorBadgeTitle: "Identity anchor — controls this character's stable identity in generated panels",
  anchorButtonTitle: 'Set as identity anchor',
  captionMeta: () => ({
    type: 'character',
    name: document.getElementById('char-name')?.value.trim() || '',
    role: document.getElementById('char-role')?.value || '',
    appearance: document.getElementById('char-appearance')?.value.trim() || '',
  }),
  fallbackName: 'the character',
  refVariations: () => API.CHARACTER_REF_VARIATIONS,
  resolveRefPrompt: (v) => v?.prompt || '',
  fallbackRegenPrompt: (img) => {
    const variation = API.CHARACTER_REF_VARIATIONS.find((v) => v.tag === img.tag);
    if (variation) return variation.prompt;
    return `Generate a ${img.tag.replace(/-/g, ' ')} of the character in the reference image, clean background`;
  },
  toolbarExtraHtml: (hasImages) => {
    if (!hasImages) return '';
    const linkedWorldId = document.getElementById('char-linked-world')?.value || '';
    return linkedWorldId
      ? '<button class="btn btn-secondary btn-sm" id="char-gen-world-btn" data-action="generateWorldInteractions" title="Generate images of this character interacting with their linked world">&#127758; Generate in World</button>'
      : '';
  },
  slotHintIds: ['char-ref-slots', 'char-world-slots'],
  anchorSetToast: (name) =>
    `Identity anchor set — this image now controls ${name || 'this character'}'s stable identity`,
  anchorFallbackLabel: (img) => img.description || img.tag || 'first gallery image',
  anchorRemovedToast: (label) =>
    `Identity anchor removed — falling back to "${label}". Pick a different anchor if needed.`,
  anchorRemovedEmptyToast: 'Identity anchor removed — this character has no anchor until you add an image.',
});

const entityCfg = {
  store: DB.STORES.characters,
  label: 'Character',
  collectionKey: 'characters',
  filePrefix: 'character',
};

async function render(param?: string | null): Promise<string> {
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
  return renderEntityList({
    store: DB.STORES.characters,
    newMethod: 'newCharacter',
    title: 'Character Builder',
    subtitle: 'Design heroes, sidekicks, and villains',
    emptyIcon: '&#129464;',
    emptyText: 'No characters yet. Create your first hero!',
    emptyButtonLabel: 'Create Character',
    listItem: (c) => {
      const migrated = DB.migrateCharacter(c);
      const thumb = migrated.images?.[migrated.primaryImageIndex ?? 0]?.dataUrl || migrated.imageData || '';
      return `
        <div class="list-item" data-action="editCharacter" data-args="${escHtml(JSON.stringify([c.id]))}">
          <div class="list-item-avatar">
            ${thumb ? `<img src="${thumb}" alt="${escHtml(c.name)}">` : '&#129464;'}
          </div>
          <div class="list-item-info">
            <div class="list-item-title">${escHtml(c.name)}</div>
            <div class="list-item-desc">${escHtml(c.role || 'No role')} &middot; ${escHtml(c.description || '').slice(0, 60)}</div>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-secondary" title="Export" data-action="exportCharacter" data-args="${escHtml(JSON.stringify([c.id]))}">&#128229;</button>
            <button class="btn btn-sm btn-danger" data-action="deleteCharacter" data-args="${escHtml(JSON.stringify([c.id, c.name]))}">&#128465;</button>
          </div>
        </div>
      `;
    },
  });
}

async function renderEditor() {
  let char = {
    name: '',
    role: 'hero',
    description: '',
    appearance: '',
    backstory: '',
    powers: '',
    images: [],
    primaryImageIndex: 0,
    identityAnchorImageId: null,
    defaultVisualState: {},
    linkedWorldId: '',
  };
  if (editingId) {
    const saved = await DB.get(DB.STORES.characters, editingId);
    if (saved) char = DB.normalizeCharacterRecord(saved).record;
  }
  gallery.state.images = (char.images || []).map((img) => Object.assign({}, img));
  gallery.state.primaryIndex = char.primaryImageIndex ?? 0;
  gallery.state.anchorImageId = char.identityAnchorImageId ?? null;
  gallery.state.name = char.name || '';
  const dvs = char.defaultVisualState || {};
  const editorImages = gallery.state.images;

  const worlds = await DB.getAll(DB.STORES.worlds);

  return `
    <div class="slide-up">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <button class="btn btn-sm btn-secondary" data-action="backToList">&#8592; Back</button>
        <h2 class="section-title" style="margin:0;">${editingId ? 'Edit' : 'New'} Character</h2>
        ${editingId ? `<button class="btn btn-sm btn-secondary" style="margin-left:auto;" title="Exports last saved version" data-action="exportCharacter" data-args="${escHtml(JSON.stringify([editingId]))}">&#128229; Export</button>` : ''}
      </div>

      <div class="card">
        <!-- Reference Images (up to ${MAX_IMAGES}) -->
        <div class="form-group">
          <label class="form-label">Reference Images (up to ${MAX_IMAGES})</label>
          <div class="char-img-gallery" id="char-img-gallery">
            ${gallery.renderGallerySlots()}
          </div>
          <input type="file" id="char-img-input" accept="image/*" class="hidden" data-action-change="handleImage">
          <div class="char-img-toolbar" id="char-img-toolbar">
            ${editorImages.length < MAX_IMAGES ? `<button class="btn btn-secondary btn-sm" data-action="addImageSlot">+ Add Image</button>` : ''}
            <button class="btn btn-secondary btn-sm" id="char-caption-all-btn" data-action="recaptionAll" style="${editorImages.some((img) => img.dataUrl) ? '' : 'display:none'}">&#128221; Caption All</button>
            <button class="btn btn-secondary btn-sm" id="char-gen-refs-btn" data-action="generateReferences" style="${editorImages.some((img) => img.dataUrl) ? '' : 'display:none'}" title="Generate reference images from your uploaded image">&#127912; Generate References</button>
            ${editorImages.some((img) => img.dataUrl) && char.linkedWorldId ? `<button class="btn btn-secondary btn-sm" id="char-gen-world-btn" data-action="generateWorldInteractions" title="Generate images of this character interacting with their linked world">&#127758; Generate in World</button>` : ''}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Name *</label>
          <input type="text" id="char-name" value="${escHtml(char.name)}" placeholder="e.g. Captain Nova">
        </div>

        <div class="form-group">
          <label class="form-label">Role</label>
          <select id="char-role">
            ${['hero', 'sidekick', 'villain', 'antihero', 'mentor', 'support', 'other']
              .map(
                (r) =>
                  `<option value="${r}" ${char.role === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`,
              )
              .join('')}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Linked World</label>
          <select id="char-linked-world" data-action-change="refreshGallery">
            <option value="">— None —</option>
            ${worlds.map((w) => `<option value="${w.id}" ${char.linkedWorldId === w.id ? 'selected' : ''}>${escHtml(w.name)}</option>`).join('')}
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
          <div class="form-hint">The identity anchor image (&#9875;) controls stable physical identity — face, proportions, base hair. The wardrobe fields below control clothing.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Default Wardrobe</label>
          <input type="text" id="char-dvs-wardrobe" value="${escHtml(dvs.wardrobeDescription || '')}" placeholder="Leave blank to use the outfit shown in the identity anchor">
          <div class="form-hint">Exact clothing description reused verbatim across panels until the story changes it</div>
        </div>

        <div class="form-group">
          <label class="form-label">Default Hair State</label>
          <input type="text" id="char-dvs-hair" value="${escHtml(dvs.hairState || '')}" placeholder="e.g. tied back in a loose bun">
        </div>

        <div class="form-group">
          <label class="form-label">Default Carried Items / Injuries / Temporary Changes</label>
          <input type="text" id="char-dvs-items" value="${escHtml((dvs.carriedItems || []).join(', '))}" placeholder="Carried items (comma-separated)">
          <input type="text" id="char-dvs-injuries" class="mt-sm" value="${escHtml((dvs.injuries || []).join(', '))}" placeholder="Injuries (comma-separated)">
          <input type="text" id="char-dvs-temporary" class="mt-sm" value="${escHtml((dvs.temporaryChanges || []).join(', '))}" placeholder="Temporary changes (comma-separated)">
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

      <button class="btn btn-primary btn-block mt-sm" id="char-save-btn" data-action="saveCharacter">
        ${editingId ? 'Update' : 'Create'} Character
      </button>
    </div>
  `;
}

function newCharacter() {
  App.navigate('characters', 'new');
}

async function editCharacter(id: string): Promise<void> {
  App.navigate('characters', id);
}

function backToList() {
  App.navigate('characters', null);
}

// Legacy single-upload handler (kept for backward compat)
function pickImage() {
  gallery.pickImageForSlot(0);
}

/**
 * Toggle an inline dropdown panel for generating character-in-world images.
 * Uses both character and world reference images.
 */
async function generateWorldInteractions() {
  // Toggle: close if already open
  const existing = document.getElementById('char-world-dropdown');
  if (existing) {
    existing.remove();
    return;
  }

  const primaryCandidate = gallery.state.images[gallery.state.primaryIndex];
  const primaryImg =
    primaryCandidate && primaryCandidate.dataUrl ? primaryCandidate : gallery.state.images.find((img) => img.dataUrl);
  if (!primaryImg) return App.toast('Upload at least one character image first', 'error');

  const linkedWorldId = document.getElementById('char-linked-world')?.value || '';
  if (!linkedWorldId) return App.toast('Link this character to a world first', 'error');

  const world = await DB.get(DB.STORES.worlds, linkedWorldId);
  if (!world) return App.toast('Linked world not found', 'error');

  const name = document.getElementById('char-name')?.value.trim() || 'the character';

  const slotsAvailable = MAX_IMAGES - gallery.state.images.filter((img) => img.dataUrl).length;
  if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

  const variations = API.CHARACTER_WORLD_VARIATIONS;
  const appearance = document.getElementById('char-appearance')?.value.trim() || '';
  const charAppearanceNote = appearance ? ` (${appearance})` : '';

  // Build <option> list with placeholders resolved for display
  const options = variations
    .map((v, i) => {
      const label = v.desc.replace(/\{charName\}/g, name).replace(/\{worldName\}/g, world.name);
      return `<option value="${i}">${escHtml(v.tag)} — ${escHtml(label)}</option>`;
    })
    .join('');

  // Build initial prompt with placeholders resolved
  const initialPrompt = variations[0].prompt
    .replace(/\{charName\}/g, name)
    .replace(/\{charAppearanceNote\}/g, charAppearanceNote)
    .replace(/\{worldName\}/g, world.name)
    .replace(/\{worldDescription\}/g, world.description || 'as shown in the world reference');

  const toolbar = document.getElementById('char-img-toolbar');
  if (!toolbar) return;

  const panel = document.createElement('div');
  panel.id = 'char-world-dropdown';
  panel.className = 'gen-ref-dropdown';
  panel.innerHTML = `
    <div class="gen-ref-hint">Generate <strong>${escHtml(name)}</strong> in <strong>${escHtml(world.name)}</strong></div>
    <div class="gen-ref-row">
      <select id="char-world-type">${options}<option value="custom">✏️ Custom prompt</option></select>
    </div>
    <textarea id="char-world-prompt" class="gen-ref-prompt" placeholder="Describe the scene you want to generate…">${escHtml(initialPrompt)}</textarea>
    <div class="gen-ref-hint" id="char-world-slots">${slotsAvailable} image slot${slotsAvailable !== 1 ? 's' : ''} available</div>
    <div class="gen-ref-actions">
      <button class="btn btn-primary btn-sm" id="char-world-go-btn" data-action="_doGenerateWorldInteractions">Generate</button>
      <button class="btn btn-secondary btn-sm" data-action="generateWorldInteractions">Close</button>
    </div>
  `;
  toolbar.insertAdjacentElement('afterend', panel);

  // Store context for the generate handler (world is immutable; name/appearance are read fresh from DOM)
  CharactersPage._pendingWorldData = { world };

  // Update prompt textarea when dropdown selection changes
  document.getElementById('char-world-type').addEventListener('change', (e) => {
    const idx = e.target.value;
    const promptEl = document.getElementById('char-world-prompt');
    if (idx === 'custom') {
      promptEl.value = '';
      promptEl.focus();
    } else {
      const v = variations[parseInt(idx, 10)];
      // Re-read current character name and appearance so we don't use stale values
      const currentName = document.getElementById('char-name')?.value.trim() || 'the character';
      const currentAppearance = document.getElementById('char-appearance')?.value.trim() || '';
      const currentCharAppearanceNote = currentAppearance ? ` (${currentAppearance})` : '';
      promptEl.value = (v?.prompt || '')
        .replace(/\{charName\}/g, currentName)
        .replace(/\{charAppearanceNote\}/g, currentCharAppearanceNote)
        .replace(/\{worldName\}/g, world.name)
        .replace(/\{worldDescription\}/g, world.description || 'as shown in the world reference');
    }
  });
}

/** Execute character-in-world generation from the inline dropdown panel. */
async function _doGenerateWorldInteractions() {
  const typeSelect = document.getElementById('char-world-type');
  const promptEl = document.getElementById('char-world-prompt');
  if (!typeSelect || !promptEl) return;

  const slotsAvailable = MAX_IMAGES - gallery.state.images.filter((img) => img.dataUrl).length;
  if (slotsAvailable <= 0) return App.toast('Gallery is full — remove some images first', 'info');

  const prompt = promptEl.value.trim();
  if (!prompt) return App.toast('Enter a prompt describing the scene to generate', 'error');

  const variations = API.CHARACTER_WORLD_VARIATIONS;
  const selectedIdx = typeSelect.value;
  const variation = selectedIdx !== 'custom' ? variations[parseInt(selectedIdx, 10)] : null;
  const tag = variation ? variation.tag : 'character-in-world';

  const { world } = CharactersPage._pendingWorldData || {};
  if (!world) return App.toast('World data not found — close and reopen the panel', 'error');

  // Read fresh values from the DOM so edits made while the panel was open are reflected
  const name = document.getElementById('char-name')?.value.trim() || 'the character';

  const primaryCandidate = gallery.state.images[gallery.state.primaryIndex];
  const primaryImg =
    primaryCandidate && primaryCandidate.dataUrl ? primaryCandidate : gallery.state.images.find((img) => img.dataUrl);
  if (!primaryImg) return App.toast('Upload at least one character image first', 'error');

  const appearance = document.getElementById('char-appearance')?.value.trim() || '';

  const migratedWorld = DB.migrateWorld(world);
  const worldPrimaryImg = migratedWorld.images?.[migratedWorld.primaryImageIndex ?? 0] || migratedWorld.images?.[0];

  const refUrls = worldPrimaryImg?.dataUrl ? [primaryImg.dataUrl, worldPrimaryImg.dataUrl] : [primaryImg.dataUrl];

  const goBtn = document.getElementById('char-world-go-btn');
  if (goBtn) {
    goBtn.disabled = true;
    goBtn.textContent = 'Generating…';
  }

  const dataUrl = await API.generateRefVariation(null, prompt, { imageDataUrls: refUrls }).catch(() => null);

  if (dataUrl) {
    const desc = variation
      ? variation.desc.replace(/\{charName\}/g, name).replace(/\{worldName\}/g, world.name)
      : `${name} in ${world.name}`;
    const newImg = {
      id: newId(),
      dataUrl,
      tag,
      description: desc,
      embedding: null,
      embeddingText: null,
      aiGenerated: true,
      generationPrompt: prompt,
    };
    gallery.state.images.push(newImg);
    gallery.refreshGallery();

    const caption = await API.generateImageCaption(dataUrl, {
      type: 'character-in-world',
      name,
      tag,
      appearance,
      worldName: world.name,
    }).catch(() => null);
    if (caption) {
      newImg.description = caption;
      newImg.embedding = null;
      newImg.embeddingText = null;
      gallery.refreshGallery();
    }
    App.toast('World interaction image generated', 'success');
  } else {
    App.toast('Generation failed — try again or adjust the prompt', 'error');
  }

  if (goBtn) {
    goBtn.disabled = false;
    goBtn.textContent = 'Generate';
  }
  // Update slot count
  const slotsEl = document.getElementById('char-world-slots');
  if (slotsEl) {
    const remaining = MAX_IMAGES - gallery.state.images.filter((img) => img.dataUrl).length;
    slotsEl.textContent = `${remaining} image slot${remaining !== 1 ? 's' : ''} available`;
  }
}

async function saveCharacter() {
  const name = document.getElementById('char-name').value.trim();
  const description = document.getElementById('char-desc').value.trim();
  if (!name) return App.toast('Name is required', 'error');
  if (!description) return App.toast('Description is required', 'error');

  // Filter out empty slots (no dataUrl)
  const validImages = gallery.state.images.filter((img) => img.dataUrl);
  let primaryIdx = gallery.state.primaryIndex;
  if (primaryIdx >= validImages.length) primaryIdx = validImages.length > 0 ? 0 : -1;

  await embedImagesForSave(validImages, name, 'char-save-btn', editingId ? 'Update Character' : 'Create Character');

  const existingChar = editingId ? await DB.get(DB.STORES.characters, editingId) : null;

  const parseList = (id) =>
    (document.getElementById(id)?.value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

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
    identityAnchorImageId: gallery.state.anchorImageId,
    defaultVisualState: {
      wardrobeDescription: document.getElementById('char-dvs-wardrobe')?.value.trim() || '',
      hairState: document.getElementById('char-dvs-hair')?.value.trim() || '',
      carriedItems: parseList('char-dvs-items'),
      injuries: parseList('char-dvs-injuries'),
      temporaryChanges: parseList('char-dvs-temporary'),
    },
    imageData: '', // clear legacy field when images[] is present
    createdAt: existingChar?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  // Normalization guarantees stable image IDs and a valid anchor even for
  // records assembled from older editor state
  await DB.put(DB.STORES.characters, DB.normalizeCharacterRecord(char).record);
  App.toast(`Character ${editingId ? 'updated' : 'created'}!`, 'success');
  backToList();
}

async function exportCharacter(id: string): Promise<void> {
  return exportEntityRecord(entityCfg, id);
}

async function deleteCharacter(id: string, name: string): Promise<void> {
  showDeleteEntityModal(entityCfg, id, name);
}

async function confirmDelete(id: string): Promise<void> {
  return confirmDeleteEntity(entityCfg, id);
}

const CharactersPage: PageModule & Record<string, any> = {
  render,
  refreshGallery: gallery.refreshGallery,
  newCharacter,
  editCharacter,
  backToList,
  pickImage,
  pickImageForSlot: gallery.pickImageForSlot,
  handleImage: gallery.handleImage,
  addImageSlot: gallery.addImageSlot,
  updateTag: gallery.updateTag,
  updateDesc: gallery.updateDesc,
  setPrimary: gallery.setPrimary,
  setAnchor: gallery.setAnchor,
  removeImage: gallery.removeImage,
  recaptionImage: gallery.recaptionImage,
  recaptionAll: gallery.recaptionAll,
  generateReferences: gallery.generateReferences,
  _doGenerateReferences: gallery._doGenerateReferences,
  regenerateImage: gallery.regenerateImage,
  generateWorldInteractions,
  _doGenerateWorldInteractions,
  _pendingWorldData: null,
  saveCharacter,
  exportCharacter,
  deleteCharacter,
  confirmDelete,
};
export default CharactersPage;
