// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml, compareVersions, prepareExportPages } from '../utils.js';
import { extractProvider, buildModelDetails } from '../model-catalog.js';
import DB from '../db.js';
import API from '../api.js';
import { IMAGE_REQUEST_TIMEOUT_MS } from '../generation-progress.js';
import { migrateCompanionSettings } from '../image-generation-config.js';
import { saveBackupFile } from '../export-actions.js';
import { exportFile } from '../file-export.js';
import { buildBackup, parseBackup, importBackup } from '../settings/backup-import.js';
import { loadModelCatalog } from '../settings/model-loader.js';
import { localReferenceClassifier } from '../references/local-classifier.js';
import { buildDiagnosticExport } from '../references/diagnostic-privacy.js';
import { planLegacyMigration, runLegacyMigration } from '../references/legacy-migration.js';
import { referenceClassificationQueue, referenceRepository } from '../reference-workspace-runtime.js';

/**
 * Settings Page
 * Dynamically loads all available text and image models from NanoGPT API.
 */
// Injected by Vite's define plugin at build time; falls back to 'dev' in unbundled environments
const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const DEFAULT_UPDATE_REPO: string = 'dkylepeppers-alt/Comiccreator';

// In-memory model lists populated on render
let textModels: any[] = [];
let imageModels: any[] = [];
// Vision-capable subset of textModels used for the caption model picker
let captionModels: any[] = [];

// Delegate error logging to global App.logError
function logError(context: string, error: any, extraDetails?: string): void {
  App.logError(context, error, extraDetails);
}

