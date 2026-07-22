// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml, GENRES, dedupeByNameLatest } from '../utils.js';
import DB from '../db.js';
import API from '../api.js';
import {
  enterStage,
  finishAttempt,
  formatElapsed,
  getGenerationCounts,
  getSoftStalledRequests,
  startAttempt,
  toSafeDiagnostics,
  toSafeGenerationFailure,
} from '../generation-progress.js';
import { startGenerationKeepAlive, stopGenerationKeepAlive } from '../generation-keepalive.js';
import {
  initializeContinuity,
  reducePageStates,
  validatePlannedPage,
  applyVisualStateChange,
} from '../visual-continuity.js';
import {
  attachGenerationAttempt,
  ensureFailureGenerationMetadata,
  generateContinuityPageImages,
  generatePanelImages,
  generationOutcomeForPage,
  preflightImageGeneration,
} from '../generation/image-engine.js';
import { createReferenceRepository } from '../references/repository.js';

const referenceRepository = createReferenceRepository();

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
  initialVisualOverrides: {}, // per-comic opening-state overrides from setup (charId → raw field strings)
  isGenerating: false,
  generatingContext: 'initial', // 'initial', 'reroll', 'continue'
  draftLoaded: false,
  generationProgress: null,
  imageGenerationConfig: null,
};

// Track timeouts and abort controllers for cleanup
let streamTimeout: ReturnType<typeof setTimeout> | null = null;
let abortController: AbortController | null = null;
let progressInterval: ReturnType<typeof setInterval> | null = null;

function generationContext() {
  if (state.generatingContext === 'reimage') return 'reimage';
  if (state.generatingContext === 'reroll') return 'reroll';
  if (state.generatingContext === 'continue') return 'continue';
  return 'new-page';
}

/** Generation is active: show the global top-bar indicator and (on Android) keep the process alive. */
function generationStarted() {
  App.setGenIndicator(true);
  startGenerationKeepAlive();
}

/** Generation reached a terminal state: hide the indicator and release the Android keep-alive. */
function generationEnded() {
  App.setGenIndicator(false);
  stopGenerationKeepAlive();
}

function beginGenerationProgress() {
  if (progressInterval) clearInterval(progressInterval);
  state.generationProgress = startAttempt(generationContext());
  state.imageGenerationConfig = null;
  progressInterval = setInterval(updateProgressDom, 1000);
  generationStarted();
}

function setProgress(next) {
  if (!state.generationProgress || next.attemptId !== state.generationProgress.attemptId) return;
  state.generationProgress = next;
  updateProgressDom();
}

function updateProgressDom() {
  const progress = state.generationProgress;
  if (!progress) return;
  const counts = getGenerationCounts(progress);
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('gen-status-msg', progress.message);
  setText('gen-elapsed', formatElapsed(Date.now() - progress.startedAt));
  setText(
    'gen-route',
    progress.strategy
      ? progress.strategy === 'sequential-page'
        ? 'One page sequence'
        : 'Independent panels'
      : 'Resolving route…',
  );
  setText('gen-model', progress.effectiveImageModelId || progress.pageModelId || 'Not selected yet');
  setText(
    'gen-counts',
    progress.requests.length
      ? `Requests: ${counts.completedRequests} / ${counts.totalRequests} · Images: ${counts.receivedImages} / ${counts.expectedImages}`
      : '',
  );
  const slow = getSoftStalledRequests(progress);
  const slowEl = document.getElementById('gen-slow');
  if (slowEl) {
    slowEl.classList.toggle('hidden', slow.length === 0);
    if (slow.length)
      slowEl.textContent =
        'NanoGPT is taking longer than usual. The request is still active and will stop at the configured timeout unless it completes or you cancel it.';
  }
}

function stopProgressTimer() {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = null;
}

// Explicit dependencies handed to the extracted image engine. `state` is a
// getter because resetState() reassigns the module-level state object.
const engineCtx = {
  get state() {
    return state;
  },
  signal: () => abortController?.signal,
  setProgress,
  toast: (message, type) => App.toast(message, type),
  logError: (context, error, details) => App.logError(context, error, details),
};

