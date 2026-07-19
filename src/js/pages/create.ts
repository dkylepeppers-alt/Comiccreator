// @ts-nocheck
import type { PageModule } from '../utils.js';
import { sanitizeImagePrompt, escHtml, GENRES, dedupeByNameLatest, cosineSimilarity } from '../utils.js';
import DB from '../db.js';
import API from '../api.js';
import {
  PROMPT_VERSION,
  initializeContinuity,
  reducePageStates,
  validatePlannedPage,
  collectPageCast,
  collectPanelCast,
  collectLocationKeys,
  allocateReferences,
  effectiveReferenceBudget,
  resolveImageGenerationPlan,
  compileSequentialPagePrompt,
  compileIndependentPanelPrompt,
  compilePanelDescription,
  applyVisualStateChange,
} from '../visual-continuity.js';

/**
 * Create Comic Page - The core comic generation experience
 */
let state: any = {
  step: 'setup', // 'setup', 'generating', 'reading'
  genre: '',
  customGenre: '',
  selectedCharacters: [],
  selectedWorld: null,
  selectedPreset: null,
  selectedImagePreset: null,
  comicId: null,
  title: '',
  storyPrompt: '',
  pages: [],
  pageIds: [], // DB ids parallel to pages[], used for re-roll / undo
  conversationHistory: [],
  referenceImages: [], // world ref images [{dataUrl, label, type}]
  characterImagesByName: {}, // name → images[] from multi-image gallery
  characters: [],
  world: null, // full world record (normalized) for anchored generation
  plannerMode: false, // true when this comic uses the structured planner + continuity pipeline
  visualContinuity: null, // ComicVisualContinuity ledger for the active comic
  isGenerating: false,
  generatingContext: 'initial', // 'initial', 'reroll', 'continue'
  draftLoaded: false,
};

// Track timeouts and abort controllers for cleanup
let streamTimeout: ReturnType<typeof setTimeout> | null = null;
let abortController: AbortController | null = null;

// Backup used to restore the current page if a re-roll is cancelled or fails
let _rerollBackup: any = null;

// Keyword-to-tag affinity map used for fallback ref image selection when embeddings are unavailable
const TAG_KEYWORDS = {
  'front-view': ['front', 'facing', 'standing', 'full body', 'looking at'],
  'side-view': ['profile', 'side view', 'side-on', 'looking away'],
  'back-view': ['behind', 'back view', 'from behind', 'walking away', 'rear'],
  'close-up': ['close-up', 'closeup', 'face', 'portrait', 'headshot', 'expression', 'eyes'],
  'action-pose': [
    'doing',
    'performing',
    'reaching',
    'picking up',
    'working',
    'walking',
    'moving',
    'gesturing',
    'carrying',
    'running',
    'jumping',
    'sitting',
    'turning',
    'action',
    'activity',
    'task',
    'mid-action',
  ],
  'alternate-outfit': ['casual', 'civilian', 'disguise', 'formal', 'armor', 'costume change'],
  expression: ['angry', 'sad', 'happy', 'shocked', 'scared', 'crying', 'laughing', 'smiling'],
  'character-sheet': [
    'character sheet',
    'turnaround',
    'model sheet',
    'reference sheet',
    'multiple angles',
    'multiple poses',
    'multi-angle',
    'multi-pose',
    'full rotation',
    '360',
    'orthographic',
  ],
  'character-in-world': [
    'in the world',
    'in the city',
    'in the setting',
    'environment',
    'landscape',
    'outdoors',
    'indoors',
    'location',
  ],
};

async function render(param?: string | null): Promise<string> {
  // Always honour active state — must come BEFORE param checks so that
  // App.refreshPage() during re-roll/generation of a resumed comic does not
  // re-invoke renderResume() and reset isGenerating / step.
  if (state.step === 'generating') return renderGenerating();
  if (state.step === 'reading' && (!param || param.length <= 10 || param === state.comicId)) {
    return renderReading();
  }

  // If param is a genre id, pre-select it
  if (param && GENRES.find((g) => g.id === param)) {
    state.genre = param;
  }
  // If param is a comic id, resume that comic
  if (param && param.length > 10) {
    return await renderResume(param);
  }

  // Fresh setup path: restore draft / active comic from DB if not yet loaded
  if (!state.draftLoaded) {
    await restoreDraftOrActive();
  }
  if (state.step === 'reading') return renderReading();
  return renderSetup();
}