async function render() {
  const apiKey = await DB.getSetting('apiKey', '');
  const model = await DB.getSetting('model', 'gpt-4o-mini');
  const imageModel = await DB.getSetting('imageModel', '');
  const temperature = await DB.getSetting('temperature', 0.7);
  const topP = await DB.getSetting('topP', 0.9);
  const maxTokens = await DB.getSetting('maxTokens', 2048);
  const contextExchanges = await DB.getSetting('contextExchanges', 6);
  const enableImages = await DB.getSetting('enableImages', true);
  const useRefImages = await DB.getSetting('useRefImages', true);
  const captionModel = await DB.getSetting('captionModel', '');
  const showExplicitContent = await DB.getSetting('showExplicitContent', false);
  const includeAppearanceText = await DB.getSetting('includeAppearanceText', true);
  const dynamicImageSizes = await DB.getSetting('dynamicImageSizes', false);
  const imageSize = await DB.getSetting('imageSize', '1024x1024');
  const enrichImagePrompts = await DB.getSetting('enrichImagePrompts', false);
  const negativePrompt = await DB.getSetting('negativePrompt', '');
  const updateRepo = await DB.getSetting('updateRepo', DEFAULT_UPDATE_REPO);
  const enableSequentialPages = await DB.getSetting('enableSequentialPages', false);
  const singleImageModel = await DB.getSetting('singleImageModel', '');
  const storedCompanionMode = await DB.getSetting('singleImageCompanionMode', null);
  const companion = migrateCompanionSettings(storedCompanionMode, singleImageModel);
  const imageRequestTimeoutMs = await DB.getSetting('imageRequestTimeoutMs', IMAGE_REQUEST_TIMEOUT_MS);
  const classificationBackend = await DB.getSetting('classificationBackend', 'cloud');
  const [
    legacyWorlds,
    legacyCharacters,
    legacyComics,
    classificationProgress,
    migrationProgress,
    classificationDiagnostics,
  ] = await Promise.all([
    DB.getAll(DB.STORES.worlds),
    DB.getAll(DB.STORES.characters),
    DB.getAll(DB.STORES.comics),
    referenceClassificationQueue.getProgress(),
    DB.getSetting('referenceMigrationProgress', null),
    referenceRepository.listDiagnostics(),
  ]);
  const migrationPlan = planLegacyMigration({
    worlds: legacyWorlds,
    characters: legacyCharacters,
    comics: legacyComics,
  });
  const directAssignments = new Map(
    legacyCharacters.filter((character) => character.worldId).map((character) => [character.id, character.worldId]),
  );
  const unresolvedAssignments = migrationPlan.unresolved.filter(
    ({ characterId }) => !directAssignments.has(characterId),
  );

  return `
    <div class="slide-up">
      <h2 class="section-title">Settings</h2>

      <!-- API Key -->
      <div class="card">
        <h3 class="card-title mb-sm">API Configuration</h3>
        <div class="form-group">
          <label class="form-label">NanoGPT API Key *</label>
          <input type="password" id="set-apikey" value="${escHtml(apiKey)}" placeholder="Enter your NanoGPT API key">
          <div class="form-hint">Get your key from <a href="https://nano-gpt.com" target="_blank">nano-gpt.com</a></div>
          <button class="btn btn-secondary btn-sm" id="test-conn-btn" data-action="testConnection" style="margin-top:8px;">Test Connection</button>
        </div>

        <!-- Text Model Picker -->
        <div class="form-group">
          <label class="form-label">Text Model</label>
          <input type="hidden" id="set-model" value="${escHtml(model)}">
          <div class="model-picker" id="text-model-picker">
            <div class="model-picker-selected" data-action="togglePicker" data-args='["text"]'>
              <span id="text-model-display">${escHtml(model)}</span>
              <span class="model-picker-arrow">&#9662;</span>
            </div>
            <div class="model-picker-dropdown hidden" id="text-model-dropdown">
              <div class="model-picker-search-wrap">
                <input type="text" class="model-picker-search" id="text-model-search" placeholder="Search 500+ models..." data-action-input="filterModels" data-args='["text"]'>
              </div>
              <div class="model-picker-status" id="text-model-status">Loading models...</div>
              <div class="model-picker-list" id="text-model-list"></div>
            </div>
          </div>
          <div class="form-hint">
            <span id="text-model-count">--</span> models available &middot;
            <button class="btn-link" data-action="refreshModels" data-args='["text"]'>Refresh list</button>
          </div>
        </div>

        <!-- Image Model Picker -->
        <div class="form-group">
          <label class="form-label">Image Model</label>
          <input type="hidden" id="set-imgmodel" value="${escHtml(imageModel)}">
          <div class="model-picker" id="image-model-picker">
            <div class="model-picker-selected" data-action="togglePicker" data-args='["image"]'>
              <span id="image-model-display">${imageModel ? escHtml(imageModel) : 'Select a model\u2026'}</span>
              <span class="model-picker-arrow">&#9662;</span>
            </div>
            <div class="model-picker-dropdown hidden" id="image-model-dropdown">
              <div class="model-picker-search-wrap">
                <input type="text" class="model-picker-search" id="image-model-search" placeholder="Search image models..." data-action-input="filterModels" data-args='["image"]'>
              </div>
              <div class="model-picker-status" id="image-model-status">Loading models...</div>
              <div class="model-picker-list" id="image-model-list"></div>
            </div>
          </div>
          <div class="form-hint">
            <span id="image-model-count">--</span> models available &middot;
            <button class="btn-link" data-action="refreshModels" data-args='["image"]'>Refresh list</button>
          </div>
          <div class="form-hint" id="image-model-caps"></div>
        </div>

        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="set-enableimgs" ${enableImages ? 'checked' : ''} style="width:auto;">
            Enable AI Image Generation
          </label>
          <div class="form-hint">Disable to save API credits (text-only comics)</div>
        </div>

        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="set-userefimgs" ${useRefImages ? 'checked' : ''} style="width:auto;">
            Use Reference Images
          </label>
          <div class="form-hint">Send character/world images as style references for consistent visuals (uses more credits)</div>
        </div>

        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="set-includeappearance" ${includeAppearanceText ? 'checked' : ''} style="width:auto;">
            Include Appearance Text in Prompts
          </label>
          <div class="form-hint">When enabled, character appearance descriptions are included in comic generation prompts. Disable to rely solely on reference images for visual consistency (reduces drift).</div>
        </div>

        <div class="form-group">
          <label class="form-label">Auto-Caption Model</label>
          <input type="hidden" id="set-captionmodel" value="${escHtml(captionModel)}">
          <div class="model-picker" id="caption-model-picker">
            <div class="model-picker-selected" data-action="togglePicker" data-args='["caption"]'>
              <span id="caption-model-display">${captionModel ? escHtml(captionModel) : 'Auto (use text model)\u2026'}</span>
              <span class="model-picker-arrow">&#9662;</span>
            </div>
            <div class="model-picker-dropdown hidden" id="caption-model-dropdown">
              <div class="model-picker-search-wrap">
                <input type="text" class="model-picker-search" id="caption-model-search" placeholder="Search vision models..." data-action-input="filterModels" data-args='["caption"]'>
              </div>
              <div class="model-picker-status" id="caption-model-status">Loading models...</div>
              <div class="model-picker-list" id="caption-model-list"></div>
            </div>
          </div>
          <div class="form-hint">
            <span id="caption-model-count">--</span> vision models available &middot;
            <button class="btn-link" data-action="clearCaptionModel">Clear (use text model)</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="set-explicitcontent" ${showExplicitContent ? 'checked' : ''} style="width:auto;">
            Show Explicit Content
          </label>
          <div class="form-hint">When enabled, image requests include <code>showExplicitContent: true</code>.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Image Size</label>
          <div id="imgsize-wrap">
            <select id="set-imgsize">
              <option value="${escHtml(imageSize)}">${escHtml(imageSize)}</option>
            </select>
          </div>
          <div class="form-hint" id="imgsize-hint">Image size for generated images. If options are available, they update automatically for the selected model.</div>
        </div>

        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="set-dynamicsizes" ${dynamicImageSizes ? 'checked' : ''} style="width:auto;">
            AI-Picked Panel Sizes
          </label>
          <div class="form-hint">Let the AI choose a different image size/ratio for each panel based on scene composition. The image size above is used as the fallback when the AI does not specify one. Only works when the model supports multiple sizes. <strong>Legacy pipeline only:</strong> comics using the structured planner generate every panel at the single page-wide size above (sequential page requests require one shared size); panel layout varies via composition instead.</div>
        </div>

        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="set-sequentialpages" ${enableSequentialPages ? 'checked' : ''} style="width:auto;">
            Sequential Page Generation (Seedream Sequential)
          </label>
          <div class="form-hint">When the image model is <code>seedream-v4.5-sequential</code>, generate all panels of a page in ONE ordered request. Sequential pages share one image size; mixed sizes route to per-panel requests. Leave off until the live output-order contract test has been verified for your account.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Single-Image Companion</label>
          <select id="set-companionmode" data-action-change="updateCompanionMode">
            <option value="auto" ${companion.mode === 'auto' ? 'selected' : ''}>Auto — use the recommended companion when available</option>
            <option value="same" ${companion.mode === 'same' ? 'selected' : ''}>Same — use the selected page model</option>
            <option value="custom" ${companion.mode === 'custom' ? 'selected' : ''}>Custom — use an exact model ID</option>
          </select>
          <input type="text" id="set-singleimgmodel" class="mt-sm" value="${escHtml(companion.configuredModelId)}" placeholder="e.g. seedream-v4.5" list="single-model-options" ${companion.mode === 'custom' ? '' : 'disabled'}>
          <datalist id="single-model-options"></datalist>
          <div class="form-hint">Auto maps <code>seedream-v4.5-sequential</code> to <code>seedream-v4.5</code> for independent panel requests when that model is available.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Image Request Timeout</label>
          <select id="set-imagetimeout">
            ${[2, 5, 10, 15, 20]
              .map(
                (minutes) =>
                  `<option value="${minutes * 60_000}" ${Number(imageRequestTimeoutMs) === minutes * 60_000 ? 'selected' : ''}>${minutes} minutes</option>`,
              )
              .join('')}
          </select>
          <div class="form-hint">Stops waiting for one NanoGPT image request after this limit. Completed images from other panels are still saved.</div>
        </div>

        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="set-enrichprompts" ${enrichImagePrompts ? 'checked' : ''} style="width:auto;">
            AI Prompt Enrichment
          </label>
          <div class="form-hint">When enabled, each panel image prompt is expanded by the text LLM into a detailed cinematic description (shot type, lighting, colour palette, mood) before being sent to the image model. Improves image quality at the cost of one extra LLM call per panel.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Negative Prompt</label>
          <textarea id="set-negativeprompt" rows="2" placeholder="e.g. blurry, extra limbs, watermark, text, signature, low quality" style="width:100%;resize:vertical;">${escHtml(negativePrompt)}</textarea>
          <div class="form-hint">Content to exclude from generated images. Passed to the image model as a negative prompt where supported (e.g. FLUX, Stable Diffusion models). Has no effect on models that ignore this field.</div>
        </div>

        <div class="form-group">
          <div class="form-hint">Image style presets (prompt prefixes) are managed on the <a href="#" data-navigate="image-presets">Image Style Presets</a> page. Select a preset when creating a comic.</div>
        </div>
      </div>

      <!-- Default Sampler Settings -->
      <div class="card">
        <h3 class="card-title mb-sm">Default Model Parameters</h3>

        <div class="form-group">
          <label class="form-label">Temperature: <span id="set-temp-val">${temperature}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">0</span>
            <input type="range" id="set-temp" min="0" max="2" step="0.05" value="${temperature}" oninput="document.getElementById('set-temp-val').textContent=this.value">
            <span class="text-sm text-muted">2</span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Top-P: <span id="set-topp-val">${topP}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">0</span>
            <input type="range" id="set-topp" min="0" max="1" step="0.05" value="${topP}" oninput="document.getElementById('set-topp-val').textContent=this.value">
            <span class="text-sm text-muted">1</span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Max Tokens: <span id="set-tokens-val">${maxTokens}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">256</span>
            <input type="range" id="set-tokens" min="256" max="8192" step="256" value="${maxTokens}" oninput="document.getElementById('set-tokens-val').textContent=this.value">
            <span class="text-sm text-muted">8192</span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Context Length (exchanges): <span id="set-ctx-val">${contextExchanges}</span></label>
          <div class="range-group">
            <span class="text-sm text-muted">2</span>
            <input type="range" id="set-ctx" min="2" max="20" step="1" value="${contextExchanges}" oninput="document.getElementById('set-ctx-val').textContent=this.value">
            <span class="text-sm text-muted">20</span>
          </div>
          <div class="form-hint">Number of recent story exchanges kept in context. Higher values improve story coherence but use more tokens.</div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" data-action="save">Save Settings</button>

      <!-- Data Management -->
      <div class="card mt-md">
        <h3 class="card-title mb-sm">Data Management</h3>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <button class="btn btn-secondary btn-block" data-action="exportData">Export All Data (JSON)</button>
          <button class="btn btn-secondary btn-block" onclick="document.getElementById('import-input').click()">Import Data (JSON)</button>
          <input type="file" id="import-input" accept=".json" class="hidden" data-action-change="importData">
          <button class="btn btn-secondary btn-block" data-action="clearAppCache">Clear App Cache</button>
          <button class="btn btn-danger btn-block" data-action="clearData">Clear All Data</button>
        </div>
      </div>

      <div class="card mt-md">
        <h3 class="card-title mb-sm">Reference Classification</h3>
        <p class="text-sm text-muted mb-sm">Reference images are tagged automatically so panel generation can pick the right ones.</p>
        <div class="form-group">
          <label class="form-label" for="set-classifybackend">Classifier</label>
          <select id="set-classifybackend" class="form-input">
            <option value="cloud" ${classificationBackend === 'cloud' ? 'selected' : ''}>Cloud model (recommended)</option>
            <option value="local-then-cloud" ${classificationBackend === 'local-then-cloud' ? 'selected' : ''}>On-device first, cloud if unavailable</option>
            <option value="local" ${classificationBackend === 'local' ? 'selected' : ''}>On-device only</option>
          </select>
          <div class="form-hint">The cloud model uses your caption model and sees the image itself, so it is noticeably more accurate. The on-device model (Gemini Nano, supported Android devices only) keeps images on the device but is significantly weaker.</div>
        </div>
        <p class="text-sm mb-sm">${classificationProgress.complete} / ${classificationProgress.total} completed · ${classificationProgress.pending} queued · ${classificationProgress.running} running · ${classificationProgress.failed} failed</p>
        <div id="cloud-classifier-status" class="text-sm text-muted mb-sm">Checking cloud model…</div>
        <div id="local-llm-status" class="text-sm text-muted mb-sm">Checking availability…</div>
        <button class="btn btn-secondary btn-block" id="local-llm-download-btn" data-action="downloadLocalModel">Download Local Model</button>
        <details class="mt-md" data-local-diagnostics>
          <summary>Local diagnostic log (${classificationDiagnostics.length})</summary>
          <p class="text-sm text-muted mb-sm">Stored only on this device. Export is explicit and excludes images, prompts, rosters, and world descriptions.</p>
          ${
            classificationDiagnostics.length
              ? `<ul class="text-sm text-muted">${classificationDiagnostics
                  .slice(-5)
                  .reverse()
                  .map(
                    (item) =>
                      `<li>${escHtml(new Date(item.createdAt).toLocaleString())} · ${escHtml(item.error.stage)} · ${escHtml(item.error.code)}</li>`,
                  )
                  .join('')}</ul>`
              : '<p class="text-sm text-muted">No local classifier diagnostics recorded.</p>'
          }
          <button class="btn btn-secondary btn-block" data-action="exportClassificationDiagnostics" ${classificationDiagnostics.length ? '' : 'disabled'}>Export Local Diagnostics</button>
        </details>
      </div>

      ${
        migrationPlan.worldImageCount + migrationPlan.characterImageCount > 0
          ? `<div class="card mt-md" data-migration-progress>
        <h3 class="card-title mb-sm">Legacy Reference Migration</h3>
        <p class="text-sm text-muted mb-sm">${migrationProgress?.completed || 0} / ${migrationPlan.worldImageCount + migrationPlan.characterImageCount} images converted. Progress is saved after every image.</p>
        ${unresolvedAssignments
          .map(
            ({
              characterId,
              candidateWorldIds,
            }) => `<label class="form-group"><span class="form-label">Parent world for ${escHtml(legacyCharacters.find((character) => character.id === characterId)?.name || characterId)}</span>
              <select data-migration-character="${escHtml(characterId)}">
                <option value="">Choose a world…</option>
                ${candidateWorldIds.map((worldId) => `<option value="${escHtml(worldId)}">${escHtml(legacyWorlds.find((world) => world.id === worldId)?.name || worldId)}</option>`).join('')}
              </select></label>`,
          )
          .join('')}
        <button class="btn btn-primary btn-block" data-action="runLegacyReferenceMigration">${migrationProgress?.status === 'running' ? 'Resume Migration' : 'Convert Legacy References'}</button>
      </div>`
          : ''
      }

      <!-- App Updates -->
      <div class="card mt-md">
        <h3 class="card-title mb-sm">App Updates</h3>
        <p class="text-sm text-muted mb-sm">Current version: <strong>v${APP_VERSION}</strong></p>
        <button class="btn btn-secondary btn-block" id="check-update-btn" data-action="checkForUpdate">Check for Updates</button>
        <div id="update-status" style="margin-top:10px;"></div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">Update Repository</label>
          <input type="text" id="set-update-repo" value="${escHtml(updateRepo)}" placeholder="owner/repo">
          <div class="form-hint">GitHub repo to check for updates (default: ${escHtml(DEFAULT_UPDATE_REPO)})</div>
        </div>
      </div>

      <!-- About -->
      <div class="card mt-md text-center">
        <p class="text-sm text-muted">AI Comic Creator v${APP_VERSION}</p>
        <p class="text-sm text-muted">PWA &middot; Offline Ready &middot; NanoGPT Powered</p>
      </div>
    </div>
  `;
}