// Backup used to restore the current page if a re-roll is cancelled or fails
let _rerollBackup: any = null;

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
  const plannerEnabled = await DB.getSetting('useStructuredPlanner', true);
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
        ${hasDraft ? `<button class="btn btn-sm btn-secondary" data-action="resetSetup" title="Clear all setup and start fresh">&#x1F5D1; New Comic</button>` : ''}
      </div>

      <!-- Step 1: Genre -->
      <div class="card">
        <h3 class="card-title mb-sm">1. Choose Genre</h3>
        <div class="genre-grid" id="genre-grid">
          ${GENRES.map(
            (g) => `
            <div class="genre-card ${state.genre === g.id ? 'active' : ''}" data-genre="${g.id}" data-action="selectGenre" data-args="${escHtml(JSON.stringify([g.id]))}">
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
            <input type="text" id="custom-genre" value="${escHtml(state.customGenre)}" placeholder="Enter your custom genre..." data-action-change="setCustomGenre">
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
          <button class="btn btn-sm btn-secondary" data-navigate="characters" data-param="new">Create Character</button>
        `
            : `
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${characters
              .map(
                (c) => `
              <div class="chip ${state.selectedCharacters.includes(c.id) ? 'active' : ''}" data-action="toggleCharacter" data-args="${escHtml(JSON.stringify([c.id]))}">
                ${escHtml(c.name)}
              </div>
            `,
              )
              .join('')}
          </div>
        `
        }
        ${renderInitialStateSection(characters, plannerEnabled)}
      </div>

      <!-- Step 3: World -->
      <div class="card">
        <h3 class="card-title mb-sm">3. Select World (optional)</h3>
        ${
          worlds.length === 0
            ? `
          <p class="text-sm text-muted mb-sm">No worlds created yet.</p>
          <button class="btn btn-sm btn-secondary" data-navigate="worlds" data-param="new">Create World</button>
        `
            : `
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            <div class="chip ${!state.selectedWorld ? 'active' : ''}" data-action="selectWorld" data-args="[null]">None</div>
            ${worlds
              .map(
                (w) => `
              <div class="chip ${state.selectedWorld === w.id ? 'active' : ''}" data-action="selectWorld" data-args="${escHtml(JSON.stringify([w.id]))}">
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
          <div class="chip ${!state.selectedPreset ? 'active' : ''}" data-action="selectPreset" data-args="[null]">Default</div>
          ${presets
            .map(
              (p) => `
            <div class="chip ${state.selectedPreset === p.id ? 'active' : ''}" data-action="selectPreset" data-args="${escHtml(JSON.stringify([p.id]))}">
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
          <div class="chip ${!state.selectedImagePreset ? 'active' : ''}" data-action="selectImagePreset" data-args="[null]">Default</div>
          ${imagePresets
            .map(
              (p) => `
            <div class="chip ${state.selectedImagePreset === p.id ? 'active' : ''}" data-action="selectImagePreset" data-args="${escHtml(JSON.stringify([p.id]))}">
              ${escHtml(p.name)}
            </div>
          `,
            )
            .join('')}
        </div>
        <div class="form-hint" style="margin-top:8px;">
          <a href="#" data-navigate="image-presets">Manage image style presets</a>
        </div>
      </div>

      <!-- Step 6: Story Setup -->
      <div class="card">
        <h3 class="card-title mb-sm">6. Story Setup</h3>
        <div class="form-group">
          <label class="form-label">Comic Title</label>
          <input type="text" id="comic-title" value="${escHtml(state.title)}" placeholder="e.g. The Last Guardian" data-action-input="setTitle">
        </div>
        <div class="form-group">
          <label class="form-label">Opening Prompt</label>
          <textarea id="story-prompt" rows="4" placeholder="Describe how you want the story to begin... (Leave blank for AI to decide)" data-action-input="setStoryPrompt">${escHtml(state.storyPrompt)}</textarea>
          <div class="form-hint">Be specific or leave blank for a surprise</div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" data-action="startGenerating" ${!state.genre ? 'disabled' : ''}>
        Generate First Page
      </button>
    </div>
  `;
}

/**
 * Per-comic initial visual state (spec §12.3): shown in setup for the
 * selected characters, initialized from each character's reusable defaults.
 * Edits here override only this comic — the character record is untouched.
 */
function renderInitialStateSection(characters: any[], plannerEnabled: boolean): string {
  if (!plannerEnabled || state.selectedCharacters.length === 0) return '';
  const rows = state.selectedCharacters
    .map((cid) => {
      const c = characters.find((x) => x.id === cid);
      if (!c) return '';
      const dvs = c.defaultVisualState || {};
      const ov = state.initialVisualOverrides?.[cid] || {};
      const val = (field, fallback) => (ov[field] !== undefined ? ov[field] : fallback);
      return `
        <div class="continuity-char" data-charid="${cid}">
          <div class="continuity-char-name">${escHtml(c.name)}</div>
          <input type="text" class="continuity-field" placeholder="Use identity-anchor outfit"
            value="${escHtml(val('wardrobe', dvs.wardrobeDescription || ''))}"
            data-action-input="setInitialState" data-args="${escHtml(JSON.stringify([cid, 'wardrobe']))}" title="Opening wardrobe for this comic">
          <input type="text" class="continuity-field mt-sm" placeholder="Hair state"
            value="${escHtml(val('hair', dvs.hairState || ''))}"
            data-action-input="setInitialState" data-args="${escHtml(JSON.stringify([cid, 'hair']))}">
          <input type="text" class="continuity-field mt-sm" placeholder="Carried items (comma-separated)"
            value="${escHtml(val('items', (dvs.carriedItems || []).join(', ')))}"
            data-action-input="setInitialState" data-args="${escHtml(JSON.stringify([cid, 'items']))}">
          <input type="text" class="continuity-field mt-sm" placeholder="Injuries (comma-separated)"
            value="${escHtml(val('injuries', (dvs.injuries || []).join(', ')))}"
            data-action-input="setInitialState" data-args="${escHtml(JSON.stringify([cid, 'injuries']))}">
          <input type="text" class="continuity-field mt-sm" placeholder="Temporary changes (comma-separated)"
            value="${escHtml(val('temporary', (dvs.temporaryChanges || []).join(', ')))}"
            data-action-input="setInitialState" data-args="${escHtml(JSON.stringify([cid, 'temporary']))}">
        </div>`;
    })
    .join('');
  if (!rows) return '';
  return `
    <div class="mt-sm">
      <div class="collapsible-header collapsed" data-action="toggleAdvanced">
        <h3 class="card-title" style="margin:0;">Initial Visual State (optional)</h3>
      </div>
      <div class="collapsible-body collapsed">
        <p class="text-sm text-muted">Opening wardrobe and state for this comic only. Blank wardrobe means the outfit shown in the character's identity anchor. The reusable character record is not changed.</p>
        ${rows}
      </div>
    </div>`;
}

/** Record a per-comic initial-state override from the setup form. */
function setInitialState(charId: string, field: string, input: any): void {
  state.initialVisualOverrides = state.initialVisualOverrides || {};
  state.initialVisualOverrides[charId] = state.initialVisualOverrides[charId] || {};
  state.initialVisualOverrides[charId][field] = input.value;
  scheduleDraftSave();
}

/** Convert raw setup-form overrides into CharacterVisualStateDefaults per character. */
function buildInitialStateOverrides(characters: any[]): Record<string, any> {
  const splitList = (s) =>
    String(s || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const overrides = {};
  for (const c of characters) {
    const ov = state.initialVisualOverrides?.[c.id];
    if (!ov) continue;
    const out: any = {};
    if (ov.wardrobe !== undefined) out.wardrobeDescription = ov.wardrobe;
    if (ov.hair !== undefined) out.hairState = ov.hair;
    if (ov.items !== undefined) out.carriedItems = splitList(ov.items);
    if (ov.injuries !== undefined) out.injuries = splitList(ov.injuries);
    if (ov.temporary !== undefined) out.temporaryChanges = splitList(ov.temporary);
    if (Object.keys(out).length > 0) overrides[c.id] = out;
  }
  return overrides;
}

function renderGenerating() {
  const progress = state.generationProgress || startAttempt(generationContext());
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
      <div class="card generation-progress-card">
        <div class="generation-progress-heading"><div class="spinner"></div><h3 class="card-title">${state.generatingContext === 'reimage' ? 'Regenerating images' : 'Generating page'}</h3></div>
        <p id="gen-status-msg">${escHtml(progress.message || contextMsg)}</p>
        <div class="generation-progress-facts text-sm text-muted">
          <span>Model: <strong id="gen-model">${escHtml(progress.effectiveImageModelId || progress.pageModelId || 'Not selected yet')}</strong></span>
          <span>Route: <strong id="gen-route">${progress.strategy === 'sequential-page' ? 'One page sequence' : progress.strategy === 'independent-panels' ? 'Independent panels' : 'Resolving route…'}</strong></span>
          <span>Elapsed: <strong id="gen-elapsed">${formatElapsed(Date.now() - progress.startedAt)}</strong></span>
        </div>
        <p id="gen-counts" class="text-sm">${
          progress.requests.length
            ? (() => {
                const c = getGenerationCounts(progress);
                return `Requests: ${c.completedRequests} / ${c.totalRequests} · Images: ${c.receivedImages} / ${c.expectedImages}`;
              })()
            : ''
        }</p>
        <p id="gen-slow" class="generation-slow hidden"></p>
        <button class="btn btn-secondary btn-sm mt-sm" data-action="cancelGeneration">Cancel</button>
      </div>
      <details id="gen-stream" class="card generation-story-response" ${state.generatingContext === 'reimage' ? 'hidden' : ''}>
        <summary id="gen-stream-title">Story response</summary>
        <div class="streaming-text" id="stream-output"></div>
      </details>
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
          <button class="btn btn-sm btn-secondary" data-action="rerollPage" ${state.isGenerating ? 'disabled' : ''} title="Regenerate this page with different content">&#x1F3B2; Re-roll</button>
          <button class="btn btn-sm btn-secondary" data-action="rerollImages" ${state.isGenerating ? 'disabled' : ''} title="Regenerate images only — keep the story text">&#x1F5BC; Re-images</button>
          ${canUndo ? `<button class="btn btn-sm btn-secondary" data-action="undoChoice" ${state.isGenerating ? 'disabled' : ''} title="Go back to previous choice">&#x21A9; Undo</button>` : ''}
        </div>
      </div>

      ${renderGenerationSummary(currentPage)}

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
              <button class="choice-btn" data-action="makeChoice" data-args="[${i}]" ${state.isGenerating ? 'disabled' : ''}>
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
          <button class="btn btn-primary" data-action="continueStory" ${state.isGenerating ? 'disabled' : ''}>
            ${state.isGenerating ? 'Generating...' : 'Continue Story'}
          </button>
          <button class="btn btn-secondary" data-action="finishComic">Finish Comic</button>
        </div>
      </div>

      <!-- Page History -->
      ${
        pages.length > 1
          ? `
        <div class="card">
          <div class="collapsible-header collapsed" data-action="toggleAdvanced">
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

function renderGenerationSummary(page) {
  const panels = page?.panels || [];
  const imagePanels = panels.filter((panel) => panel.imagePrompt || panel.generationError || panel.imageUrl);
  const missing = panels
    .map((panel, index) => (!panel.imageUrl && (panel.imagePrompt || panel.generationError) ? index : -1))
    .filter((index) => index >= 0);
  if (!page?.generation || missing.length === 0) return '';
  const created = imagePanels.filter((panel) => panel.imageUrl).length;
  return `<div class="card generation-result-summary">
    <strong>${created} of ${imagePanels.length} images were created.</strong>
    <p class="text-sm text-muted">The story and completed images were saved. Missing panels: ${missing.map((index) => index + 1).join(', ')}.</p>
    <div class="btn-group">
      <button class="btn btn-primary btn-sm" data-action="retryMissingImages">Retry missing images</button>
      <button class="btn btn-secondary btn-sm" data-action="copyGenerationDetails">Copy details</button>
    </div>
  </div>`;
}

function renderComicPage(page: any): string {
  if (!page || !page.panels) return '<p class="text-muted">Empty page</p>';

  return page.panels
    .map(
      (panel, i) => `
    <div class="comic-panel">
      ${
        panel.imageUrl
          ? `<img src="${panel.imageUrl}" alt="Panel ${i + 1}" loading="lazy" class="zoomable-panel" style="cursor:zoom-in;" data-action="zoomPanel" data-args="[${i}]">`
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
      <div class="collapsible-header collapsed" data-action="toggleAdvanced">
        <h3 class="card-title" style="margin:0;">Continuity</h3>
      </div>
      <div class="collapsible-body collapsed">
        <p class="text-sm text-muted">Current visual state used for the next page. Edit to correct clothing or details before continuing.</p>
        ${charRows}
        <button class="btn btn-secondary btn-sm" data-action="saveContinuityEdits">Apply State Edits</button>
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

function setTitle(input: any): void {
  state.title = input.value;
  scheduleDraftSave();
}

function setStoryPrompt(input: any): void {
  state.storyPrompt = input.value;
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
    initialVisualOverrides: state.initialVisualOverrides,
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
    state.initialVisualOverrides =
      draft.initialVisualOverrides && typeof draft.initialVisualOverrides === 'object'
        ? draft.initialVisualOverrides
        : {};
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
  state.initialVisualOverrides = {};
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

function setCustomGenre(input: any): void {
  state.customGenre = input.value;
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
    const locations = world ? await referenceRepository.listLocations(world.id) : [];
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
        ? {
            id: world.id,
            name: world.name,
            description: world.description,
            details: world.details,
            atmosphere: world.atmosphere,
          }
        : null,
      locations: locations.map(({ id, name, description }) => ({ id, name, description })),
      customSystemPrompt: presetData?.systemPrompt || null,
    });
    state.visualContinuity = initializeContinuity(characters, buildInitialStateOverrides(characters));
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
  beginGenerationProgress();
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

    await preflightImageGeneration(engineCtx);
    if (state.generationProgress) setProgress(enterStage(state.generationProgress, 'writing-story', 'Writing story…'));

    const fullText = await API.chatCompletionStream(
      state.conversationHistory,
      (chunk, full) => {
        const el = document.getElementById('stream-output');
        if (el) el.textContent = full;
      },
      options,
    );

    // Parse the response
    if (state.generationProgress)
      setProgress(enterStage(state.generationProgress, 'parsing-story', 'Parsing story plan…'));
    const streamTitle = document.getElementById('gen-stream-title');
    if (streamTitle) streamTitle.textContent = 'Parsing story...';
    const statusMsg = document.getElementById('gen-status-msg');
    if (statusMsg) statusMsg.textContent = 'Parsing story...';

    let pageData = null;
    if (state.plannerMode) {
      const planned = API.parsePlannedPageResponse(fullText);
      if (planned) {
        // Exact ID validation replaces character-name regex matching
        const locations = state.world ? await referenceRepository.listLocations(state.world.id) : [];
        const { page: validated, errors } = validatePlannedPage(planned, {
          characterIds: state.characters.map((c) => c.id),
          locationIds: locations.map(({ id }) => id),
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
      if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, 'failed'));
      stopProgressTimer();
      generationEnded();
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
      if (state.generationProgress)
        setProgress(enterStage(state.generationProgress, 'preparing-references', 'Preparing reference images…'));
      if (state.plannerMode && pageData.planned) {
        if (streamTitle) streamTitle.textContent = `Generating ${pageData.panels.length} images...`;
        try {
          await generateContinuityPageImages(engineCtx, pageData, statusMsg);
        } catch (imgErr) {
          if (imgErr?.name === 'AbortError') throw imgErr;
          // The story plan and continuity snapshots are preserved on the page,
          // so images can be retried later without regenerating story text.
          App.logError('Continuity image generation', imgErr);
          ensureFailureGenerationMetadata(engineCtx, pageData, imgErr);
          App.toast(`Image generation failed: ${imgErr.message}`, 'error');
        }
      } else {
        const panelsWithImages = pageData.panels.filter((p) => p.imagePrompt).length;
        if (panelsWithImages > 0) {
          if (streamTitle)
            streamTitle.textContent = `Generating ${panelsWithImages} image${panelsWithImages > 1 ? 's' : ''}...`;
          if (statusMsg) statusMsg.textContent = `Generating images (0 / ${panelsWithImages})...`;
        }
        await generatePanelImages(engineCtx, pageData, statusMsg);
      }
    }

    // Save page — generate id first so we can track it for re-roll/undo
    if (state.generationProgress) setProgress(enterStage(state.generationProgress, 'saving-page', 'Saving page…'));

    // Background generation lets the user delete the active comic from the
    // Library while a page is in flight — discard the result instead of
    // writing an orphaned page record.
    const comic = await DB.get(DB.STORES.comics, state.comicId);
    if (!comic) {
      if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, 'cancelled'));
      stopProgressTimer();
      generationEnded();
      _rerollBackup = null;
      App.toast('This comic was deleted while generating — the page was discarded.', 'info');
      resetState();
      await App.refreshPage();
      return;
    }

    const pageOutcome = generationOutcomeForPage(pageData, enableImages);
    attachGenerationAttempt(engineCtx, pageData, pageOutcome);
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
    comic.pageCount = pageNum;
    comic.conversationHistory = state.conversationHistory;
    if (state.plannerMode && pageData.continuityAfter) {
      comic.visualContinuity = pageData.continuityAfter;
    }
    comic.updatedAt = Date.now();
    const committed = await DB.commitPageAndComic(pageRecord, comic);
    if (!committed) {
      if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, 'cancelled'));
      stopProgressTimer();
      generationEnded();
      _rerollBackup = null;
      App.toast('This comic was deleted while generating — the page was discarded.', 'info');
      resetState();
      await App.refreshPage();
      return;
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
    if (state.generationProgress) {
      setProgress(finishAttempt(state.generationProgress, pageOutcome));
    }
    stopProgressTimer();
    generationEnded();
    const onScreen = App.getCurrentPage();
    if (onScreen === 'create') {
      App.toast(`Page ${pageNum} ready!`, 'success');
    } else {
      // Finished while the user was on another screen — persistent, tap to view
      App.toast(`Page ${pageNum} ready — tap to view`, 'success', {
        duration: 0,
        onClick: () => App.navigate('create'),
      });
    }
    // Only re-render screens that actually need to reflect the new page —
    // refreshing elsewhere (e.g. Settings) would wipe unrelated in-progress UI state.
    if (onScreen === 'create' || onScreen === 'library') {
      await App.refreshPage();
    }
  } catch (err) {
    App.logError('Comic generation', err);
    if (err.name === 'AbortError') {
      // Cancelled — cancelGeneration() already handled state/backup restoration
      return;
    }
    if (state.generationProgress)
      setProgress(finishAttempt(state.generationProgress, 'failed', Date.now(), toSafeGenerationFailure(err)));
    stopProgressTimer();
    generationEnded();
    // Roll back the last user message so retries don't compound failed attempts
    if (state.conversationHistory.length > 0) {
      const last = state.conversationHistory[state.conversationHistory.length - 1];
      if (last && last.role === 'user') state.conversationHistory.pop();
    }
    const onCreatePage = App.getCurrentPage() === 'create';
    const failureToastOpts = onCreatePage ? {} : { duration: 0, onClick: () => App.navigate('create') };
    const tapHint = onCreatePage ? '' : ' Tap to review.';
    // If a re-roll failed, restore the backed-up page (any page position)
    if (state.generatingContext === 'reroll' && _rerollBackup) {
      restoreRerollBackup();
      App.toast(
        'Re-roll failed — previous page restored. ' + (err.message || 'Please try again.') + tapHint,
        'error',
        failureToastOpts,
      );
    } else {
      _rerollBackup = null;
      App.toast((err.message || 'Generation failed. Please try again.') + tapHint, 'error', failureToastOpts);
    }
    state.step = state.pages.length > 0 ? 'reading' : 'setup';
    state.isGenerating = false;
    // Only re-render screens that actually need to reflect the failure —
    // refreshing elsewhere would wipe unrelated in-progress UI state (e.g.
    // unsaved Settings fields).
    if (onCreatePage || App.getCurrentPage() === 'library') {
      await App.refreshPage();
    }
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
  beginGenerationProgress();
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
  beginGenerationProgress();
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
  if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, 'cancelled'));
  stopProgressTimer();
  generationEnded();

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
  beginGenerationProgress();
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
  const removedPage = state.pages.pop();

  // Rewind the ledger to the moment just before the undone page was generated.
  // Using the removed page's continuityBefore (rather than the previous page's
  // continuityAfter) preserves manual state edits made at that boundary.
  if (state.plannerMode) {
    const lastPage = state.pages[state.pages.length - 1];
    state.visualContinuity = removedPage?.continuityBefore
      ? structuredClone(removedPage.continuityBefore)
      : lastPage?.continuityAfter
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
  beginGenerationProgress();
  await App.refreshPage();

  try {
    await preflightImageGeneration(engineCtx);
    const statusMsg = document.getElementById('gen-status-msg');
    if (state.plannerMode && currentPage.planned && Array.isArray(currentPage.renderStates)) {
      // Whole-page regeneration reuses the page's stored render-state
      // snapshots — not the comic's latest ledger (spec §12.4)
      if (statusMsg) statusMsg.textContent = `Regenerating ${currentPage.panels.length} panel images...`;
      await generateContinuityPageImages(engineCtx, currentPage, statusMsg);
      // Per-panel failures are recorded (not thrown) inside the generator so
      // one bad panel doesn't sink the page — but on a re-roll a failed panel
      // must keep its previous image instead of being persisted as blank
      let restoredCount = 0;
      currentPage.panels.forEach((p, i) => {
        if (!p.imageUrl && priorImageUrls[i]) {
          p.imageUrl = priorImageUrls[i];
          delete p.generationError;
          restoredCount++;
        }
      });
      if (restoredCount > 0) {
        App.toast(
          `${restoredCount} panel image${restoredCount === 1 ? '' : 's'} failed to regenerate — previous image${restoredCount === 1 ? '' : 's'} kept`,
          'info',
        );
      }
    } else {
      const panelsWithImages = currentPage.panels.filter((p) => p.imagePrompt).length;
      if (statusMsg) statusMsg.textContent = `Generating images (0 / ${panelsWithImages})...`;
      await generatePanelImages(engineCtx, currentPage, statusMsg);
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

    // The comic may have been deleted from the Library while regenerating in
    // the background — discard instead of writing an orphaned page record.
    const parentComic = await DB.get(DB.STORES.comics, state.comicId).catch(() => null);
    if (!parentComic) {
      if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, 'cancelled'));
      stopProgressTimer();
      generationEnded();
      App.toast('This comic was deleted while generating — the regenerated images were discarded.', 'info');
      resetState();
      await App.refreshPage();
      return;
    }

    // Persist updated page
    if (state.generationProgress) setProgress(enterStage(state.generationProgress, 'saving-page', 'Saving page…'));
    const reimageOutcome = generationOutcomeForPage(currentPage);
    attachGenerationAttempt(engineCtx, currentPage, reimageOutcome);
    const existingRecord = await DB.get(DB.STORES.pages, currentPageId).catch(() => null);
    // Existence was checked above, but the comic can still be deleted before
    // this write lands — re-checked atomically inside the same transaction,
    // which also bumps the comic's updatedAt so the library reflects the change.
    const committed = await DB.putPageIfComicExists(
      {
        id: currentPageId,
        comicId: state.comicId,
        pageNum: existingRecord?.pageNum ?? currentPageIdx + 1,
        data: currentPage,
        createdAt: existingRecord?.createdAt ?? Date.now(),
      },
      state.comicId,
      true,
    );
    if (!committed) {
      if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, 'cancelled'));
      stopProgressTimer();
      generationEnded();
      App.toast('This comic was deleted while generating — the regenerated images were discarded.', 'info');
      resetState();
      await App.refreshPage();
      return;
    }

    state.isGenerating = false;
    state.step = 'reading';
    if (state.generationProgress) {
      setProgress(finishAttempt(state.generationProgress, reimageOutcome));
    }
    stopProgressTimer();
    generationEnded();
    const onScreen = App.getCurrentPage();
    if (onScreen === 'create') {
      App.toast('Images regenerated!', 'success');
    } else {
      App.toast('Images regenerated — tap to view', 'success', {
        duration: 0,
        onClick: () => App.navigate('create'),
      });
    }
    // Only re-render screens that actually need to reflect the new images —
    // refreshing elsewhere would wipe unrelated in-progress UI state.
    if (onScreen === 'create' || onScreen === 'library') {
      await App.refreshPage();
    }
  } catch (err) {
    // Restore prior images on any failure
    currentPage.panels.forEach((p, i) => {
      p.imageUrl = priorImageUrls[i];
    });
    abortController = null;
    App.logError('Image regeneration', err);
    state.isGenerating = false;
    state.step = 'reading';
    if (state.generationProgress && err.name !== 'AbortError') {
      setProgress(finishAttempt(state.generationProgress, 'failed', Date.now(), toSafeGenerationFailure(err)));
    }
    stopProgressTimer();
    generationEnded();
    if (err.name !== 'AbortError') {
      App.toast('Image regeneration failed: ' + (err.message || 'Please try again.'), 'error');
    }
    // Only re-render screens that actually need to reflect the failure —
    // refreshing elsewhere would wipe unrelated in-progress UI state.
    const onScreen = App.getCurrentPage();
    if (onScreen === 'create' || onScreen === 'library') {
      await App.refreshPage();
    }
  }
}