async function renderSetup() {
  const characters = await DB.getAll(DB.STORES.characters);
  const worlds = await DB.getAll(DB.STORES.worlds);
  const presets = dedupeByNameLatest(await DB.getAll(DB.STORES.presets));
  const imagePresets = dedupeByNameLatest(await DB.getAll(DB.STORES.imagePresets));
  const hasDraft =
    state.genre ||
    state.title ||
    state.storyPrompt ||
    state.selectedCharacters?.length > 0 ||
    state.selectedWorld ||
    state.selectedPreset ||
    state.selectedImagePreset;

  return `
    <div class="slide-up">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 class="section-title" style="margin:0;">Create New Comic</h2>
        ${hasDraft ? `<button class="btn btn-sm btn-secondary" onclick="CreatePage.resetSetup()" title="Clear all setup and start fresh">&#x1F5D1; New Comic</button>` : ''}
      </div>

      <!-- Step 1: Genre -->
      <div class="card">
        <h3 class="card-title mb-sm">1. Choose Genre</h3>
        <div class="genre-grid" id="genre-grid">
          ${GENRES.map(
            (g) => `
            <div class="genre-card ${state.genre === g.id ? 'active' : ''}" data-genre="${g.id}" onclick="CreatePage.selectGenre('${g.id}')">
              <span class="genre-emoji">${g.emoji}</span>
              ${g.name}
            </div>
          `,
          ).join('')}
        </div>
        ${
          state.genre === 'custom'
            ? `
          <div class="form-group mt-sm">
            <input type="text" id="custom-genre" value="${escHtml(state.customGenre)}" placeholder="Enter your custom genre..." onchange="CreatePage.setCustomGenre(this.value)">
          </div>
        `
            : ''
        }
      </div>

      <!-- Step 2: Characters -->
      <div class="card">
        <h3 class="card-title mb-sm">2. Select Characters</h3>
        ${
          characters.length === 0
            ? `
          <p class="text-sm text-muted mb-sm">No characters created yet.</p>
          <button class="btn btn-sm btn-secondary" onclick="App.navigate('characters', 'new')">Create Character</button>
        `
            : `
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${characters
              .map(
                (c) => `
              <div class="chip ${state.selectedCharacters.includes(c.id) ? 'active' : ''}" onclick="CreatePage.toggleCharacter('${c.id}')">
                ${escHtml(c.name)}
              </div>
            `,
              )
              .join('')}
          </div>
        `
        }
      </div>

      <!-- Step 3: World -->
      <div class="card">
        <h3 class="card-title mb-sm">3. Select World (optional)</h3>
        ${
          worlds.length === 0
            ? `
          <p class="text-sm text-muted mb-sm">No worlds created yet.</p>
          <button class="btn btn-sm btn-secondary" onclick="App.navigate('worlds', 'new')">Create World</button>
        `
            : `
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            <div class="chip ${!state.selectedWorld ? 'active' : ''}" onclick="CreatePage.selectWorld(null)">None</div>
            ${worlds
              .map(
                (w) => `
              <div class="chip ${state.selectedWorld === w.id ? 'active' : ''}" onclick="CreatePage.selectWorld('${w.id}')">
                ${escHtml(w.name)}
              </div>
            `,
              )
              .join('')}
          </div>
        `
        }
      </div>

      <!-- Step 4: Preset -->
      <div class="card">
        <h3 class="card-title mb-sm">4. Prompt Preset (optional)</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <div class="chip ${!state.selectedPreset ? 'active' : ''}" onclick="CreatePage.selectPreset(null)">Default</div>
          ${presets
            .map(
              (p) => `
            <div class="chip ${state.selectedPreset === p.id ? 'active' : ''}" onclick="CreatePage.selectPreset('${p.id}')">
              ${escHtml(p.name)}
            </div>
          `,
            )
            .join('')}
        </div>
      </div>

      <!-- Step 5: Image Style Preset -->
      <div class="card">
        <h3 class="card-title mb-sm">5. Image Style Preset (optional)</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <div class="chip ${!state.selectedImagePreset ? 'active' : ''}" onclick="CreatePage.selectImagePreset(null)">Default</div>
          ${imagePresets
            .map(
              (p) => `
            <div class="chip ${state.selectedImagePreset === p.id ? 'active' : ''}" onclick="CreatePage.selectImagePreset('${p.id}')">
              ${escHtml(p.name)}
            </div>
          `,
            )
            .join('')}
        </div>
        <div class="form-hint" style="margin-top:8px;">
          <a href="#" onclick="event.preventDefault();App.navigate('image-presets')">Manage image style presets</a>
        </div>
      </div>

      <!-- Step 6: Story Setup -->
      <div class="card">
        <h3 class="card-title mb-sm">6. Story Setup</h3>
        <div class="form-group">
          <label class="form-label">Comic Title</label>
          <input type="text" id="comic-title" value="${escHtml(state.title)}" placeholder="e.g. The Last Guardian" oninput="CreatePage.setTitle(this.value)">
        </div>
        <div class="form-group">
          <label class="form-label">Opening Prompt</label>
          <textarea id="story-prompt" rows="4" placeholder="Describe how you want the story to begin... (Leave blank for AI to decide)" oninput="CreatePage.setStoryPrompt(this.value)">${escHtml(state.storyPrompt)}</textarea>
          <div class="form-hint">Be specific or leave blank for a surprise</div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" onclick="CreatePage.startGenerating()" ${!state.genre ? 'disabled' : ''}>
        Generate First Page
      </button>
    </div>
  `;
}

function renderGenerating() {
  const contextMsg =
    state.generatingContext === 'reroll'
      ? 'Re-rolling page...'
      : state.generatingContext === 'continue'
        ? 'Continuing story...'
        : state.generatingContext === 'reimage'
          ? 'Regenerating images...'
          : 'Generating your comic page...';
  return `
    <div class="slide-up">
      <div class="loading-overlay" id="gen-loading">
        <div class="spinner"></div>
        <p id="gen-status-msg">${contextMsg}</p>
        <p class="text-sm text-muted">This may take a moment</p>
        <button class="btn btn-secondary btn-sm mt-sm" onclick="CreatePage.cancelGeneration()">Cancel</button>
      </div>
      <div id="gen-stream" class="hidden">
        <div class="card">
          <h3 class="card-title mb-sm" id="gen-stream-title">Writing story...</h3>
          <div class="streaming-text" id="stream-output"></div>
          <button class="btn btn-secondary btn-sm mt-sm" onclick="CreatePage.cancelGeneration()">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderReading() {
  const pages = state.pages;
  const currentPage = pages[pages.length - 1];
  const canUndo = pages.length > 1;

  return `
    <div class="slide-up">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 class="section-title" style="margin:0;">${escHtml(state.title || 'Untitled Comic')}</h2>
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="text-sm text-muted">Page ${pages.length}</span>
          <button class="btn btn-sm btn-secondary" onclick="CreatePage.rerollPage()" ${state.isGenerating ? 'disabled' : ''} title="Regenerate this page with different content">&#x1F3B2; Re-roll</button>
          <button class="btn btn-sm btn-secondary" onclick="CreatePage.rerollImages()" ${state.isGenerating ? 'disabled' : ''} title="Regenerate images only — keep the story text">&#x1F5BC; Re-images</button>
          ${canUndo ? `<button class="btn btn-sm btn-secondary" onclick="CreatePage.undoChoice()" ${state.isGenerating ? 'disabled' : ''} title="Go back to previous choice">&#x21A9; Undo</button>` : ''}
        </div>
      </div>

      <!-- Render current page panels -->
      <div class="comic-page${currentPage?.panels?.length >= 3 ? ' layout-grid' : ''}" id="comic-display">
        ${currentPage ? renderComicPage(currentPage) : '<p class="text-muted text-center">No content yet</p>'}
      </div>

      <!-- Choices -->
      ${
        currentPage && currentPage.choices && currentPage.choices.length > 0
          ? `
        <div class="card">
          <h3 class="card-title mb-sm">What happens next?</h3>
          <div class="choices-container">
            ${currentPage.choices
              .map(
                (choice, i) => `
              <button class="choice-btn" onclick="CreatePage.makeChoice(${i})" ${state.isGenerating ? 'disabled' : ''}>
                <strong>Option ${i + 1}:</strong> ${escHtml(choice.text)}
              </button>
            `,
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }

      ${state.plannerMode && state.visualContinuity ? renderContinuityPanel(currentPage) : ''}

      <!-- Custom continuation -->
      <div class="card">
        <div class="form-group">
          <label class="form-label">Custom Direction (optional)</label>
          <textarea id="custom-direction" rows="2" placeholder="Write your own direction for the next page..."></textarea>
        </div>
        <div class="btn-group">
          <button class="btn btn-primary" onclick="CreatePage.continueStory()" ${state.isGenerating ? 'disabled' : ''}>
            ${state.isGenerating ? 'Generating...' : 'Continue Story'}
          </button>
          <button class="btn btn-secondary" onclick="CreatePage.finishComic()">Finish Comic</button>
        </div>
      </div>

      <!-- Page History -->
      ${
        pages.length > 1
          ? `
        <div class="card">
          <div class="collapsible-header collapsed" onclick="CreatePage.toggleAdvanced(this)">
            <h3 class="card-title" style="margin:0;">Previous Pages (${pages.length - 1})</h3>
          </div>
          <div class="collapsible-body collapsed">
            ${pages
              .slice(0, -1)
              .map(
                (p, i) => `
              <div style="border-bottom:1px solid var(--border);padding:12px 0;">
                <div class="text-sm" style="font-weight:600;">Page ${i + 1}: ${escHtml(p.title || '')}</div>
                <div class="text-sm text-muted mt-sm">${p.panels ? p.panels.length : 0} panels</div>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }
    </div>
  `;
}

function renderComicPage(page: any): string {
  if (!page || !page.panels) return '<p class="text-muted">Empty page</p>';

  return page.panels
    .map(
      (panel, i) => `
    <div class="comic-panel">
      ${
        panel.imageUrl
          ? `<img src="${panel.imageUrl}" alt="Panel ${i + 1}" loading="lazy" class="zoomable-panel" style="cursor:zoom-in;" onclick="CreatePage.zoomPanel(${i})">`
          : panel.generationError
            ? `<div class="panel-gen-error"><strong>&#9888; Image not generated</strong><br>${escHtml(panel.generationError)}</div>`
            : panel.imagePrompt
              ? `<div style="background:linear-gradient(135deg,#1a1a3e,#2a1a4e);padding:20px;min-height:180px;display:flex;align-items:center;justify-content:center;"><p class="text-sm text-muted text-center" style="font-style:italic;">${escHtml(panel.imagePrompt).slice(0, 150)}...</p></div>`
              : ''
      }
      ${panel.narration ? `<div class="comic-narration">${escHtml(panel.narration)}</div>` : ''}
      ${(panel.dialogue || [])
        .map(
          (d) => `
        <div class="comic-dialogue">
          <div class="speaker-name">${escHtml(d.speaker)}</div>
          <div>${escHtml(d.text)}</div>
        </div>
      `,
        )
        .join('')}
    </div>
  `,
    )
    .join('');
}

/**
 * Compact continuity panel: shows each character's current mutable visual
 * state (editable before the next page) plus the current page's generation
 * details — model, strategy, resolution, reference count, and state changes.
 */
function renderContinuityPanel(currentPage: any): string {
  const states = state.visualContinuity?.characterStates || {};
  const charRows = state.characters
    .map((c) => {
      const s = states[c.id];
      if (!s) return '';
      return `
        <div class="continuity-char" data-charid="${c.id}">
          <div class="continuity-char-name">${escHtml(c.name)}</div>
          <div class="form-group" style="margin-bottom:6px;">
            <label class="form-label text-sm">Wardrobe</label>
            <input type="text" class="continuity-field" data-charid="${c.id}" data-field="wardrobeDescription"
              value="${escHtml(s.wardrobeDescription)}" placeholder="Use identity-anchor outfit">
          </div>
          <div class="form-group" style="margin-bottom:6px;">
            <label class="form-label text-sm">Hair</label>
            <input type="text" class="continuity-field" data-charid="${c.id}" data-field="hairState"
              value="${escHtml(s.hairState)}" placeholder="As shown in identity anchor">
          </div>
          <div class="form-group" style="margin-bottom:6px;">
            <label class="form-label text-sm">Carried items / Injuries / Temporary changes (comma-separated)</label>
            <input type="text" class="continuity-field" data-charid="${c.id}" data-field="carriedItems"
              value="${escHtml(s.carriedItems.join(', '))}" placeholder="Carried items">
            <input type="text" class="continuity-field mt-sm" data-charid="${c.id}" data-field="injuries"
              value="${escHtml(s.injuries.join(', '))}" placeholder="Injuries">
            <input type="text" class="continuity-field mt-sm" data-charid="${c.id}" data-field="temporaryChanges"
              value="${escHtml(s.temporaryChanges.join(', '))}" placeholder="Temporary changes">
          </div>
        </div>`;
    })
    .join('');

  const gen = currentPage?.generation;
  const notes = [...(currentPage?.generationWarnings || []), ...(currentPage?.validationErrors || [])];
  const genDetails = gen
    ? `<div class="continuity-gen-details text-sm text-muted">
        <strong>Last page:</strong> ${gen.strategy === 'sequential-page' ? 'one sequential request' : 'independent panel requests'}
        &middot; model ${escHtml(gen.modelId)}${gen.singleImageModelId && gen.singleImageModelId !== gen.modelId ? ` (panels via ${escHtml(gen.singleImageModelId)})` : ''}
        &middot; ${escHtml(gen.resolution)}
        &middot; ${gen.referenceManifest?.length ?? 0} reference${(gen.referenceManifest?.length ?? 0) === 1 ? '' : 's'}
        ${notes.length ? `<div class="continuity-notes">${notes.map((n) => `&#9888; ${escHtml(n)}`).join('<br>')}</div>` : ''}
      </div>`
    : '';

  return `
    <div class="card">
      <div class="collapsible-header collapsed" onclick="CreatePage.toggleAdvanced(this)">
        <h3 class="card-title" style="margin:0;">Continuity</h3>
      </div>
      <div class="collapsible-body collapsed">
        <p class="text-sm text-muted">Current visual state used for the next page. Edit to correct clothing or details before continuing.</p>
        ${charRows}
        <button class="btn btn-secondary btn-sm" onclick="CreatePage.saveContinuityEdits()">Apply State Edits</button>
        ${genDetails}
      </div>
    </div>`;
}

/** Persist user edits from the continuity panel into the comic's ledger. */
async function saveContinuityEdits() {
  if (!state.visualContinuity) return;
  const fields = document.querySelectorAll('.continuity-field');
  const editsByChar = {};
  fields.forEach((el) => {
    const charId = el.dataset.charid;
    const field = el.dataset.field;
    if (!charId || !field) return;
    editsByChar[charId] = editsByChar[charId] || {};
    if (field === 'wardrobeDescription' || field === 'hairState') {
      editsByChar[charId][field] = el.value.trim() || null;
    } else {
      const items = el.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      editsByChar[charId][field] = items;
    }
  });

  let changed = false;
  for (const [charId, set] of Object.entries(editsByChar)) {
    const current = state.visualContinuity.characterStates[charId];
    if (!current) continue;
    const next = applyVisualStateChange(current, set);
    if (next !== current) {
      state.visualContinuity.characterStates[charId] = next;
      changed = true;
    }
  }
  if (!changed) return App.toast('No state changes to apply', 'info');

  state.visualContinuity.updatedAt = Date.now();
  const comic = await DB.get(DB.STORES.comics, state.comicId).catch(() => null);
  if (comic) {
    comic.visualContinuity = state.visualContinuity;
    comic.updatedAt = Date.now();
    await DB.put(DB.STORES.comics, comic);
  }
  App.toast('Visual state updated — applies from the next page', 'success');
}

async function renderResume(comicId: string): Promise<string> {
  const comic = await DB.get(DB.STORES.comics, comicId);
  if (!comic) return '<p class="text-muted">Comic not found</p>';

  const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', comicId);
  pages.sort((a, b) => a.pageNum - b.pageNum);

  state.comicId = comicId;
  state.title = comic.title;
  state.genre = comic.genre;
  state.selectedCharacters = comic.characterIds || [];
  state.selectedWorld = comic.worldId || null;
  state.selectedPreset = comic.presetId || null;
  state.selectedImagePreset = comic.imagePresetId || null;
  state.pages = pages.map((p) => p.data);
  state.pageIds = pages.map((p) => p.id); // restore ids for re-roll/undo
  state.conversationHistory = comic.conversationHistory || [];
  state.step = 'reading';
  state.isGenerating = false;
  state.plannerMode = comic.plannerMode === true;
  state.visualContinuity = comic.visualContinuity || null;

  // Restore character data and reference images for continued generation
  state.characters = [];
  for (const cid of state.selectedCharacters) {
    const c = await DB.get(DB.STORES.characters, cid);
    if (c) state.characters.push(DB.normalizeCharacterRecord(c).record);
  }
  state.world = null;
  if (state.selectedWorld) {
    const worldRec = await DB.get(DB.STORES.worlds, state.selectedWorld);
    if (worldRec) state.world = DB.normalizeWorldRecord(worldRec).record;
  }
  // Anchored comics that predate the ledger get one initialized from current
  // character defaults; the user can review/edit it before the next page.
  if (state.plannerMode && !state.visualContinuity) {
    state.visualContinuity = initializeContinuity(state.characters);
    comic.visualContinuity = state.visualContinuity;
    await DB.put(DB.STORES.comics, comic);
  }

  const useRefImages = await DB.getSetting('useRefImages', true);
  const refImages = [];
  const charImagesByName = {};
  if (useRefImages) {
    for (const c of state.characters) {
      const migrated = DB.migrateCharacter(c);
      const images = migrated.images || [];
      if (images.length > 0) {
        charImagesByName[c.name] = { images, primaryImageIndex: migrated.primaryImageIndex ?? 0 };
        // Also add primary image to legacy refImages for backward compat
        const primary = images[migrated.primaryImageIndex ?? 0] || images[0];
        if (primary?.dataUrl) refImages.push({ dataUrl: primary.dataUrl, label: c.name, type: 'character' });
      }
    }
    if (state.selectedWorld) {
      const world = await DB.get(DB.STORES.worlds, state.selectedWorld);
      if (world) {
        const migratedWorld = DB.migrateWorld(world);
        for (const img of migratedWorld.images || []) {
          if (img?.dataUrl)
            refImages.push({
              dataUrl: img.dataUrl,
              label: world.name,
              tag: img.tag || '',
              description: img.description || '',
              type: 'world',
            });
        }
      }
    }
  }
  state.referenceImages = refImages;
  state.characterImagesByName = charImagesByName;

  return renderReading();
}

// --- User Actions ---

function setTitle(value: string): void {
  state.title = value;
  scheduleDraftSave();
}

function setStoryPrompt(value: string): void {
  state.storyPrompt = value;
  scheduleDraftSave();
}

// Debounce timer for draft saves triggered by text input
let draftSaveTimer = null;
function scheduleDraftSave() {
  if (state.step !== 'setup') return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => saveDraft().catch(() => {}), 400);
}

async function saveDraft() {
  await DB.setSetting('createSetupDraft', {
    genre: state.genre,
    customGenre: state.customGenre,
    selectedCharacters: state.selectedCharacters,
    selectedWorld: state.selectedWorld,
    selectedPreset: state.selectedPreset,
    selectedImagePreset: state.selectedImagePreset,
    title: state.title,
    storyPrompt: state.storyPrompt,
  });
}

async function restoreDraftOrActive() {
  state.draftLoaded = true;
  // Try to resume an in-progress (unfinished) comic first
  const activeId = await DB.getSetting('createActiveComicId', null);
  if (activeId) {
    const comic = await DB.get(DB.STORES.comics, activeId);
    if (comic && !comic.finished) {
      // renderResume sets state.step = 'reading'; render() checks this after we return
      await renderResume(activeId);
      return;
    }
    // Comic no longer valid — clear the stored id
    await DB.setSetting('createActiveComicId', null);
  }
  // Otherwise restore setup draft
  const draft = await DB.getSetting('createSetupDraft', null);
  if (draft) {
    state.genre = draft.genre || '';
    state.customGenre = draft.customGenre || '';
    state.selectedCharacters = Array.isArray(draft.selectedCharacters) ? draft.selectedCharacters : [];
    state.selectedWorld = draft.selectedWorld || null;
    state.selectedPreset = draft.selectedPreset || null;
    state.selectedImagePreset = draft.selectedImagePreset || null;
    state.title = draft.title || '';
    state.storyPrompt = draft.storyPrompt || '';
  }
}

async function resetSetup() {
  state.genre = '';
  state.customGenre = '';
  state.selectedCharacters = [];
  state.selectedWorld = null;
  state.selectedPreset = null;
  state.selectedImagePreset = null;
  state.title = '';
  state.storyPrompt = '';
  state.draftLoaded = true; // mark as loaded so we don't re-load old draft
  await DB.setSetting('createSetupDraft', null);
  App.refreshPage();
}

function selectGenre(id: string): void {
  state.genre = id;
  document.querySelectorAll('.genre-card').forEach((el) => {
    el.classList.toggle('active', el.dataset.genre === id);
  });
  scheduleDraftSave();
  // Show/hide custom input
  if (id === 'custom') {
    App.refreshPage();
  }
}

function setCustomGenre(value: string): void {
  state.customGenre = value;
  scheduleDraftSave();
}

function toggleCharacter(id: string): void {
  const idx = state.selectedCharacters.indexOf(id);
  if (idx >= 0) state.selectedCharacters.splice(idx, 1);
  else state.selectedCharacters.push(id);
  scheduleDraftSave();
  App.refreshPage();
}

function selectWorld(id: string): void {
  state.selectedWorld = id;
  scheduleDraftSave();
  App.refreshPage();
}

function selectPreset(id: string): void {
  state.selectedPreset = id;
  scheduleDraftSave();
  App.refreshPage();
}

function selectImagePreset(id: string): void {
  state.selectedImagePreset = id;
  scheduleDraftSave();
  App.refreshPage();
}

function toggleAdvanced(el: any): void {
  el.classList.toggle('collapsed');
  const body = el.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
}

async function startGenerating() {
  if (!state.genre) return App.toast('Select a genre first', 'error');

  const apiKey = await API.getApiKey();
  if (!apiKey) return App.toast('Set your API key in Settings first', 'error');

  state.title = document.getElementById('comic-title')?.value?.trim() || 'Untitled Comic';
  state.storyPrompt = document.getElementById('story-prompt')?.value?.trim() || '';

  // Persist setup settings so they can be restored when creating the next comic.
  // The draft is only cleared when the user explicitly clicks "New Comic".
  await saveDraft();

  // Build context — normalize records so every image has a stable ID and an
  // explicit anchor before generation. Persist newly assigned IDs immediately
  // so anchors stay stable across sessions (covers imported/legacy records).
  const characters = [];
  for (const cid of state.selectedCharacters) {
    const c = await DB.get(DB.STORES.characters, cid);
    if (!c) continue;
    const { record, changed } = DB.normalizeCharacterRecord(c);
    if (changed) await DB.put(DB.STORES.characters, record);
    characters.push(record);
  }
  state.characters = characters;
  let world = null;
  if (state.selectedWorld) {
    const worldRec = await DB.get(DB.STORES.worlds, state.selectedWorld);
    if (worldRec) {
      const { record, changed } = DB.normalizeWorldRecord(worldRec);
      if (changed) await DB.put(DB.STORES.worlds, record);
      world = record;
    }
  }
  state.world = world;

  // Collect reference images for image-to-image generation
  const useRefImages = await DB.getSetting('useRefImages', true);
  const refImages = [];
  const charImagesByName = {};
  if (useRefImages) {
    for (const c of characters) {
      const migrated = DB.migrateCharacter(c);
      const images = migrated.images || [];
      if (images.length > 0) {
        charImagesByName[c.name] = { images, primaryImageIndex: migrated.primaryImageIndex ?? 0 };
        const primary = images[migrated.primaryImageIndex ?? 0] || images[0];
        if (primary?.dataUrl) refImages.push({ dataUrl: primary.dataUrl, label: c.name, type: 'character' });
      }
    }
    if (world) {
      const migratedWorld = DB.migrateWorld(world);
      for (const img of migratedWorld.images || []) {
        if (img?.dataUrl)
          refImages.push({
            dataUrl: img.dataUrl,
            label: world.name,
            tag: img.tag || '',
            description: img.description || '',
            type: 'world',
          });
      }
    }
  }
  state.referenceImages = refImages;
  state.characterImagesByName = charImagesByName;

  let presetData = null;
  if (state.selectedPreset) {
    presetData = await DB.get(DB.STORES.presets, state.selectedPreset);
  }

  const genreName =
    state.genre === 'custom'
      ? state.customGenre || 'Custom'
      : GENRES.find((g) => g.id === state.genre)?.name || state.genre;

  // Fetch available image sizes for dynamic per-panel sizing
  const dynamicImageSizes = await DB.getSetting('dynamicImageSizes', false);
  const includeAppearanceText = await DB.getSetting('includeAppearanceText', true);
  let systemPromptOpts = { includeAppearanceText };
  if (dynamicImageSizes) {
    const imageModel = await DB.getSetting('imageModel', 'gpt-image-1');
    const sizes = await API.getModelSizes(imageModel);
    if (sizes && sizes.length > 1) systemPromptOpts.imageSizes = sizes;
  }

  // Pass the selected image style preset to the system prompt so the LLM
  // uses the correct art style in imagePrompt fields instead of a hardcoded default.
  if (state.selectedImagePreset) {
    const imagePresetData = await DB.get(DB.STORES.imagePresets, state.selectedImagePreset);
    if (imagePresetData?.promptPrefix) {
      systemPromptOpts.imageStylePreset = imagePresetData.promptPrefix;
    }
  }

  // Structured planner + anchored continuity pipeline (default). The legacy
  // free-prose imagePrompt pipeline remains as a compatibility path.
  state.plannerMode = await DB.getSetting('useStructuredPlanner', true);

  let systemPrompt;
  if (state.plannerMode) {
    const locationKeys = (world?.images || []).map((img) => img?.locationKey).filter(Boolean);
    systemPrompt = API.buildPlannerSystemPrompt({
      genreName,
      characters: characters.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        description: c.description,
        powers: c.powers,
      })),
      world: world
        ? { name: world.name, description: world.description, details: world.details, atmosphere: world.atmosphere }
        : null,
      locationKeys: [...new Set(locationKeys)],
      customSystemPrompt: presetData?.systemPrompt || null,
    });
    state.visualContinuity = initializeContinuity(characters);
  } else {
    state.visualContinuity = null;
    systemPrompt = API.buildSystemPrompt(
      genreName,
      characters,
      world,
      presetData?.systemPrompt || null,
      systemPromptOpts,
    );
  }

  const userMessage = state.storyPrompt
    ? `Create the first page of a ${genreName} comic titled "${state.title}". Opening scene: ${state.storyPrompt}`
    : `Create the first page of a ${genreName} comic titled "${state.title}". Begin with an engaging opening scene.`;

  state.conversationHistory = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  // Create comic in DB
  state.comicId = DB.uuid();
  const comic = {
    id: state.comicId,
    title: state.title,
    genre: state.genre,
    genreName,
    characterIds: state.selectedCharacters,
    worldId: state.selectedWorld,
    presetId: state.selectedPreset,
    imagePresetId: state.selectedImagePreset,
    pageCount: 0,
    conversationHistory: state.conversationHistory,
    plannerMode: state.plannerMode,
    visualContinuity: state.visualContinuity,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await DB.put(DB.STORES.comics, comic);

  state.pages = [];
  state.step = 'generating';
  state.isGenerating = true;
  state.generatingContext = 'initial';
  await App.refreshPage();

  // Generate
  await generatePage(presetData);
}

/**
 * Trim conversation history to prevent payload overflow.
 * Keeps system prompt, first user message, and the most recent exchanges.
 */
function trimConversationHistory(maxExchanges: number): void {
  if (state.conversationHistory.length <= 2 + maxExchanges * 2) return;
  const system = state.conversationHistory[0];
  const firstUser = state.conversationHistory[1];
  const recent = state.conversationHistory.slice(-(maxExchanges * 2));
  state.conversationHistory = [system, firstUser, ...recent];
}

/**
 * Generate images for all panels in pageData that have an imagePrompt.
 * Reads settings and state internally; updates panel.imageUrl in place.
 * @param {Object} pageData - page object with panels array
 * @param {HTMLElement|null} uiMsg   - optional element for status message updates
 */
async function generatePanelImages(pageData: any, uiMsg: string): Promise<void> {
  const imageResolution = await DB.getSetting('imageSize', '1024x1024');
  const dynamicSizesEnabled = await DB.getSetting('dynamicImageSizes', false);
  const includeAppearance = await DB.getSetting('includeAppearanceText', true);
  const imagePresetData = state.selectedImagePreset
    ? await DB.get(DB.STORES.imagePresets, state.selectedImagePreset)
    : null;
  const imagePromptPrefix = imagePresetData?.promptPrefix || (await DB.getSetting('imagePromptPrefix', ''));
  const charRefMode = await DB.getSetting('charRefMode', 'auto');
  const maxRefImages = await DB.getSetting('maxRefImages', 4);
  const enrichEnabled = await DB.getSetting('enrichImagePrompts', false);
  const negativePrompt = await DB.getSetting('negativePrompt', '');

  // Normalize world refs (plain strings and labeled objects)
  const worldRefs = state.referenceImages
    .map((item) => (typeof item === 'string' ? { dataUrl: item, label: '', type: 'world' } : item))
    .filter((r) => r.type === 'world');

  // Cache panel prompt embeddings within this page generation
  const promptEmbeddingCache = new Map();
  // Cache enriched prompts within this page generation to avoid duplicate LLM calls
  const promptEnrichmentCache = new Map();

  async function getPromptEmbedding(promptText) {
    if (!promptText) return null;
    if (promptEmbeddingCache.has(promptText)) return promptEmbeddingCache.get(promptText);
    const emb = await API.generateEmbedding(promptText).catch(() => null);
    promptEmbeddingCache.set(promptText, emb);
    return emb;
  }

  // Check if a character name appears in a panel prompt using word-boundary matching
  function nameInPrompt(name, text) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'i').test(text);
  }

  // Select the best image from a character's images[] using hybrid cascading strategy
  async function selectBestImage(charImages, panelPromptText, charName, primaryImageIndex) {
    const valid = (charImages || []).filter((img) => img && img.dataUrl);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];

    const panelLower = panelPromptText.toLowerCase();
    const promptSnippet = panelPromptText.slice(0, 80);

    // 1. Embedding-based selection (unless mode is 'keyword')
    if (charRefMode !== 'keyword') {
      const withEmb = valid.filter((img) => img.embedding?.length);
      if (withEmb.length > 0) {
        const panelEmb = await getPromptEmbedding(panelPromptText);
        if (panelEmb) {
          let best = withEmb[0];
          let bestScore = cosineSimilarity(panelEmb, withEmb[0].embedding);
          for (let i = 1; i < withEmb.length; i++) {
            const score = cosineSimilarity(panelEmb, withEmb[i].embedding);
            if (score > bestScore) {
              bestScore = score;
              best = withEmb[i];
            }
          }
          return best;
        }
        // Embedding fetch failed — fall through to keyword
        App.logError(
          'selectBestImage',
          new Error('Embedding fallback'),
          `Embedding unavailable for panel prompt, falling back to keyword matching. Character: ${charName}, prompt: "${promptSnippet}..."`,
        );
      } else {
        // No stored embeddings — fall through to keyword
        App.logError(
          'selectBestImage',
          new Error('Embedding fallback'),
          `No stored embeddings for character "${charName}", falling back to keyword matching. Prompt: "${promptSnippet}..."`,
        );
      }
    }

    // 2. Keyword tag matching (unless mode is 'semantic')
    if (charRefMode !== 'semantic') {
      let bestScore = 0,
        bestImg = null;
      for (const img of valid) {
        const keywords = TAG_KEYWORDS[img.tag] || [];
        const score = keywords.filter((kw) => panelLower.includes(kw)).length;
        if (score > bestScore) {
          bestScore = score;
          bestImg = img;
        }
      }
      if (bestScore > 0 && bestImg) return bestImg;
      // No keyword match — fall through to primary
      App.logError(
        'selectBestImage',
        new Error('Keyword fallback'),
        `No keyword/tag match for character "${charName}", falling back to primary image. Prompt: "${promptSnippet}..."`,
      );
    }

    // 3. Fall back to primary image using configured primaryImageIndex
    const primaryIdx = typeof primaryImageIndex === 'number' ? primaryImageIndex : 0;
    const primary = (charImages || [])[primaryIdx];
    return primary && primary.dataUrl ? primary : valid[0];
  }

  // Build a composite character sheet canvas when multiple chars share budget
  async function buildCompositeSheet(charMatches) {
    const n = charMatches.length;
    if (n === 0) return null;

    const cellSize = 256;
    const cols = Math.min(n, 2);
    const rows = Math.ceil(n / cols);
    const canvas = document.createElement('canvas');
    canvas.width = cols * cellSize;
    canvas.height = rows * cellSize;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await Promise.all(
      charMatches.map(
        ({ name, img }, i) =>
          new Promise((resolve) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = col * cellSize;
            const y = row * cellSize;
            const drawLabel = () => {
              ctx.fillStyle = 'rgba(0,0,0,0.75)';
              ctx.fillRect(x, y + cellSize - 22, cellSize, 22);
              ctx.fillStyle = '#fff';
              ctx.font = '12px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(name, x + cellSize / 2, y + cellSize - 7);
            };
            const image = new Image();
            image.onload = () => {
              ctx.drawImage(image, x, y, cellSize, cellSize - 22);
              drawLabel();
              resolve();
            };
            image.onerror = () => {
              drawLabel();
              resolve();
            };
            image.src = img.dataUrl;
          }),
      ),
    );

    const posLabels = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    const legendParts = charMatches.map(({ name, img }, i) => {
      const pos = posLabels[i] || `section ${i + 1}`;
      const detail = img.description || (img.tag && img.tag !== 'default' ? img.tag : '');
      return `${pos}: ${name}${detail ? ` (${detail})` : ''}`;
    });
    const legend = `Character sheet grid. ${legendParts.join('. ')}. Match each character's appearance exactly as shown in their labeled section.`;
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), legend, isComposite: true };
  }

  // Build per-panel image options using hybrid cascading strategy
  async function buildPanelImageOpts(panel) {
    // Use AI-picked size when dynamic sizing is enabled and the AI provided a valid WxH value
    let resolution = imageResolution;
    if (dynamicSizesEnabled && panel.imageSize) {
      const trimmed = panel.imageSize.trim();
      if (/^\d+x\d+$/i.test(trimmed)) {
        resolution = trimmed.toLowerCase();
      }
    }
    const opts = { resolution };
    if (negativePrompt) opts.negativePrompt = negativePrompt;
    const charNamesInPanel = Object.keys(state.characterImagesByName).filter((name) =>
      nameInPrompt(name, panel.imagePrompt),
    );

    // Select best image per character in this panel
    const charMatches = [];
    for (const name of charNamesInPanel) {
      const charData = state.characterImagesByName[name] || {};
      const img = await selectBestImage(charData.images, panel.imagePrompt, name, charData.primaryImageIndex);
      if (img) charMatches.push({ name, img });
    }

    const totalRefs = charMatches.length + worldRefs.length;

    // Use composite sheet when mode is 'composite' or multiple chars exceed budget
    if (charMatches.length > 1 && (charRefMode === 'composite' || totalRefs > maxRefImages)) {
      const sheet = await buildCompositeSheet(charMatches);
      if (sheet) {
        const panelRefs = [
          {
            dataUrl: sheet.dataUrl,
            label: 'Composite character sheet',
            tag: '',
            description: sheet.legend,
            type: 'character',
          },
          ...worldRefs,
        ];
        opts.imageDataUrls = panelRefs.map((r) => r.dataUrl);
        opts.labeledRefs = panelRefs;
        return opts;
      }
    }

    // Build individual labeled refs
    const labeledCharRefs = charMatches.map(({ name, img }) => ({
      dataUrl: img.dataUrl,
      label: name,
      tag: img.tag || '',
      description: img.description || '',
      type: 'character',
    }));
    const panelRefs = [...labeledCharRefs, ...worldRefs];

    if (panelRefs.length === 1) {
      opts.imageDataUrl = panelRefs[0].dataUrl;
      opts.labeledRefs = panelRefs;
    } else if (panelRefs.length > 1) {
      opts.imageDataUrls = panelRefs.map((r) => r.dataUrl);
      opts.labeledRefs = panelRefs;
    }
    return opts;
  }

  // Build enhanced image prompt: sanitize narrative noise, prepend prefix, append
  // appearance text, and (when enrichment is enabled) expand via LLM.
  async function buildEnhancedImagePrompt(panel) {
    let prompt = sanitizeImagePrompt(panel.imagePrompt);
    // Only prepend the prefix if the LLM didn't already include it (the system
    // prompt now instructs the LLM to start imagePrompts with the preset text).
    if (imagePromptPrefix && !prompt.toLowerCase().startsWith(imagePromptPrefix.toLowerCase())) {
      prompt = `${imagePromptPrefix}, ${prompt}`;
    }
    if (includeAppearance) {
      const panelAppearances = state.characters
        .filter((c) => c.appearance && c.appearance.trim() && nameInPrompt(c.name, panel.imagePrompt))
        .map((c) => `${c.name}: ${c.appearance.trim()}`)
        .join('; ');
      if (panelAppearances) prompt = `${prompt}. Characters in scene: ${panelAppearances}`;
    }
    if (enrichEnabled) {
      // promptEnrichmentCache is scoped to this generatePanelImages() call and
      // cleared on each invocation, so enrichEnabled is stable for its lifetime.
      if (promptEnrichmentCache.has(prompt)) return promptEnrichmentCache.get(prompt);
      const genre = state.genre === 'custom' ? state.customGenre || '' : state.genre || '';
      const enriched = await API.enrichImagePrompt(prompt, { genre });
      promptEnrichmentCache.set(prompt, enriched);
      return enriched;
    }
    return prompt;
  }

  const panelsWithImages = pageData.panels.filter((p) => p.imagePrompt).length;
  let doneCount = 0;
  await Promise.all(
    pageData.panels.map(async (panel) => {
      if (!panel.imagePrompt) return;
      try {
        const panelOpts = await buildPanelImageOpts(panel);
        const enhancedPrompt = await buildEnhancedImagePrompt(panel);
        const imageData = await API.generateImage(enhancedPrompt, panelOpts);
        if (imageData) {
          if (imageData.startsWith('http')) {
            // URL response — try to fetch for offline storage
            try {
              const resp = await fetch(imageData);
              const blob = await resp.blob();
              panel.imageUrl = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              });
            } catch {
              panel.imageUrl = imageData; // fallback to direct URL
            }
          } else if (imageData.startsWith('data:')) {
            panel.imageUrl = imageData;
          } else {
            panel.imageUrl = `data:image/png;base64,${imageData}`;
          }
        }
      } catch (imgErr) {
        App.logError('Image generation (panel)', imgErr);
        App.toast(`Panel image failed: ${imgErr.message}`, 'error');
      }
      doneCount++;
      if (uiMsg) uiMsg.textContent = `Generating images (${doneCount} / ${panelsWithImages})...`;
    }),
  );
}

