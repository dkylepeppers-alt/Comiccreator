/**
 * Settings Page
 */
const SettingsPage = (() => {

  async function render() {
    const apiKey = await DB.getSetting('apiKey', '');
    const model = await DB.getSetting('model', 'gpt-4o-mini');
    const imageModel = await DB.getSetting('imageModel', 'gpt-image-1');
    const temperature = await DB.getSetting('temperature', 0.7);
    const topP = await DB.getSetting('topP', 0.9);
    const maxTokens = await DB.getSetting('maxTokens', 2048);
    const enableImages = await DB.getSetting('enableImages', true);
    const imageSize = await DB.getSetting('imageSize', '1024x1024');

    // Fallback models used when the API is unreachable
    const fallbackTextModels = [
      'gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano',
      'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
      'deepseek-chat', 'deepseek-reasoner',
      'gemini-2.0-flash', 'gemini-2.5-pro-preview-05-06',
      'llama-3.3-70b', 'mistral-large-latest',
    ];

    const fallbackImageModels = [
      'gpt-image-1', 'dall-e-3', 'flux-1.1-pro', 'stable-diffusion-xl',
    ];

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
          </div>

          <div class="form-group">
            <label class="form-label">Text Model</label>
            <select id="set-model">
              ${fallbackTextModels.map(m => `<option value="${m}" ${model === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
            <div class="form-hint">Model used for story generation &mdash; <span id="model-count"></span></div>
          </div>

          <div class="form-group">
            <label class="form-label">Image Model</label>
            <select id="set-imgmodel">
              ${fallbackImageModels.map(m => `<option value="${m}" ${imageModel === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
            <div class="form-hint">Model used for panel images &mdash; <span id="imgmodel-count"></span></div>
          </div>

          <div class="form-group">
            <label class="form-label" style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="set-enableimgs" ${enableImages ? 'checked' : ''} style="width:auto;">
              Enable AI Image Generation
            </label>
            <div class="form-hint">Disable to save API credits (text-only comics)</div>
          </div>

          <div class="form-group">
            <label class="form-label">Image Size</label>
            <select id="set-imgsize">
              ${['1024x1024', '1024x1792', '1792x1024', '512x512'].map(s =>
                `<option value="${s}" ${imageSize === s ? 'selected' : ''}>${s}</option>`
              ).join('')}
            </select>
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
            <button class="btn btn-danger btn-block" onclick="SettingsPage.clearData()">Clear All Data</button>
          </div>
        </div>

        <!-- About -->
        <div class="card mt-md text-center">
          <p class="text-sm text-muted">AI Comic Creator v1.0.0</p>
          <p class="text-sm text-muted">PWA &middot; Offline Ready &middot; NanoGPT Powered</p>
        </div>
      </div>
    `;
  }

  /**
   * Called after the settings HTML is inserted into the DOM.
   * Fetches the live model catalogues from NanoGPT and replaces the
   * fallback options in each dropdown while preserving the user's
   * current selection.
   */
  async function postRender() {
    const modelSelect = document.getElementById('set-model');
    const imgModelSelect = document.getElementById('set-imgmodel');
    const modelCount = document.getElementById('model-count');
    const imgModelCount = document.getElementById('imgmodel-count');

    const currentModel = modelSelect?.value;
    const currentImgModel = imgModelSelect?.value;

    // Fetch both lists in parallel
    const [textModels, imageModels] = await Promise.all([
      API.fetchTextModels(),
      API.fetchImageModels(),
    ]);

    if (textModels.length && modelSelect) {
      // Ensure the user's current selection is in the list
      const models = textModels.includes(currentModel)
        ? textModels
        : [currentModel, ...textModels];
      modelSelect.innerHTML = models
        .map(m => `<option value="${m}" ${m === currentModel ? 'selected' : ''}>${m}</option>`)
        .join('');
      if (modelCount) modelCount.textContent = `${textModels.length} models available`;
    } else if (modelCount) {
      modelCount.textContent = 'using cached list';
    }

    if (imageModels.length && imgModelSelect) {
      const imgs = imageModels.includes(currentImgModel)
        ? imageModels
        : [currentImgModel, ...imageModels];
      imgModelSelect.innerHTML = imgs
        .map(m => `<option value="${m}" ${m === currentImgModel ? 'selected' : ''}>${m}</option>`)
        .join('');
      if (imgModelCount) imgModelCount.textContent = `${imageModels.length} models available`;
    } else if (imgModelCount) {
      imgModelCount.textContent = 'using cached list';
    }
  }

  async function save() {
    const apiKey = document.getElementById('set-apikey').value.trim();
    if (!apiKey) return App.toast('API key is required', 'error');

    await DB.setSetting('apiKey', apiKey);
    await DB.setSetting('model', document.getElementById('set-model').value);
    await DB.setSetting('imageModel', document.getElementById('set-imgmodel').value);
    await DB.setSetting('enableImages', document.getElementById('set-enableimgs').checked);
    await DB.setSetting('imageSize', document.getElementById('set-imgsize').value);
    await DB.setSetting('temperature', parseFloat(document.getElementById('set-temp').value));
    await DB.setSetting('topP', parseFloat(document.getElementById('set-topp').value));
    await DB.setSetting('maxTokens', parseInt(document.getElementById('set-tokens').value));

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

      if (data.characters) for (const c of data.characters) await DB.put(DB.STORES.characters, c);
      if (data.worlds) for (const w of data.worlds) await DB.put(DB.STORES.worlds, w);
      if (data.comics) for (const c of data.comics) await DB.put(DB.STORES.comics, c);
      if (data.pages) for (const p of data.pages) await DB.put(DB.STORES.pages, p);
      if (data.presets) for (const p of data.presets) await DB.put(DB.STORES.presets, p);

      App.toast('Data imported!', 'success');
      App.refreshPage();
    } catch (e) {
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

  return { render, postRender, save, exportData, importData, clearData, confirmClear };
})();
