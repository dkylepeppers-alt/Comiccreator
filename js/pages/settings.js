/**
 * Settings Page
 * Dynamically loads all available text and image models from NanoGPT API.
 */
const SettingsPage = (() => {
  const APP_VERSION = '1.6.4';
  const DEFAULT_UPDATE_REPO = 'dkylepeppers-alt/Comiccreator';

  // In-memory model lists populated on render
  let textModels = [];
  let imageModels = [];
  let textModelsLoading = false;
  let imageModelsLoading = false;

  // Delegate error logging to global App.logError
  function logError(context, error, extraDetails) {
    App.logError(context, error, extraDetails);
  }

  async function render() {
    const apiKey = await DB.getSetting('apiKey', '');
    const model = await DB.getSetting('model', 'gpt-4o-mini');
    const imageModel = await DB.getSetting('imageModel', 'gpt-image-1');
    const temperature = await DB.getSetting('temperature', 0.7);
    const topP = await DB.getSetting('topP', 0.9);
    const maxTokens = await DB.getSetting('maxTokens', 2048);
    const enableImages = await DB.getSetting('enableImages', true);
    const useRefImages = await DB.getSetting('useRefImages', true);
    const showExplicitContent = await DB.getSetting('showExplicitContent', false);
    const imageSize = await DB.getSetting('imageSize', '1024x1024');
    const imagePromptPrefix = await DB.getSetting('imagePromptPrefix', '');
    const updateRepo = await DB.getSetting('updateRepo', DEFAULT_UPDATE_REPO);

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
            <button class="btn btn-secondary btn-sm" id="test-conn-btn" onclick="SettingsPage.testConnection()" style="margin-top:8px;">Test Connection</button>
          </div>

          <!-- Text Model Picker -->
          <div class="form-group">
            <label class="form-label">Text Model</label>
            <input type="hidden" id="set-model" value="${escHtml(model)}">
            <div class="model-picker" id="text-model-picker">
              <div class="model-picker-selected" onclick="SettingsPage.togglePicker('text')">
                <span id="text-model-display">${escHtml(model)}</span>
                <span class="model-picker-arrow">&#9662;</span>
              </div>
              <div class="model-picker-dropdown hidden" id="text-model-dropdown">
                <div class="model-picker-search-wrap">
                  <input type="text" class="model-picker-search" id="text-model-search" placeholder="Search 500+ models..." oninput="SettingsPage.filterModels('text', this.value)">
                </div>
                <div class="model-picker-status" id="text-model-status">Loading models...</div>
                <div class="model-picker-list" id="text-model-list"></div>
              </div>
            </div>
            <div class="form-hint">
              <span id="text-model-count">--</span> models available &middot;
              <button class="btn-link" onclick="SettingsPage.refreshModels('text')">Refresh list</button>
            </div>
          </div>

          <!-- Image Model Picker -->
          <div class="form-group">
            <label class="form-label">Image Model</label>
            <input type="hidden" id="set-imgmodel" value="${escHtml(imageModel)}">
            <div class="model-picker" id="image-model-picker">
              <div class="model-picker-selected" onclick="SettingsPage.togglePicker('image')">
                <span id="image-model-display">${escHtml(imageModel)}</span>
                <span class="model-picker-arrow">&#9662;</span>
              </div>
              <div class="model-picker-dropdown hidden" id="image-model-dropdown">
                <div class="model-picker-search-wrap">
                  <input type="text" class="model-picker-search" id="image-model-search" placeholder="Search image models..." oninput="SettingsPage.filterModels('image', this.value)">
                </div>
                <div class="model-picker-status" id="image-model-status">Loading models...</div>
                <div class="model-picker-list" id="image-model-list"></div>
              </div>
            </div>
            <div class="form-hint">
              <span id="image-model-count">--</span> models available &middot;
              <button class="btn-link" onclick="SettingsPage.refreshModels('image')">Refresh list</button>
            </div>
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
            <label class="form-label">Image Prompt Prefix</label>
            <input type="text" id="set-imgprefix" value="${escHtml(imagePromptPrefix)}" placeholder="e.g. detailed 2d illustration, ultra detailed Pixar style">
            <div class="form-hint">Text prepended to every image prompt for consistent art style</div>
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
        </div>

        <button class="btn btn-primary btn-block" onclick="SettingsPage.save()">Save Settings</button>

        <!-- Data Management -->
        <div class="card mt-md">
          <h3 class="card-title mb-sm">Data Management</h3>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="btn btn-secondary btn-block" onclick="SettingsPage.exportData()">Export All Data (JSON)</button>
            <button class="btn btn-secondary btn-block" onclick="document.getElementById('import-input').click()">Import Data (JSON)</button>
            <input type="file" id="import-input" accept=".json" class="hidden" onchange="SettingsPage.importData(event)">
            <button class="btn btn-secondary btn-block" onclick="SettingsPage.clearAppCache()">Clear App Cache</button>
            <button class="btn btn-danger btn-block" onclick="SettingsPage.clearData()">Clear All Data</button>
          </div>
        </div>

        <!-- App Updates -->
        <div class="card mt-md">
          <h3 class="card-title mb-sm">App Updates</h3>
          <p class="text-sm text-muted mb-sm">Current version: <strong>v${APP_VERSION}</strong></p>
          <button class="btn btn-secondary btn-block" id="check-update-btn" onclick="SettingsPage.checkForUpdate()">Check for Updates</button>
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
  function postRender() {
    // No-op: model loading is handled by onMount() / loadModels()
  }

  /**
   * Called after the settings page HTML is in the DOM.
   * Loads model lists asynchronously so the page renders instantly.
   */
  async function onMount() {
    await Promise.all([
      loadModels('text'),
      loadModels('image'),
    ]);
    // After image models are loaded, rebuild the size dropdown for the current model
    const currentImageModel = document.getElementById('set-imgmodel')?.value;
    if (currentImageModel) await updateImageSizeOptions(currentImageModel);
    // Close dropdowns when clicking outside
    document.addEventListener('click', handleOutsideClick);
  }

  function onUnmount() {
    document.removeEventListener('click', handleOutsideClick);
  }

  function handleOutsideClick(e) {
    if (!e.target.closest('#text-model-picker')) closePicker('text');
    if (!e.target.closest('#image-model-picker')) closePicker('image');
  }

  // --- Model Picker Logic ---

  async function loadModels(type, forceRefresh = false) {
    const statusEl = document.getElementById(`${type}-model-status`);
    const countEl = document.getElementById(`${type}-model-count`);

    if (statusEl) statusEl.textContent = 'Loading models...';
    if (statusEl) statusEl.classList.remove('hidden');

    try {
      if (type === 'text') {
        textModelsLoading = true;
        textModels = await API.fetchTextModels(forceRefresh);
        textModelsLoading = false;
      } else {
        imageModelsLoading = true;
        imageModels = await API.fetchImageModels(forceRefresh);
        imageModelsLoading = false;
      }

      const models = type === 'text' ? textModels : imageModels;
      if (countEl) countEl.textContent = models.length;
      if (statusEl) statusEl.classList.add('hidden');

      renderModelList(type, models);
    } catch (err) {
      logError(`loadModels(${type})`, err);
      if (statusEl) statusEl.textContent = 'Failed to load models. Using fallback list.';
      const fallback = type === 'text'
        ? API.FALLBACK_TEXT_MODELS.map(id => ({ id, name: id, owned_by: '' }))
        : API.FALLBACK_IMAGE_MODELS.map(id => ({ id, name: id, owned_by: '' }));

      if (type === 'text') textModels = fallback;
      else imageModels = fallback;

      if (countEl) countEl.textContent = fallback.length;
      renderModelList(type, fallback);
    }
  }

  function renderModelList(type, models) {
    const listEl = document.getElementById(`${type}-model-list`);
    if (!listEl) return;

    const currentValue = document.getElementById(type === 'text' ? 'set-model' : 'set-imgmodel')?.value || '';

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
        html += `<div class="model-option ${isSelected ? 'selected' : ''}" data-model-id="${escHtml(m.id)}" onclick="SettingsPage.selectModel('${type}', '${escHtml(m.id)}')">`;
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

  function extractProvider(model) {
    // Try owned_by first
    if (model.owned_by) return model.owned_by;
    // Try to extract from model id (e.g. "openai/gpt-4o" -> "openai")
    const slashIdx = model.id.indexOf('/');
    if (slashIdx > 0) return model.id.substring(0, slashIdx);
    // Guess from common prefixes
    const id = model.id.toLowerCase();
    if (id.startsWith('gpt-') || id.startsWith('chatgpt') || id.startsWith('dall-e') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'OpenAI';
    if (id.startsWith('claude')) return 'Anthropic';
    if (id.startsWith('gemini')) return 'Google';
    if (id.startsWith('llama') || id.startsWith('meta-llama')) return 'Meta';
    if (id.startsWith('mistral') || id.startsWith('codestral') || id.startsWith('pixtral')) return 'Mistral';
    if (id.startsWith('deepseek')) return 'DeepSeek';
    if (id.startsWith('grok')) return 'xAI';
    if (id.startsWith('qwen')) return 'Qwen';
    if (id.startsWith('command')) return 'Cohere';
    if (id.startsWith('flux') || id.startsWith('schnell')) return 'Black Forest Labs';
    if (id.startsWith('stable-diffusion') || id.startsWith('sdxl') || id.startsWith('sd3')) return 'Stability AI';
    if (id.startsWith('yi-')) return '01.AI';
    if (id.startsWith('phi-')) return 'Microsoft';
    if (id.startsWith('nova-') || id.startsWith('amazon')) return 'Amazon';
    if (id.startsWith('glm')) return 'Zhipu';
    if (id.startsWith('kimi')) return 'Moonshot';
    if (id.startsWith('hidream')) return 'HiDream';
    if (id.startsWith('midjourney')) return 'Midjourney';
    return 'Other';
  }

  function buildModelDetails(m) {
    const parts = [];
    if (m.context_length) parts.push(`${(m.context_length / 1000).toFixed(0)}K ctx`);
    if (m.supports_vision) parts.push('vision');
    if (m.supports_tools) parts.push('tools');
    if (m.supports_edit) parts.push('edit');
    if (m.pricing) {
      if (typeof m.pricing === 'object') {
        if (m.pricing.prompt) parts.push(`$${m.pricing.prompt}/1K in`);
      } else if (typeof m.pricing === 'string') {
        parts.push(m.pricing);
      }
    }
    return parts.length > 0 ? parts.join(' &middot; ') : '';
  }

  /**
   * Rebuild the image size control to show only the sizes supported by modelId.
   * Renders a <select> when API-provided sizes are available, or a free-form
   * <input type="text"> when the model has no known size restrictions.
   * Called when the image model changes or on page mount after models are loaded.
   */
  async function updateImageSizeOptions(modelId) {
    const wrap = document.getElementById('imgsize-wrap');
    if (!wrap || !modelId) return;

    const currentEl = document.getElementById('set-imgsize');
    const currentSize = currentEl?.value || await DB.getSetting('imageSize', '1024x1024');
    const sizes = await API.getModelSizes(modelId);

    if (!sizes || sizes.length === 0) {
      // Sizes unknown for this model – let the user enter any value freely
      wrap.innerHTML = `<input type="text" id="set-imgsize" value="${escHtml(currentSize)}" placeholder="e.g. 1024x1024" pattern="\\d+x\\d+">`;
      return;
    }

    wrap.innerHTML = `<select id="set-imgsize">${sizes
      .map(s => `<option value="${escHtml(s)}" ${s === currentSize ? 'selected' : ''}>${escHtml(s)}</option>`)
      .join('')}</select>`;

    // If the saved size isn't valid for this model, auto-select the first supported
    const sizeEl = document.getElementById('set-imgsize');
    if (!sizes.includes(currentSize)) {
      sizeEl.value = sizes[0];
      App.toast(`Image size auto-set to ${sizes[0]} for this model`, 'info');
    }
  }

  function togglePicker(type) {
    const dropdown = document.getElementById(`${type}-model-dropdown`);
    const isOpen = !dropdown.classList.contains('hidden');
    // Close the other picker
    closePicker(type === 'text' ? 'image' : 'text');
    if (isOpen) {
      dropdown.classList.add('hidden');
    } else {
      dropdown.classList.remove('hidden');
      const search = document.getElementById(`${type}-model-search`);
      if (search) { search.value = ''; search.focus(); }
      // Reset filter
      filterModels(type, '');
    }
  }

  function closePicker(type) {
    const dropdown = document.getElementById(`${type}-model-dropdown`);
    if (dropdown) dropdown.classList.add('hidden');
  }

  function filterModels(type, query) {
    const models = type === 'text' ? textModels : imageModels;
    const q = query.toLowerCase().trim();
    if (!q) {
      renderModelList(type, models);
      return;
    }
    const filtered = models.filter(m => {
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

  function selectModel(type, modelId) {
    if (type === 'text') {
      document.getElementById('set-model').value = modelId;
      document.getElementById('text-model-display').textContent = modelId;
    } else {
      document.getElementById('set-imgmodel').value = modelId;
      document.getElementById('image-model-display').textContent = modelId;
      // Dynamically update allowed sizes for the newly selected image model
      updateImageSizeOptions(modelId);
    }
    closePicker(type);

    // Update selected state in the list
    const listEl = document.getElementById(`${type}-model-list`);
    if (listEl) {
      listEl.querySelectorAll('.model-option').forEach(el => {
        el.classList.toggle('selected', el.dataset.modelId === modelId);
      });
    }
  }

  async function refreshModels(type) {
    App.toast(`Refreshing ${type} model list...`, 'info');
    await loadModels(type, true);
    App.toast(`${type === 'text' ? 'Text' : 'Image'} models refreshed!`, 'success');
    if (type === 'image') {
      const currentImageModel = document.getElementById('set-imgmodel')?.value;
      if (currentImageModel) await updateImageSizeOptions(currentImageModel);
    }
  }

  // --- API Connection Test ---

  async function testConnection() {
    const apiKey = document.getElementById('set-apikey').value.trim();
    if (!apiKey) return App.toast('Enter an API key first', 'error');

    const btn = document.getElementById('test-conn-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Testing\u2026'; }

    try {
      const model = document.getElementById('set-model')?.value || 'gpt-4o-mini';
      const res = await fetch(`${API.BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
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
      if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
    }
  }

  // --- Update Check ---

  function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  async function checkForUpdate() {
    const statusEl = document.getElementById('update-status');
    if (!statusEl) return;

    const btn = document.getElementById('check-update-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking\u2026'; }

    statusEl.innerHTML = '<p class="text-sm text-muted">Checking for updates...</p>';

    // Save repo setting if changed (validate format to prevent URL injection)
    const repoInput = document.getElementById('set-update-repo');
    const repo = (repoInput?.value || '').trim() || DEFAULT_UPDATE_REPO;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      statusEl.innerHTML = '<p class="text-sm" style="color:var(--danger);">Invalid repository format. Use owner/repo (e.g. user/project).</p>';
      if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
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
    } catch (_) { /* fall back to hardcoded APP_VERSION */ }

    try {
      const url = `https://raw.githubusercontent.com/${repo}/master/version.json?_=${Date.now()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = await res.json();

      if (!remote.version) throw new Error('Invalid version data');

      const cmp = compareVersions(remote.version, localVersion);
      if (cmp > 0) {
        statusEl.innerHTML = `
          <div style="padding:10px;border-radius:8px;background:rgba(255,193,7,0.15);border:1px solid rgba(255,193,7,0.3);">
            <p class="text-sm" style="color:#ffc107;margin:0 0 4px 0;"><strong>Update available: v${escHtml(remote.version)}</strong></p>
            <p class="text-sm text-muted" style="margin:0 0 8px 0;">You have v${escHtml(localVersion)}. Run <code>./update.sh</code> in Termux, then reload.</p>
            <button class="btn btn-primary btn-sm" onclick="SettingsPage.reloadForUpdate()">Reload &amp; Apply Update</button>
          </div>`;
        App.toast(`Update available: v${remote.version}`, 'info');
      } else {
        statusEl.innerHTML = `
          <div style="padding:10px;border-radius:8px;background:rgba(76,175,80,0.15);border:1px solid rgba(76,175,80,0.3);">
            <p class="text-sm" style="color:#4caf50;margin:0;"><strong>You're up to date! (v${escHtml(localVersion)})</strong></p>
          </div>`;
        App.toast('You\'re running the latest version!', 'success');
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
      if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
    }
  }

  async function reloadForUpdate() {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
      }
    } catch (_) { /* proceed to reload even if cache clear fails */ }
    window.location.reload();
  }

  async function clearAppCache() {
    if (!('caches' in window)) {
      return App.toast('Cache API not available in this browser', 'error');
    }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
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
    await DB.setSetting('showExplicitContent', document.getElementById('set-explicitcontent').checked);
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
    await DB.setSetting('imagePromptPrefix', document.getElementById('set-imgprefix').value.trim());
    await DB.setSetting('temperature', parseFloat(document.getElementById('set-temp').value));
    await DB.setSetting('topP', parseFloat(document.getElementById('set-topp').value));
    await DB.setSetting('maxTokens', parseInt(document.getElementById('set-tokens').value));

    const repoInput = document.getElementById('set-update-repo');
    if (repoInput) await DB.setSetting('updateRepo', repoInput.value.trim() || DEFAULT_UPDATE_REPO);

    App.toast('Settings saved!', 'success');
  }

  async function exportData() {
    const data = {
      characters: await DB.getAll(DB.STORES.characters),
      worlds: await DB.getAll(DB.STORES.worlds),
      comics: await DB.getAll(DB.STORES.comics),
      pages: await DB.getAll(DB.STORES.pages),
      presets: await DB.getAll(DB.STORES.presets),
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comic-creator-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    App.toast('Data exported!', 'success');
  }

  async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate imported data: each collection must be an array of objects with id fields
      const validArray = (arr) => Array.isArray(arr) && arr.every(item => item && typeof item === 'object' && item.id);
      if (data.characters && !validArray(data.characters)) throw new Error('Invalid characters data');
      if (data.worlds && !validArray(data.worlds)) throw new Error('Invalid worlds data');
      if (data.comics && !validArray(data.comics)) throw new Error('Invalid comics data');
      if (data.pages && !validArray(data.pages)) throw new Error('Invalid pages data');
      if (data.presets && !validArray(data.presets)) throw new Error('Invalid presets data');

      if (data.characters) for (const c of data.characters) await DB.put(DB.STORES.characters, c);
      if (data.worlds) for (const w of data.worlds) await DB.put(DB.STORES.worlds, w);
      if (data.comics) for (const c of data.comics) await DB.put(DB.STORES.comics, c);
      if (data.pages) for (const p of data.pages) await DB.put(DB.STORES.pages, p);
      if (data.presets) for (const p of data.presets) await DB.put(DB.STORES.presets, p);

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
        <button class="btn btn-danger btn-sm" onclick="SettingsPage.confirmClear()">Delete Everything</button>
      </div>
    `);
  }

  async function confirmClear() {
    const stores = [DB.STORES.characters, DB.STORES.worlds, DB.STORES.comics, DB.STORES.pages, DB.STORES.presets];
    for (const store of stores) {
      const items = await DB.getAll(store);
      for (const item of items) await DB.del(store, item.id);
    }
    App.hideModal();
    App.toast('All data cleared', 'info');
    App.refreshPage();
  }

  return {
    render, postRender, onMount, onUnmount,
    testConnection, save, exportData, importData, clearData, confirmClear,
    togglePicker, closePicker, filterModels, selectModel, refreshModels,
    updateImageSizeOptions, checkForUpdate, reloadForUpdate, clearAppCache,
  };
})();