/** Convert an image API result (url or b64) to a persistent data URL when possible. */
async function imageResultToDataUrl(value: string, source: string): Promise<string> {
  if (!value) return '';
  if (source === 'b64_json' || (!value.startsWith('http') && !value.startsWith('data:'))) {
    return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
  }
  if (value.startsWith('data:')) return value;
  // Remote URLs may be signed and expire — persist as data URL before commit
  try {
    const resp = await fetch(value);
    const blob = await resp.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(value);
      reader.readAsDataURL(blob);
    });
  } catch {
    return value;
  }
}

/**
 * Cross-page continuity reference: the previous page's last panel that has a
 * locally stored image. Optional — omitted when it would displace an anchor.
 */
function getPreviousFrameRef() {
  for (let p = state.pages.length - 1; p >= 0; p--) {
    const page = state.pages[p];
    const panels = page?.panels || [];
    for (let i = panels.length - 1; i >= 0; i--) {
      const url = panels[i]?.imageUrl;
      if (url && url.startsWith('data:')) {
        return { dataUrl: url, sourcePageId: state.pageIds[p], sourcePanelIndex: i };
      }
    }
  }
  return null;
}

/** Panel cast IDs in stable comic selected-character order. */
function orderedPanelCast(panel) {
  const cast = new Set(collectPanelCast(panel));
  const ordered = state.selectedCharacters.filter((id) => cast.has(id));
  const extras = [...cast].filter((id) => !ordered.includes(id)).sort();
  return [...ordered, ...extras];
}