/**
 * Called after the settings HTML is inserted into the DOM.
 * Model loading is handled by onMount() via the custom picker UI.
 */
function postRender(): void {
  // No-op: model loading is handled by onMount() / loadModels()
}

/**
 * Called after the settings page HTML is in the DOM.
 * Loads model lists asynchronously so the page renders instantly.
 */
async function onMount() {
  const savedCompanion = migrateCompanionSettings(
    await DB.getSetting('singleImageCompanionMode', null),
    await DB.getSetting('singleImageModel', ''),
  );
  if (savedCompanion.migrated) {
    await DB.setSetting('singleImageCompanionMode', savedCompanion.mode);
  }
  await Promise.all([loadModels('text'), loadModels('image')]);
  // After image models are loaded, auto-select the first model if none is saved
  let currentImageModel = document.getElementById('set-imgmodel')?.value;
  if (!currentImageModel && imageModels.length > 0) {
    currentImageModel = imageModels[0].id;
    const hiddenEl = document.getElementById('set-imgmodel');
    const displayEl = document.getElementById('image-model-display');
    if (hiddenEl) hiddenEl.value = currentImageModel;
    if (displayEl) displayEl.textContent = currentImageModel;
    // Update selected state in the model list
    const listEl = document.getElementById('image-model-list');
    if (listEl) {
      listEl.querySelectorAll('.model-option').forEach((el) => {
        el.classList.toggle('selected', el.dataset.modelId === currentImageModel);
      });
    }
  }
  // Rebuild the size dropdown for the current (or newly auto-selected) model
  if (currentImageModel) await updateImageSizeOptions(currentImageModel);
  updateImageModelCaps(currentImageModel);
  // Offer image models as suggestions for the single-image companion field
  const datalist = document.getElementById('single-model-options');
  if (datalist && imageModels.length > 0) {
    datalist.innerHTML = imageModels.map((m) => `<option value="${escHtml(m.id)}"></option>`).join('');
  }
  // Close dropdowns when clicking outside
  document.addEventListener('click', handleOutsideClick);
  await refreshLocalLlmStatus();
  await refreshCloudClassifierStatus();
}