function retryMissingImages() {
  const page = state.pages[state.pages.length - 1];
  const missing = (page?.panels || []).filter(
    (panel) => !panel.imageUrl && (panel.imagePrompt || panel.generationError),
  );
  if (!missing.length) return App.toast('There are no missing panel images to retry', 'info');
  App.showModal(`
    <div class="modal-title">Retry ${missing.length} missing image${missing.length === 1 ? '' : 's'}?</div>
    <p>A previous provider job may still complete or incur cost. This action submits only the panels that still have no usable image.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
      <button class="btn btn-primary btn-sm" data-action="confirmRetryMissingImages">Retry missing</button>
    </div>
  `);
}

async function confirmRetryMissingImages() {
  App.hideModal();
  if (state.isGenerating || state.pages.length === 0) return;
  const pageIndex = state.pages.length - 1;
  const page = state.pages[pageIndex];
  const panelIndexes = page.panels
    .map((panel, index) => (!panel.imageUrl && (panel.imagePrompt || panel.generationError) ? index : -1))
    .filter((index) => index >= 0);
  if (!panelIndexes.length) return;
  abortController = new AbortController();
  state.isGenerating = true;
  state.step = 'generating';
  state.generatingContext = 'reimage';
  beginGenerationProgress();
  await App.refreshPage();
  let discarded = false;
  try {
    await preflightImageGeneration(engineCtx);
    if (state.plannerMode && page.planned && Array.isArray(page.renderStates)) {
      await generateContinuityPageImages(engineCtx, page, null, { panelIndexes });
    } else {
      const hiddenPrompts = page.panels.map((panel, index) =>
        panelIndexes.includes(index) ? null : panel.imagePrompt,
      );
      page.panels.forEach((panel, index) => {
        if (!panelIndexes.includes(index)) panel.imagePrompt = '';
      });
      try {
        await generatePanelImages(engineCtx, page, null);
      } finally {
        page.panels.forEach((panel, index) => {
          if (hiddenPrompts[index] !== null) panel.imagePrompt = hiddenPrompts[index];
        });
      }
    }
    // The comic may have been deleted while retrying in the background
    const parentComic = await DB.get(DB.STORES.comics, state.comicId).catch(() => null);
    if (!parentComic) {
      discarded = true;
      if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, 'cancelled'));
      App.toast('This comic was deleted while generating — the recovered images were discarded.', 'info');
      resetState();
      return;
    }
    if (state.generationProgress) setProgress(enterStage(state.generationProgress, 'saving-page', 'Saving page…'));
    const pageId = state.pageIds[pageIndex];
    const record = await DB.get(DB.STORES.pages, pageId).catch(() => null);
    const retryOutcome = generationOutcomeForPage(page);
    attachGenerationAttempt(engineCtx, page, retryOutcome);
    // The comic can be deleted while generation continues in the background.
    // Re-check atomically while saving so no orphaned page record is written.
    const committed = await DB.putPageIfComicExists(
      {
        id: pageId,
        comicId: state.comicId,
        pageNum: record?.pageNum ?? pageIndex + 1,
        data: page,
        createdAt: record?.createdAt ?? Date.now(),
      },
      state.comicId,
    );
    if (!committed) {
      discarded = true;
      if (state.generationProgress) {
        setProgress(finishAttempt(state.generationProgress, 'cancelled'));
      }
      App.toast('This comic was deleted while generating — the recovered images were discarded.', 'info');
      resetState();
      return;
    }
    const stillMissing = panelIndexes.filter((index) => !page.panels[index].imageUrl).length;
    if (state.generationProgress) setProgress(finishAttempt(state.generationProgress, retryOutcome));
    App.toast(
      stillMissing
        ? `${panelIndexes.length - stillMissing} image(s) recovered; ${stillMissing} still missing`
        : 'Missing images recovered',
      stillMissing ? 'info' : 'success',
    );
  } catch (error) {
    if (error?.name !== 'AbortError') {
      App.logError('Retry missing images', error);
      App.toast(`Retry failed: ${error.message}`, 'error');
    }
  } finally {
    abortController = null;
    stopProgressTimer();
    generationEnded();
    if (!discarded) {
      state.isGenerating = false;
      state.step = 'reading';
    }
    // Only re-render screens that actually need to reflect the retried images —
    // refreshing elsewhere would wipe unrelated in-progress UI state.
    const onScreen = App.getCurrentPage();
    if (onScreen === 'create' || onScreen === 'library') {
      await App.refreshPage();
    }
  }
}