/**
 * Anchored-continuity image generation for a planned page.
 * Requires pageData.planned and pageData.renderStates (set by generatePage,
 * or reused verbatim for whole-page image regeneration). Chooses between one
 * sequential page request and independent panel requests from live model
 * metadata, compiles deterministic prompts, and records generation metadata.
 */
async function generateContinuityPageImages(pageData: any, statusMsg: any): Promise<void> {
  const planned = pageData.planned;
  const renderStates = pageData.renderStates || [];
  const panels = pageData.panels;
  const warnings = [];

  const modelId = (await DB.getSetting('imageModel', '')) || 'gpt-image-1';
  const meta = await API.getImageModelMeta(modelId);
  const sequentialEnabled = await DB.getSetting('enableSequentialPages', false);
  const refBudgetSetting = await DB.getSetting('refBudget', 'auto');
  const configuredCompanion = await DB.getSetting('singleImageModel', '');
  const singleImageModelId = configuredCompanion || modelId;
  const imageSize = await DB.getSetting('imageSize', '1024x1024');
  const negativePrompt = await DB.getSetting('negativePrompt', '');
  const useRefImages = await DB.getSetting('useRefImages', true);
  const imagePresetData = state.selectedImagePreset
    ? await DB.get(DB.STORES.imagePresets, state.selectedImagePreset)
    : null;
  const stylePreset = imagePresetData?.promptPrefix || (await DB.getSetting('imagePromptPrefix', ''));

  const byId = {};
  for (const c of state.characters) byId[c.id] = c;

  const budget = effectiveReferenceBudget(refBudgetSetting, meta?.maxInputImages);
  const previousFrame = useRefImages ? getPreviousFrameRef() : null;

  const emptyAlloc = { manifest: [], dataUrls: [], unanchoredCharacterIds: [], warnings: [] };

  // Page-wide reference union (sequential candidate)
  const pageCast = collectPageCast(planned, state.selectedCharacters);
  const pageAlloc = useRefImages
    ? allocateReferences({
        characterIds: pageCast,
        charactersById: byId,
        locationKeys: collectLocationKeys(planned.panels),
        world: state.world,
        budget,
        previousFrame,
      })
    : emptyAlloc;
  warnings.push(...pageAlloc.warnings);

  // Per-panel allocations (routing counts + independent fallback)
  const panelAllocs = planned.panels.map((panel) =>
    useRefImages
      ? allocateReferences({
          characterIds: orderedPanelCast(panel),
          charactersById: byId,
          locationKeys: panel.visual?.locationKey ? [panel.visual.locationKey] : [],
          world: state.world,
          budget,
          previousFrame: null,
        })
      : emptyAlloc,
  );

  const sizeValid = !Array.isArray(meta?.sizes) || meta.sizes.length === 0 || meta.sizes.includes(imageSize);
  if (!sizeValid) {
    warnings.push(`Size ${imageSize} is not in ${modelId}'s supported resolution list — sequential batching skipped`);
  }

  const plan = resolveImageGenerationPlan({
    modelId,
    modelMeta: meta ? { maxInputImages: budget, maxOutputImages: meta.maxOutputImages, sizes: meta.sizes } : null,
    imagePanelCount: planned.panels.length,
    pageReferenceCount: pageAlloc.error ? pageAlloc.error.required : pageAlloc.manifest.length,
    panelReferenceCounts: panelAllocs.map((a) => (a.error ? a.error.required : a.manifest.length)),
    requestedSizes: [imageSize],
    sequentialEnabled: sequentialEnabled && sizeValid,
  });
  warnings.push(...plan.reasons.filter((r) => r !== 'Sequential page request'));

  const compiledPrompts = [];

  if (plan.strategy === 'sequential-page' && !pageAlloc.error) {
    // One ordered request for the whole page; data[i] maps ONLY to IMAGE i+1
    const prompt = compileSequentialPagePrompt({
      panels: planned.panels,
      renderStates,
      manifest: pageAlloc.manifest,
      charactersById: byId,
      stylePreset,
    });
    compiledPrompts.push(prompt);
    planned.panels.forEach((panel, i) => {
      panels[i].imagePrompt = compilePanelDescription({
        panel,
        renderState: renderStates[i] || {},
        manifest: pageAlloc.manifest,
        charactersById: byId,
      });
    });
    if (statusMsg) statusMsg.textContent = `Generating ${planned.panels.length} panel images in one sequence...`;

    const genOpts = {
      count: planned.panels.length,
      model: modelId,
      resolution: imageSize,
      exactReferences: true,
      refMaxDimension: 2048,
      signal: abortController?.signal,
    };
    if (pageAlloc.dataUrls.length > 0) genOpts.imageDataUrls = pageAlloc.dataUrls;
    if (negativePrompt) genOpts.negativePrompt = negativePrompt;

    const results = await API.generateImages(prompt, genOpts);
    for (const r of results) {
      const url = await imageResultToDataUrl(r.value, r.source);
      if (url && panels[r.index]) panels[r.index].imageUrl = url;
    }
    if (results.length < planned.panels.length) {
      warnings.push(
        `Model returned ${results.length} of ${planned.panels.length} images — missing panels were left empty`,
      );
      App.toast(`Only ${results.length} of ${planned.panels.length} panel images were returned`, 'error');
    }
  } else {
    // Independent panel requests with the same compiled state semantics
    const blocked = new Set(plan.blockedPanels.map((b) => b.panelIndex));
    const prompts = planned.panels.map((panel, i) => {
      const alloc = panelAllocs[i];
      if (alloc.error || blocked.has(i)) return null;
      return compileIndependentPanelPrompt({
        panel,
        renderState: renderStates[i] || {},
        manifest: alloc.manifest,
        charactersById: byId,
        stylePreset,
      });
    });
    prompts.forEach((p, i) => {
      if (p) {
        compiledPrompts.push(p);
        panels[i].imagePrompt = compilePanelDescription({
          panel: planned.panels[i],
          renderState: renderStates[i] || {},
          manifest: panelAllocs[i].manifest,
          charactersById: byId,
        });
      }
    });

    let done = 0;
    const total = prompts.filter(Boolean).length;
    if (statusMsg) statusMsg.textContent = `Generating images (0 / ${total})...`;
    await Promise.all(
      planned.panels.map(async (panel, i) => {
        const alloc = panelAllocs[i];
        if (alloc.error) {
          // Never silently drop a required anchor — leave the panel empty with the exact conflict
          panels[i].generationError = alloc.error.detail;
          warnings.push(`Panel ${i + 1}: ${alloc.error.detail}`);
          return;
        }
        const prompt = prompts[i];
        if (!prompt) return;
        try {
          const genOpts = {
            count: 1,
            model: singleImageModelId,
            resolution: imageSize,
            exactReferences: true,
            refMaxDimension: 2048,
            signal: abortController?.signal,
          };
          if (alloc.dataUrls.length > 0) genOpts.imageDataUrls = alloc.dataUrls;
          if (negativePrompt) genOpts.negativePrompt = negativePrompt;
          const results = await API.generateImages(prompt, genOpts);
          const url = await imageResultToDataUrl(results[0].value, results[0].source);
          if (url) {
            panels[i].imageUrl = url;
            delete panels[i].generationError;
          }
        } catch (imgErr) {
          if (imgErr?.name === 'AbortError') throw imgErr;
          App.logError('Panel image generation (continuity)', imgErr);
          panels[i].generationError = imgErr.message;
          App.toast(`Panel ${i + 1} image failed: ${imgErr.message}`, 'error');
        }
        done++;
        if (statusMsg) statusMsg.textContent = `Generating images (${done} / ${total})...`;
      }),
    );
  }

  pageData.generation = {
    schemaVersion: 1,
    strategy: plan.strategy,
    modelId,
    ...(plan.strategy === 'independent-panels' ? { singleImageModelId } : {}),
    resolution: imageSize,
    promptVersion: PROMPT_VERSION,
    compiledPrompts,
    referenceManifest:
      plan.strategy === 'sequential-page' ? pageAlloc.manifest : panelAllocs.flatMap((a) => a.manifest),
    generatedAt: Date.now(),
  };
  pageData.generationWarnings = [...new Set(warnings)];
}