async function refreshCloudClassifierStatus(): Promise<void> {
  const statusEl = document.getElementById('cloud-classifier-status');
  if (!statusEl) return;
  const ready = await API.canClassifyReferenceImages().catch(() => false);
  statusEl.textContent = ready
    ? 'Cloud model ready.'
    : 'Cloud model unavailable — set an API key and choose a vision-capable caption model above.';
}

async function refreshLocalLlmStatus(): Promise<void> {
  const { status } = await localReferenceClassifier.getAvailability();
  const statusEl = document.getElementById('local-llm-status');
  const button = document.getElementById('local-llm-download-btn');
  if (!statusEl || !button) return;
  const labels = {
    unavailable: 'This device does not support the local model.',
    downloadable: 'Model download is available. Nothing is downloaded until you choose it.',
    downloading: 'The local model is downloading.',
    available: 'Ready. New and manually reclassified references can be tagged locally.',
  };
  statusEl.textContent = labels[status] || status;
  button.classList.toggle('hidden', status === 'unavailable' || status === 'available');
  button.disabled = status === 'downloading';
}

async function downloadLocalModel(): Promise<void> {
  const button = document.getElementById('local-llm-download-btn');
  if (button) button.disabled = true;
  try {
    await localReferenceClassifier.download();
    await referenceClassificationQueue.resumeAfterLocalModelDownload();
    App.toast('Local model download started', 'info');
  } catch (error) {
    App.logError('downloadLocalModel()', error);
    App.toast('Could not start the local model download', 'error');
  }
  await refreshLocalLlmStatus();
}

