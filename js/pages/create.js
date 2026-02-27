/**
 * Create Comic Page - The core comic generation experience
 */
const CreatePage = (() => {
  let state = {
    step: 'setup', // 'setup', 'generating', 'reading'
    genre: '',
    customGenre: '',
    selectedCharacters: [],
    selectedWorld: null,
    selectedPreset: null,
    comicId: null,
    title: '',
    storyPrompt: '',
    pages: [],
    conversationHistory: [],
    referenceImages: [],
    isGenerating: false,
  };

  async function render(param) {
    // If param is a genre id, pre-select it
    if (param && GENRES.find(g => g.id === param)) {
      state.genre = param;
    }
    // If param is a comic id, resume that comic
    if (param && param.length > 10) {
      return await renderResume(param);
    }

    if (state.step === 'generating') return renderGenerating();
    if (state.step === 'reading') return renderReading();
    return renderSetup();
  }

  async function renderSetup() {
    const characters = await DB.getAll(DB.STORES.characters);
    const worlds = await DB.getAll(DB.STORES.worlds);
    const presets = await DB.getAll(DB.STORES.presets);

    return `
      <div class="slide-up">
        <h2 class="section-title">Create New Comic</h2>

        <!-- Step 1: Genre -->
        <div class="card">
          <h3 class="card-title mb-sm">1. Choose Genre</h3>
          <div class="genre-grid" id="genre-grid">
            ${GENRES.map(g => `
              <div class="genre-card ${state.genre === g.id ? 'active' : ''}" data-genre="${g.id}" onclick="CreatePage.selectGenre('${g.id}')">
                <span class="genre-emoji">${g.emoji}</span>
                ${g.name}
              </div>
            `).join('')}
          </div>
          ${state.genre === 'custom' ? `
            <div class="form-group mt-sm">
              <input type="text" id="custom-genre" value="${escHtml(state.customGenre)}" placeholder="Enter your custom genre..." onchange="CreatePage.setCustomGenre(this.value)">
            </div>
          ` : ''}
        </div>

        <!-- Step 2: Characters -->
        <div class="card">
          <h3 class="card-title mb-sm">2. Select Characters</h3>
          ${characters.length === 0 ? `
            <p class="text-sm text-muted mb-sm">No characters created yet.</p>
            <button class="btn btn-sm btn-secondary" onclick="App.navigate('characters', 'new')">Create Character</button>
          ` : `
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              ${characters.map(c => `
                <div class="chip ${state.selectedCharacters.includes(c.id) ? 'active' : ''}" onclick="CreatePage.toggleCharacter('${c.id}')">
                  ${escHtml(c.name)}
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <!-- Step 3: World -->
        <div class="card">
          <h3 class="card-title mb-sm">3. Select World (optional)</h3>
          ${worlds.length === 0 ? `
            <p class="text-sm text-muted mb-sm">No worlds created yet.</p>
            <button class="btn btn-sm btn-secondary" onclick="App.navigate('worlds', 'new')">Create World</button>
          ` : `
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <div class="chip ${!state.selectedWorld ? 'active' : ''}" onclick="CreatePage.selectWorld(null)">None</div>
              ${worlds.map(w => `
                <div class="chip ${state.selectedWorld === w.id ? 'active' : ''}" onclick="CreatePage.selectWorld('${w.id}')">
                  ${escHtml(w.name)}
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <!-- Step 4: Preset -->
        <div class="card">
          <h3 class="card-title mb-sm">4. Prompt Preset (optional)</h3>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            <div class="chip ${!state.selectedPreset ? 'active' : ''}" onclick="CreatePage.selectPreset(null)">Default</div>
            ${presets.map(p => `
              <div class="chip ${state.selectedPreset === p.id ? 'active' : ''}" onclick="CreatePage.selectPreset('${p.id}')">
                ${escHtml(p.name)}
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Step 5: Story Setup -->
        <div class="card">
          <h3 class="card-title mb-sm">5. Story Setup</h3>
          <div class="form-group">
            <label class="form-label">Comic Title</label>
            <input type="text" id="comic-title" value="${escHtml(state.title)}" placeholder="e.g. The Last Guardian">
          </div>
          <div class="form-group">
            <label class="form-label">Opening Prompt</label>
            <textarea id="story-prompt" rows="4" placeholder="Describe how you want the story to begin... (Leave blank for AI to decide)">${escHtml(state.storyPrompt)}</textarea>
            <div class="form-hint">Be specific or leave blank for a surprise</div>
          </div>
        </div>

        <!-- Advanced: Override Samplers -->
        <div class="card">
          <div class="collapsible-header collapsed" onclick="CreatePage.toggleAdvanced(this)">
            <h3 class="card-title" style="margin:0;">Advanced Controls</h3>
          </div>
          <div class="collapsible-body collapsed" id="advanced-controls">
            <div class="form-group mt-sm">
              <label class="form-label">Temperature Override: <span id="adv-temp-val">${state.overrideTemp || 'default'}</span></label>
              <div class="range-group">
                <span class="text-sm text-muted">0</span>
                <input type="range" id="adv-temp" min="0" max="2" step="0.05" value="${state.overrideTemp || 0.7}" oninput="document.getElementById('adv-temp-val').textContent=this.value">
                <span class="text-sm text-muted">2</span>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Top-P Override: <span id="adv-topp-val">${state.overrideTopP || 'default'}</span></label>
              <div class="range-group">
                <span class="text-sm text-muted">0</span>
                <input type="range" id="adv-topp" min="0" max="1" step="0.05" value="${state.overrideTopP || 0.9}" oninput="document.getElementById('adv-topp-val').textContent=this.value">
                <span class="text-sm text-muted">1</span>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Max Tokens Override: <span id="adv-tokens-val">${state.overrideTokens || 'default'}</span></label>
              <div class="range-group">
                <span class="text-sm text-muted">256</span>
                <input type="range" id="adv-tokens" min="256" max="8192" step="256" value="${state.overrideTokens || 2048}" oninput="document.getElementById('adv-tokens-val').textContent=this.value">
                <span class="text-sm text-muted">8192</span>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Custom System Prompt Override</label>
              <textarea id="adv-system" rows="4" placeholder="Leave blank to use preset or default...">${escHtml(state.overrideSystem || '')}</textarea>
            </div>
          </div>
        </div>

        <button class="btn btn-primary btn-block" onclick="CreatePage.startGenerating()" ${!state.genre ? 'disabled' : ''}>
          Generate First Page
        </button>
      </div>
    `;
  }

  function renderGenerating() {
    return `
      <div class="slide-up">
        <div class="loading-overlay" id="gen-loading">
          <div class="spinner"></div>
          <p>Generating your comic page...</p>
          <p class="text-sm text-muted">This may take a moment</p>
        </div>
        <div id="gen-stream" class="hidden">
          <div class="card">
            <h3 class="card-title mb-sm">Generating...</h3>
            <div class="streaming-text" id="stream-output"></div>
          </div>
        </div>
      </div>
    `;
  }

  function renderReading() {
    const pages = state.pages;
    const currentPage = pages[pages.length - 1];

    return `
      <div class="slide-up">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 class="section-title" style="margin:0;">${escHtml(state.title || 'Untitled Comic')}</h2>
          <span class="text-sm text-muted">Page ${pages.length}</span>
        </div>

        <!-- Render current page panels -->
        <div class="comic-page${currentPage?.panels?.length >= 3 ? ' layout-grid' : ''}" id="comic-display">
          ${currentPage ? renderComicPage(currentPage) : '<p class="text-muted text-center">No content yet</p>'}
        </div>

        <!-- Choices -->
        ${currentPage && currentPage.choices && currentPage.choices.length > 0 ? `
          <div class="card">
            <h3 class="card-title mb-sm">What happens next?</h3>
            <div class="choices-container">
              ${currentPage.choices.map((choice, i) => `
                <button class="choice-btn" onclick="CreatePage.makeChoice(${i})" ${state.isGenerating ? 'disabled' : ''}>
                  <strong>Option ${i + 1}:</strong> ${escHtml(choice.text)}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

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
        ${pages.length > 1 ? `
          <div class="card">
            <div class="collapsible-header collapsed" onclick="CreatePage.toggleAdvanced(this)">
              <h3 class="card-title" style="margin:0;">Previous Pages (${pages.length - 1})</h3>
            </div>
            <div class="collapsible-body collapsed">
              ${pages.slice(0, -1).map((p, i) => `
                <div style="border-bottom:1px solid var(--border);padding:12px 0;">
                  <div class="text-sm" style="font-weight:600;">Page ${i + 1}: ${escHtml(p.title || '')}</div>
                  <div class="text-sm text-muted mt-sm">${p.panels ? p.panels.length : 0} panels</div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  function renderComicPage(page) {
    if (!page || !page.panels) return '<p class="text-muted">Empty page</p>';

    return page.panels.map((panel, i) => `
      <div class="comic-panel">
        ${panel.imageUrl ? `<img src="${panel.imageUrl}" alt="Panel ${i+1}" loading="lazy">` :
          panel.imagePrompt ? `<div style="background:linear-gradient(135deg,#1a1a3e,#2a1a4e);padding:20px;min-height:180px;display:flex;align-items:center;justify-content:center;"><p class="text-sm text-muted text-center" style="font-style:italic;">${escHtml(panel.imagePrompt).slice(0, 150)}...</p></div>` :
          ''}
        ${panel.narration ? `<div class="comic-narration">${escHtml(panel.narration)}</div>` : ''}
        ${(panel.dialogue || []).map(d => `
          <div class="comic-dialogue">
            <div class="speaker-name">${escHtml(d.speaker)}</div>
            <div>${escHtml(d.text)}</div>
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  async function renderResume(comicId) {
    const comic = await DB.get(DB.STORES.comics, comicId);
    if (!comic) return '<p class="text-muted">Comic not found</p>';

    const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', comicId);
    pages.sort((a, b) => a.pageNum - b.pageNum);

    state.comicId = comicId;
    state.title = comic.title;
    state.genre = comic.genre;
    state.pages = pages.map(p => p.data);
    state.conversationHistory = comic.conversationHistory || [];
    state.step = 'reading';
    state.isGenerating = false;

    return renderReading();
  }

  // --- User Actions ---

  function selectGenre(id) {
    state.genre = id;
    document.querySelectorAll('.genre-card').forEach(el => {
      el.classList.toggle('active', el.dataset.genre === id);
    });
    // Show/hide custom input
    if (id === 'custom') {
      App.refreshPage();
    }
  }

  function setCustomGenre(value) {
    state.customGenre = value;
  }

  function toggleCharacter(id) {
    const idx = state.selectedCharacters.indexOf(id);
    if (idx >= 0) state.selectedCharacters.splice(idx, 1);
    else state.selectedCharacters.push(id);
    App.refreshPage();
  }

  function selectWorld(id) {
    state.selectedWorld = id;
    App.refreshPage();
  }

  function selectPreset(id) {
    state.selectedPreset = id;
    App.refreshPage();
  }

  function toggleAdvanced(el) {
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

    // Gather overrides
    const advTemp = document.getElementById('adv-temp');
    const advTopP = document.getElementById('adv-topp');
    const advTokens = document.getElementById('adv-tokens');
    const advSystem = document.getElementById('adv-system');
    state.overrideTemp = advTemp ? parseFloat(advTemp.value) : null;
    state.overrideTopP = advTopP ? parseFloat(advTopP.value) : null;
    state.overrideTokens = advTokens ? parseInt(advTokens.value) : null;
    state.overrideSystem = advSystem ? advSystem.value.trim() : '';

    // Build context
    const characters = [];
    for (const cid of state.selectedCharacters) {
      const c = await DB.get(DB.STORES.characters, cid);
      if (c) characters.push(c);
    }
    const world = state.selectedWorld ? await DB.get(DB.STORES.worlds, state.selectedWorld) : null;

    // Collect reference images for image-to-image generation
    const useRefImages = await DB.getSetting('useRefImages', true);
    const refImages = [];
    if (useRefImages) {
      for (const c of characters) {
        if (c.imageData) refImages.push(c.imageData);
      }
      if (world?.images) {
        for (const img of world.images) {
          if (img) refImages.push(img);
        }
      }
    }
    state.referenceImages = refImages;

    let presetData = null;
    if (state.selectedPreset) {
      presetData = await DB.get(DB.STORES.presets, state.selectedPreset);
    }

    const genreName = state.genre === 'custom' ? (state.customGenre || 'Custom') :
      GENRES.find(g => g.id === state.genre)?.name || state.genre;

    const systemPrompt = API.buildSystemPrompt(
      genreName,
      characters,
      world,
      state.overrideSystem || presetData?.systemPrompt || null
    );

    const userMessage = state.storyPrompt ?
      `Create the first page of a ${genreName} comic titled "${state.title}". Opening scene: ${state.storyPrompt}` :
      `Create the first page of a ${genreName} comic titled "${state.title}". Begin with an engaging opening scene.`;

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
      pageCount: 0,
      conversationHistory: state.conversationHistory,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await DB.put(DB.STORES.comics, comic);

    state.pages = [];
    state.step = 'generating';
    state.isGenerating = true;
    App.refreshPage();

    // Generate
    await generatePage(presetData);
  }

  /**
   * Trim conversation history to prevent payload overflow.
   * Keeps system prompt, first user message, and the most recent exchanges.
   */
  function trimConversationHistory(maxExchanges = 6) {
    if (state.conversationHistory.length <= 2 + maxExchanges * 2) return;
    const system = state.conversationHistory[0];
    const firstUser = state.conversationHistory[1];
    const recent = state.conversationHistory.slice(-(maxExchanges * 2));
    state.conversationHistory = [system, firstUser, ...recent];
  }

  async function generatePage(presetData) {
    try {
      trimConversationHistory();

      const options = {};
      if (state.overrideTemp != null) options.temperature = state.overrideTemp;
      if (state.overrideTopP != null) options.topP = state.overrideTopP;
      if (state.overrideTokens != null) options.maxTokens = state.overrideTokens;
      if (presetData) {
        if (!state.overrideTemp) options.temperature = presetData.temperature;
        if (!state.overrideTopP) options.topP = presetData.topP;
        if (!state.overrideTokens) options.maxTokens = presetData.maxTokens;
      }

      // Show streaming
      setTimeout(() => {
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
        options
      );

      // Parse the response
      const pageData = API.parseComicResponse(fullText);
      if (!pageData) {
        App.toast('Failed to parse comic page. Retrying...', 'error');
        state.step = 'setup';
        state.isGenerating = false;
        App.refreshPage();
        return;
      }

      // Add assistant response to conversation
      state.conversationHistory.push({ role: 'assistant', content: fullText });

      // Generate images if enabled
      const enableImages = await DB.getSetting('enableImages', true);
      if (enableImages) {
        const imageSize = await DB.getSetting('imageSize', '1024x1024');
        for (const panel of pageData.panels) {
          if (panel.imagePrompt) {
            try {
              const imageOpts = { size: imageSize };
              if (state.referenceImages.length === 1) {
                imageOpts.imageDataUrl = state.referenceImages[0];
              } else if (state.referenceImages.length > 1) {
                imageOpts.imageDataUrls = state.referenceImages;
              }
              const imageData = await API.generateImage(panel.imagePrompt, imageOpts);
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
                  // Already a complete data URL
                  panel.imageUrl = imageData;
                } else {
                  // Raw base64 — convert to data URL for storage
                  panel.imageUrl = `data:image/png;base64,${imageData}`;
                }
              }
            } catch (imgErr) {
              console.warn('Image generation failed for panel:', imgErr);
              App.toast(`Panel image failed: ${imgErr.message}`, 'error');
            }
          }
        }
      }

      // Save page
      state.pages.push(pageData);
      const pageNum = state.pages.length;
      await DB.put(DB.STORES.pages, {
        id: DB.uuid(),
        comicId: state.comicId,
        pageNum,
        data: pageData,
        createdAt: Date.now(),
      });

      // Update comic
      const comic = await DB.get(DB.STORES.comics, state.comicId);
      if (comic) {
        comic.pageCount = pageNum;
        comic.conversationHistory = state.conversationHistory;
        comic.updatedAt = Date.now();
        await DB.put(DB.STORES.comics, comic);
      }

      state.step = 'reading';
      state.isGenerating = false;
      App.refreshPage();

    } catch (err) {
      console.error('Generation error:', err);
      App.toast(err.message || 'Generation failed', 'error');
      state.step = 'reading';
      state.isGenerating = false;
      App.refreshPage();
    }
  }

  async function makeChoice(idx) {
    const currentPage = state.pages[state.pages.length - 1];
    if (!currentPage || !currentPage.choices || !currentPage.choices[idx]) return;

    const choice = currentPage.choices[idx];
    const userMsg = `The reader chose: "${choice.text}". Continue the story based on this choice. Generate the next comic page.`;

    state.conversationHistory.push({ role: 'user', content: userMsg });
    state.isGenerating = true;
    state.step = 'generating';
    App.refreshPage();

    const presetData = state.selectedPreset ? await DB.get(DB.STORES.presets, state.selectedPreset) : null;
    await generatePage(presetData);
  }

  async function continueStory() {
    const customDir = document.getElementById('custom-direction')?.value?.trim();
    const userMsg = customDir ?
      `Continue the story with this direction: ${customDir}. Generate the next comic page.` :
      'Continue the story naturally. Generate the next comic page.';

    state.conversationHistory.push({ role: 'user', content: userMsg });
    state.isGenerating = true;
    state.step = 'generating';
    App.refreshPage();

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
    App.toast('Comic saved!', 'success');
    resetState();
    App.navigate('library');
  }

  function resetState() {
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
      conversationHistory: [],
      referenceImages: [],
      isGenerating: false,
    };
  }

  return {
    render, selectGenre, setCustomGenre, toggleCharacter, selectWorld, selectPreset,
    toggleAdvanced, startGenerating, makeChoice, continueStory, finishComic, resetState,
  };
})();