async function generatePage(presetData: any): Promise<void> {
  try {
    const contextExchanges = await DB.getSetting('contextExchanges', 6);
    trimConversationHistory(contextExchanges);

    const options = {};
    if (presetData) {
      options.temperature = presetData.temperature;
      options.topP = presetData.topP;
      options.maxTokens = presetData.maxTokens;
    }

    // Set up abort controller for this generation
    abortController = new AbortController();
    options.signal = abortController.signal;

    // Show streaming after brief delay
    streamTimeout = setTimeout(() => {
      const streamEl = document.getElementById('gen-stream');
      const loadEl = document.getElementById('gen-loading');
      if (streamEl) streamEl.classList.remove('hidden');
      if (loadEl) loadEl.classList.add('hidden');
    }, 500);

    const fullText = await API.chatCompletionStream(
      state.conversationHistory,
      (chunk, full) => {
        const el = document.getElementById('stream-output');
        if (el) el.textContent = full;
      },
      options,
    );

    // Parse the response
    const streamTitle = document.getElementById('gen-stream-title');
    if (streamTitle) streamTitle.textContent = 'Parsing story...';
    const statusMsg = document.getElementById('gen-status-msg');
    if (statusMsg) statusMsg.textContent = 'Parsing story...';

    let pageData = null;
    if (state.plannerMode) {
      const planned = API.parsePlannedPageResponse(fullText);
      if (planned) {
        // Exact ID validation replaces character-name regex matching
        const locationKeys = [...new Set((state.world?.images || []).map((img) => img?.locationKey).filter(Boolean))];
        const { page: validated, errors } = validatePlannedPage(planned, {
          characterIds: state.characters.map((c) => c.id),
          locationKeys,
        });
        pageData = {
          title: validated.title,
          panels: validated.panels.map(() => ({ narration: '', dialogue: [], imagePrompt: '', imageUrl: '' })),
          choices: validated.choices,
          planned: validated,
          validationErrors: errors,
        };
        validated.panels.forEach((p, i) => {
          pageData.panels[i].narration = p.narration;
          pageData.panels[i].dialogue = p.dialogue;
        });

        // State reduction: continuityBefore → per-panel render states → continuityAfter.
        // Snapshots are stored on the page so whole-page image regeneration can
        // reuse the exact render states instead of the comic's latest ledger.
        const pageNum = state.pages.length + 1;
        const continuityBefore = structuredClone(state.visualContinuity || initializeContinuity(state.characters));
        const reduction = reducePageStates(continuityBefore, validated, pageNum);
        pageData.continuityBefore = continuityBefore;
        pageData.continuityAfter = reduction.continuityAfter;
        pageData.renderStates = reduction.panelRenderStates;
        pageData.validationErrors = [...pageData.validationErrors, ...reduction.errors];
      }
    } else {
      pageData = API.parseComicResponse(fullText);
    }
    if (!pageData) {
      App.toast('Failed to parse comic page — the AI response was not valid JSON. Please try again.', 'error');
      state.step = state.pages.length > 0 ? 'reading' : 'setup';
      state.isGenerating = false;
      await App.refreshPage();
      return;
    }

    // Add assistant response to conversation
    state.conversationHistory.push({ role: 'assistant', content: fullText });

    // Generate images if enabled
    const enableImages = await DB.getSetting('enableImages', true);
    if (enableImages) {
      if (state.plannerMode && pageData.planned) {
        if (streamTitle) streamTitle.textContent = `Generating ${pageData.panels.length} images...`;
        try {
          await generateContinuityPageImages(pageData, statusMsg);
        } catch (imgErr) {
          if (imgErr?.name === 'AbortError') throw imgErr;
          // The story plan and continuity snapshots are preserved on the page,
          // so images can be retried later without regenerating story text.
          App.logError('Continuity image generation', imgErr);
          App.toast(`Image generation failed: ${imgErr.message}`, 'error');
        }
      } else {
        const panelsWithImages = pageData.panels.filter((p) => p.imagePrompt).length;
        if (panelsWithImages > 0) {
          if (streamTitle)
            streamTitle.textContent = `Generating ${panelsWithImages} image${panelsWithImages > 1 ? 's' : ''}...`;
          if (statusMsg) statusMsg.textContent = `Generating images (0 / ${panelsWithImages})...`;
        }
        await generatePanelImages(pageData, statusMsg);
      }
    }

    // Save page — generate id first so we can track it for re-roll/undo
    state.pages.push(pageData);
    const pageNum = state.pages.length;
    const pageId = DB.uuid();
    const pageRecord = {
      id: pageId,
      comicId: state.comicId,
      pageNum,
      data: pageData,
      createdAt: Date.now(),
    };
    state.pageIds.push(pageId);

    // Update comic — page snapshot and comic ledger commit atomically so a
    // failed write can never advance continuity without its page record
    const comic = await DB.get(DB.STORES.comics, state.comicId);
    if (comic) {
      comic.pageCount = pageNum;
      comic.conversationHistory = state.conversationHistory;
      if (state.plannerMode && pageData.continuityAfter) {
        comic.visualContinuity = pageData.continuityAfter;
      }
      comic.updatedAt = Date.now();
      await DB.commitPageAndComic(pageRecord, comic);
    } else {
      await DB.put(DB.STORES.pages, pageRecord);
    }
    if (state.plannerMode && pageData.continuityAfter) {
      state.visualContinuity = pageData.continuityAfter;
    }

    // Autosave: track this comic as the active in-progress session.
    // Setup draft is intentionally NOT cleared here — it persists so the user's
    // genre, characters, world, preset, title, and prompt are pre-filled for the
    // next comic. The user can clear it explicitly via the "New Comic" button.
    DB.setSetting('createActiveComicId', state.comicId).catch(() => {});
    // Clear re-roll backup now that the new page is committed
    _rerollBackup = null;

    state.step = 'reading';
    state.isGenerating = false;
    App.toast(`Page ${pageNum} ready!`, 'success');
    await App.refreshPage();
  } catch (err) {
    App.logError('Comic generation', err);
    if (err.name === 'AbortError') {
      // Cancelled — cancelGeneration() already handled state/backup restoration
      return;
    }
    // Roll back the last user message so retries don't compound failed attempts
    if (state.conversationHistory.length > 0) {
      const last = state.conversationHistory[state.conversationHistory.length - 1];
      if (last && last.role === 'user') state.conversationHistory.pop();
    }
    // If a re-roll failed, restore the backed-up page (any page position)
    if (state.generatingContext === 'reroll' && _rerollBackup) {
      restoreRerollBackup();
      App.toast('Re-roll failed — previous page restored. ' + (err.message || 'Please try again.'), 'error');
    } else {
      _rerollBackup = null;
      App.toast(err.message || 'Generation failed. Please try again.', 'error');
    }
    state.step = state.pages.length > 0 ? 'reading' : 'setup';
    state.isGenerating = false;
    await App.refreshPage();
  }
}