async function runLegacyReferenceMigration(): Promise<void> {
  const [worlds, characters, comics] = await Promise.all([
    DB.getAll(DB.STORES.worlds),
    DB.getAll(DB.STORES.characters),
    DB.getAll(DB.STORES.comics),
  ]);
  const plan = planLegacyMigration({ worlds, characters, comics });
  const assignments = Object.fromEntries(
    characters.filter((character) => character.worldId).map((character) => [character.id, character.worldId]),
  );
  document.querySelectorAll('[data-migration-character]').forEach((select) => {
    if (select.value) assignments[select.dataset.migrationCharacter] = select.value;
  });
  await runLegacyMigration(plan, assignments, {
    listWorlds: async () => DB.getAll(DB.STORES.worlds),
    listCharacters: async () => DB.getAll(DB.STORES.characters),
    listComics: async () => DB.getAll(DB.STORES.comics),
    getAsset: (id) => referenceRepository.getAsset(id),
    putAssetAndJob: (asset, job) => referenceRepository.putAssetAndJob(asset, job),
    putWorld: (world) => DB.put(DB.STORES.worlds, world).then(() => undefined),
    putCharacter: (character) => DB.put(DB.STORES.characters, character).then(() => undefined),
    putComic: (comic) => DB.put(DB.STORES.comics, comic).then(() => undefined),
    saveProgress: (progress) => DB.setSetting('referenceMigrationProgress', progress).then(() => undefined),
    newId: DB.uuid,
    now: () => Date.now(),
  });
  void referenceClassificationQueue.run();
  App.toast('Legacy references converted', 'success');
  App.refreshPage();
}

/**
 * Display the selected image model's live capabilities: maximum input
 * (reference) images, maximum outputs per request, and supported sizes.
 */
function updateImageModelCaps(modelId: string | null | undefined): void {
  const capsEl = document.getElementById('image-model-caps');
  if (!capsEl) return;
  const m = modelId ? imageModels.find((x) => x.id === modelId) : null;
  if (!m) {
    capsEl.textContent = modelId
      ? 'Model capabilities unknown — conservative limits (1 reference, 1 output) apply until the model list refreshes.'
      : '';
    return;
  }
  const parts = [];
  parts.push(`max reference images: ${m.maxInputImages ?? 'unknown'}`);
  parts.push(`max outputs per request: ${m.maxOutputImages ?? 'unknown'}`);
  if (Array.isArray(m.sizes) && m.sizes.length > 0) parts.push(`${m.sizes.length} supported sizes`);
  capsEl.textContent = `Live capabilities — ${parts.join(' · ')}`;
}

function onUnmount(): void {
  document.removeEventListener('click', handleOutsideClick);
}

function handleOutsideClick(e: MouseEvent): void {
  if (!e.target.closest('#text-model-picker')) closePicker('text');
  if (!e.target.closest('#image-model-picker')) closePicker('image');
  if (!e.target.closest('#caption-model-picker')) closePicker('caption');
}

// --- Model Picker Logic ---

async function loadModels(type: string, forceRefresh = false): Promise<void> {
  const statusEl = document.getElementById(`${type}-model-status`);
  const countEl = document.getElementById(`${type}-model-count`);

  if (statusEl) statusEl.textContent = 'Loading models...';
  if (statusEl) statusEl.classList.remove('hidden');

  const kind = type === 'text' ? 'text' : 'image';
  const result = await loadModelCatalog(kind, forceRefresh, {
    fetchText: (fr) => API.fetchTextModels(fr),
    fetchImage: (fr) => API.fetchImageModels(fr),
    fallbackTextModelIds: API.FALLBACK_TEXT_MODELS,
    fallbackImageModelIds: API.FALLBACK_IMAGE_MODELS,
  });

  if (result.usedFallback) {
    logError(`loadModels(${type})`, result.error);
    if (statusEl) statusEl.textContent = 'Failed to load models. Using fallback list.';
  }

  try {
    if (type === 'text') {
      textModels = result.models;
      // Refresh caption models (vision-capable subset) whenever text models reload.
      captionModels = result.captionModels;
      const captionCountEl = document.getElementById('caption-model-count');
      if (captionCountEl) captionCountEl.textContent = captionModels.length;
      const captionStatusEl = document.getElementById('caption-model-status');
      if (result.usedFallback) {
        if (captionStatusEl) {
          captionStatusEl.textContent = 'Using fallback list.';
          captionStatusEl.classList.remove('hidden');
        }
      } else {
        if (captionStatusEl) captionStatusEl.classList.add('hidden');
      }
      renderModelList('caption', captionModels);
    } else {
      imageModels = result.models;
    }

    const models = type === 'text' ? textModels : imageModels;
    if (countEl) countEl.textContent = models.length;
    if (!result.usedFallback) {
      if (statusEl) statusEl.classList.add('hidden');
    }

    renderModelList(type, models);
  } catch (renderErr) {
    // Rendering a successfully-fetched catalog can still throw (e.g. a malformed upstream model
    // record reaching model-catalog.ts's extractProvider()). Recover into the same fallback UI a
    // fetch failure produces above, rather than letting the exception propagate — this restores
    // the original inline loadModels()'s single fetch-or-render try/catch blast radius.
    logError(`loadModels(${type}) render`, renderErr);
    if (statusEl) {
      statusEl.textContent = 'Failed to load models. Using fallback list.';
      statusEl.classList.remove('hidden');
    }

    // Reuse loadModelCatalog's own tested fallback path (rather than re-deriving fallback model
    // records here) by forcing it down its catch branch; forceRefresh is irrelevant since these
    // dependencies never resolve.
    const fallback = await loadModelCatalog(kind, forceRefresh, {
      fetchText: () => Promise.reject(renderErr),
      fetchImage: () => Promise.reject(renderErr),
      fallbackTextModelIds: API.FALLBACK_TEXT_MODELS,
      fallbackImageModelIds: API.FALLBACK_IMAGE_MODELS,
    });

    if (type === 'text') {
      textModels = fallback.models;
      captionModels = fallback.captionModels;
      const captionCountEl = document.getElementById('caption-model-count');
      if (captionCountEl) captionCountEl.textContent = captionModels.length;
      const captionStatusEl = document.getElementById('caption-model-status');
      if (captionStatusEl) {
        captionStatusEl.textContent = 'Using fallback list.';
        captionStatusEl.classList.remove('hidden');
      }
      renderModelList('caption', captionModels);
    } else {
      imageModels = fallback.models;
    }

    const fallbackModels = type === 'text' ? textModels : imageModels;
    if (countEl) countEl.textContent = fallbackModels.length;
    renderModelList(type, fallbackModels);
  }
}