async function copyGenerationDetails() {
  const page = state.pages[state.pages.length - 1];
  const details = page?.generation?.attempt
    ? JSON.stringify(page.generation.attempt, null, 2)
    : state.generationProgress
      ? toSafeDiagnostics(state.generationProgress)
      : JSON.stringify(page?.generation || {}, null, 2);
  try {
    await navigator.clipboard.writeText(details);
    App.toast('Generation details copied', 'success');
  } catch {
    App.showModal(
      `<div class="modal-title">Generation details</div><textarea rows="14" style="width:100%" readonly>${escHtml(details)}</textarea><div class="modal-actions"><button class="btn btn-secondary" onclick="App.hideModal()">Close</button></div>`,
    );
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
    initialVisualOverrides: {},
    isGenerating: false,
    generatingContext: 'initial',
    draftLoaded: false,
    generationProgress: null,
    imageGenerationConfig: null,
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
  // Generation deliberately continues in the background while the user browses
  // other screens — do NOT abort here. Only the DOM-update timer stops (there
  // is nothing to update); onMount() restarts it when the user returns. The
  // Cancel button on the generating screen is the only way to abort.
  stopProgressTimer();
}

function onMount(): void {
  // Returning to the Create screen while a generation is running in the
  // background: resume the 1-second progress-DOM refresh.
  if (state.isGenerating && state.generationProgress && !progressInterval) {
    progressInterval = setInterval(updateProgressDom, 1000);
    updateProgressDom();
  }
}

const CreatePage: PageModule & Record<string, any> = {
  render,
  onMount,
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
  retryMissingImages,
  confirmRetryMissingImages,
  copyGenerationDetails,
  undoChoice,
  zoomPanel,
  saveContinuityEdits,
  setInitialState,
  resetState,
  setTitle,
  setStoryPrompt,
  resetSetup,
};
export default CreatePage;