async function makeChoice(idx: number): Promise<void> {
  if (state.isGenerating) return;
  const currentPage = state.pages[state.pages.length - 1];
  if (!currentPage || !currentPage.choices || !currentPage.choices[idx]) return;

  const choice = currentPage.choices[idx];
  const userMsg = `The reader chose: "${choice.text}". Continue the story based on this choice. Generate the next comic page.`;

  state.conversationHistory.push({ role: 'user', content: userMsg });
  state.isGenerating = true;
  state.step = 'generating';
  state.generatingContext = 'continue';
  await App.refreshPage();

  const presetData = state.selectedPreset ? await DB.get(DB.STORES.presets, state.selectedPreset) : null;
  await generatePage(presetData);
}

async function continueStory() {
  if (state.isGenerating) return;
  const customDir = document.getElementById('custom-direction')?.value?.trim();
  const userMsg = customDir
    ? `Continue the story with this direction: ${customDir}. Generate the next comic page.`
    : 'Continue the story naturally. Generate the next comic page.';

  state.conversationHistory.push({ role: 'user', content: userMsg });
  state.isGenerating = true;
  state.step = 'generating';
  state.generatingContext = 'continue';
  await App.refreshPage();

  const presetData = state.selectedPreset ? await DB.get(DB.STORES.presets, state.selectedPreset) : null;
  await generatePage(presetData);
}