function renderModelList(type: string, models: any[]): string {
  const listEl = document.getElementById(`${type}-model-list`);
  if (!listEl) return;

  const idMap = { text: 'set-model', image: 'set-imgmodel', caption: 'set-captionmodel' };
  const currentValue = document.getElementById(idMap[type])?.value || '';

  // Group models by provider/owned_by
  const groups = {};
  for (const m of models) {
    const provider = extractProvider(m);
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(m);
  }

  // Sort provider groups, putting popular ones first
  const providerOrder = ['openai', 'anthropic', 'google', 'meta', 'x-ai', 'deepseek', 'mistral', 'qwen', 'alibaba'];
  const sortedProviders = Object.keys(groups).sort((a, b) => {
    const ai = providerOrder.indexOf(a.toLowerCase());
    const bi = providerOrder.indexOf(b.toLowerCase());
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  let html = '';
  for (const provider of sortedProviders) {
    const providerModels = groups[provider];
    html += `<div class="model-group">`;
    html += `<div class="model-group-header">${escHtml(provider)} <span class="text-muted text-sm">(${providerModels.length})</span></div>`;
    for (const m of providerModels) {
      const isSelected = m.id === currentValue;
      const details = buildModelDetails(m);
      html += `<div class="model-option ${isSelected ? 'selected' : ''}" data-model-id="${escHtml(m.id)}" data-action="selectModel" data-args="${escHtml(JSON.stringify([type, m.id]))}">`;
      html += `<div class="model-option-name">${escHtml(m.name || m.id)}</div>`;
      if (m.name && m.name !== m.id) {
        html += `<div class="model-option-id">${escHtml(m.id)}</div>`;
      }
      if (details) {
        html += `<div class="model-option-details">${details}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  listEl.innerHTML = html || '<div class="model-picker-empty">No models found</div>';
}

/**
 * Rebuild the image size control to show only the sizes supported by modelId.
 * Renders a <select> when API-provided sizes are available, or a free-form
 * <input type="text"> when the model has no known size restrictions.
 * Called when the image model changes or on page mount after models are loaded.
 */
async function updateImageSizeOptions(modelId: string): Promise<void> {
  const wrap = document.getElementById('imgsize-wrap');
  if (!wrap || !modelId) return;

  const currentEl = document.getElementById('set-imgsize');
  const currentSize = currentEl?.value || (await DB.getSetting('imageSize', '1024x1024'));
  const sizes = await API.getModelSizes(modelId);

  if (!sizes || sizes.length === 0) {
    // Sizes unknown for this model – let the user enter any value freely
    wrap.innerHTML = `<input type="text" id="set-imgsize" value="${escHtml(currentSize)}" placeholder="e.g. 1024x1024" pattern="\\d+x\\d+">`;
    return;
  }

  wrap.innerHTML = `<select id="set-imgsize">${sizes
    .map((s) => `<option value="${escHtml(s)}" ${s === currentSize ? 'selected' : ''}>${escHtml(s)}</option>`)
    .join('')}</select>`;

  // If the saved size isn't valid for this model, auto-select the first supported
  const sizeEl = document.getElementById('set-imgsize');
  if (!sizes.includes(currentSize)) {
    sizeEl.value = sizes[0];
    App.toast(`Image size auto-set to ${sizes[0]} for this model`, 'info');
  }
}

function togglePicker(type: string): void {
  const dropdown = document.getElementById(`${type}-model-dropdown`);
  const isOpen = !dropdown.classList.contains('hidden');
  // Close all other pickers
  const allTypes = ['text', 'image', 'caption'];
  for (const t of allTypes) {
    if (t !== type) closePicker(t);
  }
  if (isOpen) {
    dropdown.classList.add('hidden');
  } else {
    dropdown.classList.remove('hidden');
    const search = document.getElementById(`${type}-model-search`);
    if (search) {
      search.value = '';
      search.focus();
    }
    // Reset filter
    filterModels(type, search);
  }
}

function closePicker(type: string): void {
  const dropdown = document.getElementById(`${type}-model-dropdown`);
  if (dropdown) dropdown.classList.add('hidden');
}

function filterModels(type: string, input: any): void {
  const query = input?.value || '';
  const models = type === 'text' ? textModels : type === 'caption' ? captionModels : imageModels;
  const q = query.toLowerCase().trim();
  if (!q) {
    renderModelList(type, models);
    return;
  }
  const filtered = models.filter((m) => {
    const searchStr = `${m.id} ${m.name || ''} ${m.owned_by || ''}`.toLowerCase();
    return searchStr.includes(q);
  });
  renderModelList(type, filtered);

  // Update status if no results
  const statusEl = document.getElementById(`${type}-model-status`);
  if (filtered.length === 0 && statusEl) {
    statusEl.textContent = `No models matching "${query}"`;
    statusEl.classList.remove('hidden');
  } else if (statusEl) {
    statusEl.classList.add('hidden');
  }
}

function selectModel(type: string, modelId: string): void {
  if (type === 'text') {
    document.getElementById('set-model').value = modelId;
    document.getElementById('text-model-display').textContent = modelId;
  } else if (type === 'image') {
    document.getElementById('set-imgmodel').value = modelId;
    document.getElementById('image-model-display').textContent = modelId;
    // Dynamically update allowed sizes for the newly selected image model
    updateImageSizeOptions(modelId);
    updateImageModelCaps(modelId);
  } else if (type === 'caption') {
    document.getElementById('set-captionmodel').value = modelId;
    document.getElementById('caption-model-display').textContent = modelId;
  }
  closePicker(type);

  // Update selected state in the list
  const listEl = document.getElementById(`${type}-model-list`);
  if (listEl) {
    listEl.querySelectorAll('.model-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.modelId === modelId);
    });
  }
}

function updateCompanionMode(): void {
  const mode = document.getElementById('set-companionmode')?.value || 'auto';
  const custom = document.getElementById('set-singleimgmodel');
  if (custom) custom.disabled = mode !== 'custom';
}

async function refreshModels(type: string): Promise<void> {
  App.toast(`Refreshing ${type} model list...`, 'info');
  await loadModels(type, true);
  App.toast(`${type === 'text' ? 'Text' : 'Image'} models refreshed!`, 'success');
  if (type === 'image') {
    const currentImageModel = document.getElementById('set-imgmodel')?.value;
    if (currentImageModel) await updateImageSizeOptions(currentImageModel);
  }
}

/** Clear the caption model selection, reverting to "Auto (use text model)". */
function clearCaptionModel() {
  const hiddenEl = document.getElementById('set-captionmodel');
  const displayEl = document.getElementById('caption-model-display');
  if (hiddenEl) hiddenEl.value = '';
  if (displayEl) displayEl.textContent = 'Auto (use text model)\u2026';
  const listEl = document.getElementById('caption-model-list');
  if (listEl) listEl.querySelectorAll('.model-option').forEach((el) => el.classList.remove('selected'));
  closePicker('caption');
}

// --- API Connection Test ---

async function testConnection() {
  const apiKey = document.getElementById('set-apikey').value.trim();
  if (!apiKey) return App.toast('Enter an API key first', 'error');

  const btn = document.getElementById('test-conn-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Testing\u2026';
  }

  try {
    const model = document.getElementById('set-model')?.value || 'gpt-4o-mini';
    const res = await fetch(`${API.BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${res.status}`);
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || '(no reply)';
    App.toast(`Connection OK \u2014 AI replied: \u201c${reply}\u201d`, 'success');
  } catch (e) {
    logError('testConnection()', e, `Model: ${document.getElementById('set-model')?.value || 'unknown'}`);
    App.toast(`Connection failed: ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Test Connection';
    }
  }
}

// --- Update Check ---

async function checkForUpdate() {
  const statusEl = document.getElementById('update-status');
  if (!statusEl) return;

  const btn = document.getElementById('check-update-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking\u2026';
  }

  statusEl.innerHTML = '<p class="text-sm text-muted">Checking for updates...</p>';

  // Save repo setting if changed (validate format to prevent URL injection)
  const repoInput = document.getElementById('set-update-repo');
  const repo = (repoInput?.value || '').trim() || DEFAULT_UPDATE_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    statusEl.innerHTML =
      '<p class="text-sm" style="color:var(--danger);">Invalid repository format. Use owner/repo (e.g. user/project).</p>';
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check for Updates';
    }
    return;
  }
  await DB.setSetting('updateRepo', repo);

  // Resolve the actual installed version from local version.json so the check
  // stays accurate even after update.sh updates version.json without reloading
  // the page (avoids stale hardcoded APP_VERSION constant causing false positives).
  let localVersion = APP_VERSION;
  try {
    const localRes = await fetch(`/version.json?_=${Date.now()}`);
    if (localRes.ok) {
      const localData = await localRes.json();
      if (localData.version) localVersion = localData.version;
    }
  } catch (_) {
    /* fall back to hardcoded APP_VERSION */
  }

  try {
    // Detect the repository's default branch so the check works regardless of
    // whether the repo uses 'main', 'Main', 'master', etc.
    // Uses the unauthenticated GitHub API (60 req/hr per IP), which is ample
    // for a manual "Check for Updates" button.
    // Fallback is 'Main' (capital M) — matches the default branch of the
    // DEFAULT_UPDATE_REPO; raw.githubusercontent.com URLs are case-sensitive.
    let branch = 'Main';
    try {
      const infoRes = await fetch(`https://api.github.com/repos/${repo}`);
      if (infoRes.ok) {
        const info = await infoRes.json();
        branch = info.default_branch || 'Main';
      }
    } catch (_) {
      /* use fallback branch name */
    }

    const url = `https://raw.githubusercontent.com/${repo}/${branch}/version.json?_=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = await res.json();

    if (!remote.version) throw new Error('Invalid version data');

    const cmp = compareVersions(remote.version, localVersion);
    if (cmp > 0) {
      statusEl.innerHTML = `
        <div style="padding:10px;border-radius:8px;background:rgba(255,193,7,0.15);border:1px solid rgba(255,193,7,0.3);">
          <p class="text-sm" style="color:#ffc107;margin:0 0 4px 0;"><strong>Update available: v${escHtml(remote.version)}</strong></p>
          <p class="text-sm text-muted" style="margin:0 0 8px 0;">You have v${escHtml(localVersion)}. Use the button below to clear the cache and load the latest version.</p>
          <button class="btn btn-primary btn-sm" data-action="reloadForUpdate">Reload &amp; Apply Update</button>
        </div>`;
      App.toast(`Update available: v${remote.version}`, 'info');
    } else {
      statusEl.innerHTML = `
        <div style="padding:10px;border-radius:8px;background:rgba(76,175,80,0.15);border:1px solid rgba(76,175,80,0.3);">
          <p class="text-sm" style="color:#4caf50;margin:0;"><strong>You're up to date! (v${escHtml(localVersion)})</strong></p>
        </div>`;
      App.toast("You're running the latest version!", 'success');
    }
  } catch (e) {
    logError('checkForUpdate()', e, `Repo: ${repo}`);
    statusEl.innerHTML = `
      <div style="padding:10px;border-radius:8px;background:rgba(244,67,54,0.15);border:1px solid rgba(244,67,54,0.3);">
        <p class="text-sm" style="color:#f44336;margin:0 0 4px 0;"><strong>Could not check for updates</strong></p>
        <p class="text-sm text-muted" style="margin:0;">Are you online? (${escHtml(e.message)})</p>
      </div>`;
    App.toast('Update check failed', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check for Updates';
    }
  }
}

async function reloadForUpdate() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (_) {
    /* proceed to reload even if cache clear fails */
  }
  window.location.reload();
}

async function clearAppCache() {
  if (!('caches' in window)) {
    return App.toast('Cache API not available in this browser', 'error');
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    App.toast('App cache cleared! Reload the page to fetch fresh assets.', 'success');
  } catch (e) {
    logError('clearAppCache()', e);
    App.toast(`Failed to clear cache: ${e.message}`, 'error');
  }
}

// --- Save / Export / Import / Clear ---

async function save() {
  const apiKey = document.getElementById('set-apikey').value.trim();
  if (!apiKey) return App.toast('API key is required', 'error');

  await DB.setSetting('apiKey', apiKey);
  await DB.setSetting('model', document.getElementById('set-model').value);
  await DB.setSetting('imageModel', document.getElementById('set-imgmodel').value);
  await DB.setSetting('enableImages', document.getElementById('set-enableimgs').checked);
  await DB.setSetting('useRefImages', document.getElementById('set-userefimgs').checked);
  await DB.setSetting('includeAppearanceText', document.getElementById('set-includeappearance').checked);
  await DB.setSetting('captionModel', document.getElementById('set-captionmodel').value);
  await DB.setSetting('classificationBackend', document.getElementById('set-classifybackend').value);

  await DB.setSetting('showExplicitContent', document.getElementById('set-explicitcontent').checked);
  await DB.setSetting('dynamicImageSizes', document.getElementById('set-dynamicsizes').checked);
  await DB.setSetting('enrichImagePrompts', document.getElementById('set-enrichprompts').checked);
  await DB.setSetting('enableSequentialPages', document.getElementById('set-sequentialpages').checked);
  await DB.setSetting('singleImageCompanionMode', document.getElementById('set-companionmode').value);
  await DB.setSetting('singleImageModel', document.getElementById('set-singleimgmodel').value.trim());
  await DB.setSetting('imageRequestTimeoutMs', Number(document.getElementById('set-imagetimeout').value));
  await DB.setSetting('negativePrompt', document.getElementById('set-negativeprompt').value.trim());
  const sizeEl = document.getElementById('set-imgsize');
  const imageSizeVal = sizeEl.value.trim();
  if (!imageSizeVal) {
    return App.toast('Image size is required', 'error');
  }
  // Only enforce WxH format for the free-text input; trust API-provided select values
  if (sizeEl.tagName === 'INPUT' && !/^\d+x\d+$/.test(imageSizeVal)) {
    return App.toast('Image size must be in WIDTHxHEIGHT format (e.g. 1024x1024)', 'error');
  }
  await DB.setSetting('imageSize', imageSizeVal);
  await DB.setSetting('temperature', parseFloat(document.getElementById('set-temp').value));
  await DB.setSetting('topP', parseFloat(document.getElementById('set-topp').value));
  await DB.setSetting('maxTokens', parseInt(document.getElementById('set-tokens').value));
  await DB.setSetting('contextExchanges', parseInt(document.getElementById('set-ctx').value));

  const repoInput = document.getElementById('set-update-repo');
  if (repoInput) await DB.setSetting('updateRepo', repoInput.value.trim() || DEFAULT_UPDATE_REPO);

  App.toast('Settings saved!', 'success');
}

async function exportData() {
  const data = await buildBackup({
    stores: DB.STORES,
    getAll: async (storeName) => {
      const records = await DB.getAll(storeName);
      return storeName === DB.STORES.pages ? prepareExportPages(records) : records;
    },
    put: DB.put,
  });
  await saveBackupFile(data);
}

async function exportClassificationDiagnostics(): Promise<void> {
  try {
    const diagnostics = await referenceRepository.listDiagnostics();
    if (!diagnostics.length) return App.toast('No local classifier diagnostics to export', 'info');
    const delivery = await exportFile({
      filename: `comic-creator-local-diagnostics-${Date.now()}.json`,
      mimeType: 'application/json',
      data: JSON.stringify(buildDiagnosticExport(diagnostics)),
      title: 'Comic Creator Local Diagnostics',
    });
    App.toast(
      delivery === 'share' ? 'Share sheet opened for local diagnostics' : 'Local diagnostics exported',
      'success',
    );
  } catch (error) {
    logError('exportClassificationDiagnostics()', error);
    App.toast('Could not export local diagnostics', 'error');
  }
}

async function importData(input: any): Promise<void> {
  const file = input.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const payload = parseBackup(text);
    await importBackup(payload, {
      stores: DB.STORES,
      put: DB.put,
      putBatch: DB.putBatch,
    });

    App.toast('Data imported!', 'success');
    App.refreshPage();
  } catch (e) {
    logError('importData()', e, `File: ${file?.name || 'unknown'}`);
    App.toast('Invalid backup file', 'error');
  }
}

function clearData() {
  App.showModal(`
    <div class="modal-title">Clear All Data</div>
    <p>This will permanently delete all your characters, worlds, comics, and presets. This cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
      <button class="btn btn-danger btn-sm" data-action="confirmClear">Delete Everything</button>
    </div>
  `);
}

async function confirmClear() {
  const stores = [
    DB.STORES.characters,
    DB.STORES.worlds,
    DB.STORES.locations,
    DB.STORES.referenceAssets,
    DB.STORES.classificationJobs,
    DB.STORES.comics,
    DB.STORES.pages,
    DB.STORES.presets,
    DB.STORES.imagePresets,
  ];
  for (const store of stores) {
    const items = await DB.getAll(store);
    for (const item of items) await DB.del(store, item.id);
  }
  App.hideModal();
  App.toast('All data cleared', 'info');
  App.refreshPage();
}

const SettingsPage: PageModule & Record<string, any> = {
  render,
  postRender,
  onMount,
  onUnmount,
  testConnection,
  save,
  exportData,
  exportClassificationDiagnostics,
  importData,
  clearData,
  confirmClear,
  togglePicker,
  closePicker,
  filterModels,
  selectModel,
  updateCompanionMode,
  refreshModels,
  clearCaptionModel,
  updateImageSizeOptions,
  checkForUpdate,
  reloadForUpdate,
  clearAppCache,
  downloadLocalModel,
  runLegacyReferenceMigration,
};
export default SettingsPage;