async function finishComic() {
  const comic = await DB.get(DB.STORES.comics, state.comicId);
  if (comic) {
    comic.finished = true;
    comic.updatedAt = Date.now();
    await DB.put(DB.STORES.comics, comic);
  }
  DB.setSetting('createActiveComicId', null).catch(() => {});
  App.toast('Comic saved!', 'success');
  resetState();
  App.navigate('library');
}

/**
 * Restore the backed-up page after a cancelled or failed re-roll.
 * Works for any page position in the comic, not just single-page comics.
 */
function restoreRerollBackup() {
  if (!_rerollBackup) return;
  state.pages.push(_rerollBackup.page);
  state.pageIds.push(_rerollBackup.pageId);
  state.conversationHistory = _rerollBackup.conversationHistory;
  // Restore the continuity ledger to the backed-up page's end state
  if (state.plannerMode && _rerollBackup.page?.continuityAfter) {
    state.visualContinuity = structuredClone(_rerollBackup.page.continuityAfter);
  }
  // Re-save the page record in DB (it was deleted by rerollPage)
  DB.put(DB.STORES.pages, {
    id: _rerollBackup.pageId,
    comicId: state.comicId,
    pageNum: _rerollBackup.pageNum,
    data: _rerollBackup.page,
    createdAt: _rerollBackup.createdAt,
  }).catch(() => {});
  // Restore comic record to reflect the re-appended page
  DB.get(DB.STORES.comics, state.comicId)
    .then((comic) => {
      if (comic) {
        comic.pageCount = state.pages.length;
        comic.conversationHistory = state.conversationHistory;
        if (state.plannerMode) comic.visualContinuity = state.visualContinuity;
        comic.updatedAt = Date.now();
        DB.put(DB.STORES.comics, comic).catch(() => {});
      }
    })
    .catch(() => {});
  _rerollBackup = null;
}

function cancelGeneration() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (streamTimeout) {
    clearTimeout(streamTimeout);
    streamTimeout = null;
  }
  state.isGenerating = false;

  // Restore the backed-up page whenever a re-roll is cancelled (any page position)
  if (state.generatingContext === 'reroll' && _rerollBackup) {
    restoreRerollBackup();
    App.toast('Re-roll cancelled — previous page restored', 'info');
  } else if (state.generatingContext === 'reimage') {
    // Image backup and state reset are handled inside rerollImages() via AbortError catch
    App.toast('Image regeneration cancelled', 'info');
  } else {
    App.toast('Generation cancelled', 'info');
  }

  state.step = state.pages.length > 0 ? 'reading' : 'setup';
  App.refreshPage();
}

/**
 * Regenerate the current page with different content.
 * Pops the last assistant message so the AI produces a fresh response.
 * A backup of the page is kept so that cancelling the re-roll restores it.
 */
async function rerollPage() {
  if (state.isGenerating || state.pages.length === 0) return;

  const lastPageIdx = state.pages.length - 1;
  const lastPageId = state.pageIds[lastPageIdx];

  // Fetch the persisted record before deleting so we preserve ordering metadata
  let originalRecord = null;
  try {
    originalRecord = await DB.get(DB.STORES.pages, lastPageId);
  } catch (_) {}

  // Deep-clone the backup so it can't be mutated while generation is in progress
  _rerollBackup = {
    page: structuredClone(state.pages[lastPageIdx]),
    pageId: lastPageId,
    pageNum: originalRecord?.pageNum ?? lastPageIdx + 1,
    createdAt: originalRecord?.createdAt ?? Date.now(),
    conversationHistory: structuredClone(state.conversationHistory),
  };

  // Remove last assistant turn from history so the AI tries again.
  // A failed parse attempt may have left a trailing user message — strip it first.
  const trailingMsg = state.conversationHistory[state.conversationHistory.length - 1];
  if (trailingMsg?.role === 'user') state.conversationHistory.pop();
  const lastMsg = state.conversationHistory[state.conversationHistory.length - 1];
  if (lastMsg?.role === 'assistant') state.conversationHistory.pop();

  // Delete the saved page from DB
  state.pageIds.pop();
  if (lastPageId) await DB.del(DB.STORES.pages, lastPageId);
  state.pages.pop();

  // Rewind the continuity ledger to before the re-rolled page so the fresh
  // page reduces from the correct starting state
  if (state.plannerMode && _rerollBackup.page?.continuityBefore) {
    state.visualContinuity = structuredClone(_rerollBackup.page.continuityBefore);
  }

  // Update the comic record
  const comic = await DB.get(DB.STORES.comics, state.comicId);
  if (comic) {
    comic.pageCount = state.pages.length;
    comic.conversationHistory = state.conversationHistory;
    if (state.plannerMode) comic.visualContinuity = state.visualContinuity;
    comic.updatedAt = Date.now();
    await DB.put(DB.STORES.comics, comic);
  }

  state.isGenerating = true;
  state.step = 'generating';
  state.generatingContext = 'reroll';
  await App.refreshPage();

  const presetData = state.selectedPreset ? await DB.get(DB.STORES.presets, state.selectedPreset) : null;
  await generatePage(presetData);
}

/**
 * Undo the last narrative choice, returning to the previous page's choice set.
 * Removes both the assistant response AND the preceding user-choice message.
 */
async function undoChoice() {
  if (state.isGenerating || state.pages.length <= 1) return;

  // Pop assistant response then user choice (two messages) for the page being undone.
  // A failed next-page generation may have left a trailing user message — strip it first.
  const trailingMsg = state.conversationHistory[state.conversationHistory.length - 1];
  if (trailingMsg?.role === 'user') {
    state.conversationHistory.pop();
  }
  const assistantMsg = state.conversationHistory[state.conversationHistory.length - 1];
  if (assistantMsg?.role === 'assistant') {
    state.conversationHistory.pop();
  }
  const userMsg = state.conversationHistory[state.conversationHistory.length - 1];
  if (userMsg?.role === 'user') {
    state.conversationHistory.pop();
  }

  // Delete the last page from DB
  const lastPageId = state.pageIds.pop();
  if (lastPageId) await DB.del(DB.STORES.pages, lastPageId);
  state.pages.pop();

  // Rewind the continuity ledger to the end state of the page we returned to
  if (state.plannerMode) {
    const lastPage = state.pages[state.pages.length - 1];
    state.visualContinuity = lastPage?.continuityAfter
      ? structuredClone(lastPage.continuityAfter)
      : initializeContinuity(state.characters);
  }

  // Update the comic record
  const comic = await DB.get(DB.STORES.comics, state.comicId);
  if (comic) {
    comic.pageCount = state.pages.length;
    comic.conversationHistory = state.conversationHistory;
    if (state.plannerMode) comic.visualContinuity = state.visualContinuity;
    comic.updatedAt = Date.now();
    await DB.put(DB.STORES.comics, comic);
  }

  App.toast('Went back to previous choice', 'info');
  state.step = 'reading';
  await App.refreshPage();
}

/**
 * Regenerate only the images for the current page, keeping the existing story text.
 * Does not modify conversation history or choices — only replaces imageUrl on each panel.
 * Respects the enableImages setting; backs up and restores prior image URLs on failure/cancel.
 */
async function rerollImages() {
  if (state.isGenerating || state.pages.length === 0) return;

  const enableImages = await DB.getSetting('enableImages', true);
  if (!enableImages) {
    App.toast('Image generation is disabled in Settings', 'info');
    return;
  }

  const currentPageIdx = state.pages.length - 1;
  const currentPageId = state.pageIds[currentPageIdx];
  const currentPage = state.pages[currentPageIdx];

  // Back up prior image URLs so they can be restored on failure or cancel
  const priorImageUrls = currentPage.panels.map((p) => p.imageUrl || '');

  // Clear existing image URLs so the user sees progress
  currentPage.panels.forEach((p) => {
    p.imageUrl = '';
  });

  // Set up abort controller for cancellation
  abortController = new AbortController();

  state.isGenerating = true;
  state.step = 'generating';
  state.generatingContext = 'reimage';
  await App.refreshPage();

  try {
    const statusMsg = document.getElementById('gen-status-msg');
    if (state.plannerMode && currentPage.planned && Array.isArray(currentPage.renderStates)) {
      // Whole-page regeneration reuses the page's stored render-state
      // snapshots — not the comic's latest ledger (spec §12.4)
      if (statusMsg) statusMsg.textContent = `Regenerating ${currentPage.panels.length} panel images...`;
      await generateContinuityPageImages(currentPage, statusMsg);
    } else {
      const panelsWithImages = currentPage.panels.filter((p) => p.imagePrompt).length;
      if (statusMsg) statusMsg.textContent = `Generating images (0 / ${panelsWithImages})...`;
      await generatePanelImages(currentPage, statusMsg);
    }

    // If aborted during generatePanelImages, restore backup and return
    if (abortController?.signal.aborted) {
      currentPage.panels.forEach((p, i) => {
        p.imageUrl = priorImageUrls[i];
      });
      abortController = null;
      return;
    }
    abortController = null;

    // Persist updated page
    const existingRecord = await DB.get(DB.STORES.pages, currentPageId).catch(() => null);
    await DB.put(DB.STORES.pages, {
      id: currentPageId,
      comicId: state.comicId,
      pageNum: existingRecord?.pageNum ?? currentPageIdx + 1,
      data: currentPage,
      createdAt: existingRecord?.createdAt ?? Date.now(),
    });

    // Bump parent comic's updatedAt so the library reflects the change
    if (state.comicId) {
      const comic = await DB.get(DB.STORES.comics, state.comicId).catch(() => null);
      if (comic) {
        await DB.put(DB.STORES.comics, { ...comic, updatedAt: Date.now() }).catch(() => {});
      }
    }

    state.isGenerating = false;
    state.step = 'reading';
    App.toast('Images regenerated!', 'success');
    await App.refreshPage();
  } catch (err) {
    // Restore prior images on any failure
    currentPage.panels.forEach((p, i) => {
      p.imageUrl = priorImageUrls[i];
    });
    abortController = null;
    App.logError('Image regeneration', err);
    state.isGenerating = false;
    state.step = 'reading';
    if (err.name !== 'AbortError') {
      App.toast('Image regeneration failed: ' + (err.message || 'Please try again.'), 'error');
    }
    await App.refreshPage();
  }
}

/**
 * Open a full-size panel image in a modal lightbox.
 * Uses the panel index to look up from the current page in state (avoids
 * embedding data URLs in onclick attributes).
 */
function zoomPanel(panelIndex: number): void {
  const currentPage = state.pages[state.pages.length - 1];
  const panel = currentPage?.panels?.[panelIndex];
  if (!panel?.imageUrl) return;
  App.showModal(`
    <div style="text-align:center;padding:8px;">
      <img id="zoom-img" style="max-width:100%;max-height:75vh;border-radius:8px;display:block;margin:0 auto 12px;">
      <button class="btn btn-secondary" onclick="App.hideModal()">Close</button>
    </div>
  `);
  // Set src via DOM after modal is rendered to safely handle data URLs
  const imgEl = document.getElementById('zoom-img');
  if (imgEl) imgEl.src = panel.imageUrl;
}

function resetState() {
  DB.setSetting('createActiveComicId', null).catch(() => {});
  _rerollBackup = null;
  state = {
    step: 'setup',
    genre: '',
    customGenre: '',
    selectedCharacters: [],
    selectedWorld: null,
    selectedPreset: null,
    comicId: null,
    title: '',
    storyPrompt: '',
    pages: [],
    pageIds: [],
    conversationHistory: [],
    referenceImages: [],
    characterImagesByName: {},
    characters: [],
    world: null,
    plannerMode: false,
    visualContinuity: null,
    isGenerating: false,
    generatingContext: 'initial',
    draftLoaded: false,
  };
}

function onUnmount(): void {
  // Flush any pending debounced draft save when navigating away via SPA router.
  // (does not run on full page reload/close; reload-safe persistence is handled
  // by the debounced saveDraft() calls in every setup setter)
  if (state.step === 'setup') {
    clearTimeout(draftSaveTimer);
    saveDraft().catch(() => {});
  }
  if (streamTimeout) {
    clearTimeout(streamTimeout);
    streamTimeout = null;
  }
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

const CreatePage: PageModule & Record<string, any> = {
  render,
  onUnmount,
  selectGenre,
  setCustomGenre,
  toggleCharacter,
  selectWorld,
  selectPreset,
  selectImagePreset,
  toggleAdvanced,
  startGenerating,
  makeChoice,
  continueStory,
  finishComic,
  cancelGeneration,
  rerollPage,
  rerollImages,
  undoChoice,
  zoomPanel,
  saveContinuityEdits,
  resetState,
  setTitle,
  setStoryPrompt,
  resetSetup,
};
export default CreatePage;
