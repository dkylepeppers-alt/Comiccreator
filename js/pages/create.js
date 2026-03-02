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
    pageIds: [],    // DB ids parallel to pages[], used for re-roll / undo
    conversationHistory: [],
    referenceImages: [],
    characters: [],
    isGenerating: false,
    generatingContext: 'initial', // 'initial', 'reroll', 'continue'
    draftLoaded: false,
  };

  // Track timeouts and abort controllers for cleanup
  let streamTimeout = null;
  let abortController = null;

  async function render(param) {
    // Always honour active state — must come BEFORE param checks so that
    // App.refreshPage() during re-roll/generation of a resumed comic does not
    // re-invoke renderResume() and reset isGenerating / step.
    if (state.step === 'generating') return renderGenerating();
    if (state.step === 'reading' && (!param || param.length <= 10 || param === state.comicId)) {
      return renderReading();
    }

    // If param is a genre id, pre-select it
    if (param && GENRES.find(g => g.id === param)) {
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
    const hasDraft = state.genre || state.title || state.storyPrompt ||
      (state.selectedCharacters?.length > 0) || state.selectedWorld || state.selectedPreset;

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
      state.generatingContext === 'reroll'   ? 'Re-rolling page...' :
      state.generatingContext === 'continue' ? 'Continuing story...' :
      'Generating your comic page...';
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
            ${canUndo ? `<button class="btn btn-sm btn-secondary" onclick="CreatePage.undoChoice()" ${state.isGenerating ? 'disabled' : ''} title="Go back to previous choice">&#x21A9; Undo</button>` : ''}
          </div>
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
        ${panel.imageUrl ? `<img src="${panel.imageUrl}" alt="Panel ${i+1}" loading="lazy" class="zoomable-panel" style="cursor:zoom-in;" onclick="CreatePage.zoomPanel(${i})">` :
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
    state.selectedCharacters = comic.characterIds || [];
    state.selectedWorld = comic.worldId || null;
    state.selectedPreset = comic.presetId || null;
    state.pages = pages.map(p => p.data);
    state.pageIds = pages.map(p => p.id);   // restore ids for re-roll/undo
    state.conversationHistory = comic.conversationHistory || [];
    state.step = 'reading';
    state.isGenerating = false;

    // Restore character data and reference images for continued generation
    state.characters = [];
    for (const cid of state.selectedCharacters) {
      const c = await DB.get(DB.STORES.characters, cid);
      if (c) state.characters.push(c);
    }

    const useRefImages = await DB.getSetting('useRefImages', true);
    const refImages = [];
    if (useRefImages) {
      for (const c of state.characters) {
        if (c.imageData) refImages.push(c.imageData);
      }
      if (state.selectedWorld) {
        const world = await DB.get(DB.STORES.worlds, state.selectedWorld);
        if (world?.images) {
          for (const img of world.images) {
            if (img) refImages.push(img);
          }
        }
      }
    }
    state.referenceImages = refImages;

    return renderReading();
  }

  // --- User Actions ---

  function setTitle(value) {
    state.title = value;
    scheduleDraftSave();
  }

  function setStoryPrompt(value) {
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
    state.title = '';
    state.storyPrompt = '';
    state.draftLoaded = true; // mark as loaded so we don't re-load old draft
    await DB.setSetting('createSetupDraft', null);
    App.refreshPage();
  }

  function selectGenre(id) {
    state.genre = id;
    document.querySelectorAll('.genre-card').forEach(el => {
      el.classList.toggle('active', el.dataset.genre === id);
    });
    scheduleDraftSave();
    // Show/hide custom input
    if (id === 'custom') {
      App.refreshPage();
    }
  }

  function setCustomGenre(value) {
    state.customGenre = value;
    scheduleDraftSave();
  }

  function toggleCharacter(id) {
    const idx = state.selectedCharacters.indexOf(id);
    if (idx >= 0) state.selectedCharacters.splice(idx, 1);
    else state.selectedCharacters.push(id);
    scheduleDraftSave();
    App.refreshPage();
  }

  function selectWorld(id) {
    state.selectedWorld = id;
    scheduleDraftSave();
    App.refreshPage();
  }

  function selectPreset(id) {
    state.selectedPreset = id;
    scheduleDraftSave();
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

    // Build context
    const characters = [];
    for (const cid of state.selectedCharacters) {
      const c = await DB.get(DB.STORES.characters, cid);
      if (c) characters.push(c);
    }
    state.characters = characters;
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
      presetData?.systemPrompt || null
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
    state.generatingContext = 'initial';
    await App.refreshPage();

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
        options
      );

      // Parse the response
      const streamTitle = document.getElementById('gen-stream-title');
      if (streamTitle) streamTitle.textContent = 'Parsing story...';
      const statusMsg = document.getElementById('gen-status-msg');
      if (statusMsg) statusMsg.textContent = 'Parsing story...';

      const pageData = API.parseComicResponse(fullText);
      if (!pageData) {
        App.toast('Failed to parse comic page — the AI response was not valid JSON. Please try again.', 'error');
        state.step = state.pages.length > 0 ? 'reading' : 'setup';
        state.isGenerating = false;
        await App.refreshPage();
        return;
      }

      // Add assistant response to conversation
      state.conversationHistory.push({ role: 'assistant', content: fullText });

      // Generate images if enabled — all panels in parallel
      const enableImages = await DB.getSetting('enableImages', true);
      if (enableImages) {
        const panelsWithImages = pageData.panels.filter(p => p.imagePrompt).length;
        if (panelsWithImages > 0) {
          if (streamTitle) streamTitle.textContent = `Generating ${panelsWithImages} image${panelsWithImages > 1 ? 's' : ''}...`;
          if (statusMsg) statusMsg.textContent = `Generating images (0 / ${panelsWithImages})...`;
        }
        const imageResolution = await DB.getSetting('imageSize', '1024x1024');
        const imagePromptPrefix = await DB.getSetting('imagePromptPrefix', '');
        const imageOpts = { resolution: imageResolution };
        if (state.referenceImages.length === 1) {
          imageOpts.imageDataUrl = state.referenceImages[0];
        } else if (state.referenceImages.length > 1) {
          imageOpts.imageDataUrls = state.referenceImages;
        }

        // Build character appearance suffix for consistent visuals
        const characterAppearances = state.characters
          .filter(c => c.appearance && c.appearance.trim())
          .map(c => `${c.name}: ${c.appearance.trim()}`)
          .join('; ');
        const appearanceSuffix = characterAppearances
          ? `Characters in scene: ${characterAppearances}`
          : '';

        function buildEnhancedImagePrompt(basePrompt) {
          let prompt = basePrompt;
          if (imagePromptPrefix) prompt = `${imagePromptPrefix}, ${prompt}`;
          if (appearanceSuffix) prompt = `${prompt}. ${appearanceSuffix}`;
          return prompt;
        }

        let doneCount = 0;
        await Promise.all(pageData.panels.map(async (panel) => {
          if (!panel.imagePrompt) return;
          try {
            const enhancedPrompt = buildEnhancedImagePrompt(panel.imagePrompt);
            const imageData = await API.generateImage(enhancedPrompt, imageOpts);
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
            App.logError('Image generation (panel)', imgErr);
            App.toast(`Panel image failed: ${imgErr.message}`, 'error');
          }
          doneCount++;
          if (statusMsg) statusMsg.textContent = `Generating images (${doneCount} / ${panelsWithImages})...`;
        }));
      }

      // Save page — generate id first so we can track it for re-roll/undo
      state.pages.push(pageData);
      const pageNum = state.pages.length;
      const pageId = DB.uuid();
      await DB.put(DB.STORES.pages, {
        id: pageId,
        comicId: state.comicId,
        pageNum,
        data: pageData,
        createdAt: Date.now(),
      });
      state.pageIds.push(pageId);

      // Update comic
      const comic = await DB.get(DB.STORES.comics, state.comicId);
      if (comic) {
        comic.pageCount = pageNum;
        comic.conversationHistory = state.conversationHistory;
        comic.updatedAt = Date.now();
        await DB.put(DB.STORES.comics, comic);
      }

      // Autosave: track this comic as the active in-progress session.
      // Only on first page: clear setup draft now that the comic is saved.
      DB.setSetting('createActiveComicId', state.comicId).catch(() => {});
      if (pageNum === 1) DB.setSetting('createSetupDraft', null).catch(() => {});

      state.step = 'reading';
      state.isGenerating = false;
      App.toast(`Page ${pageNum} ready!`, 'success');
      await App.refreshPage();

    } catch (err) {
      App.logError('Comic generation', err);
      // Roll back the last user message so retries don't compound failed attempts
      if (state.conversationHistory.length > 0) {
        const last = state.conversationHistory[state.conversationHistory.length - 1];
        if (last && last.role === 'user') state.conversationHistory.pop();
      }
      if (err.name === 'AbortError') {
        // Cancelled — cancelGeneration() already handled this
        return;
      }
      App.toast(err.message || 'Generation failed. Please try again.', 'error');
      state.step = state.pages.length > 0 ? 'reading' : 'setup';
      state.isGenerating = false;
      await App.refreshPage();
    }
  }

  async function makeChoice(idx) {
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
    const userMsg = customDir ?
      `Continue the story with this direction: ${customDir}. Generate the next comic page.` :
      'Continue the story naturally. Generate the next comic page.';

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
    state.step = state.pages.length > 0 ? 'reading' : 'setup';
    App.toast('Generation cancelled', 'info');
    App.refreshPage();
  }

  /**
   * Regenerate the current page with different content.
   * Pops the last assistant message so the AI produces a fresh response.
   */
  async function rerollPage() {
    if (state.isGenerating || state.pages.length === 0) return;

    // Remove last assistant turn from history so the AI tries again.
    // A failed parse attempt may have left a trailing user message — strip it first.
    const trailingMsg = state.conversationHistory[state.conversationHistory.length - 1];
    if (trailingMsg?.role === 'user') state.conversationHistory.pop();
    const lastMsg = state.conversationHistory[state.conversationHistory.length - 1];
    if (lastMsg?.role === 'assistant') state.conversationHistory.pop();

    // Delete the saved page from DB
    const lastPageId = state.pageIds.pop();
    if (lastPageId) await DB.del(DB.STORES.pages, lastPageId);
    state.pages.pop();

    // Update the comic record
    const comic = await DB.get(DB.STORES.comics, state.comicId);
    if (comic) {
      comic.pageCount = state.pages.length;
      comic.conversationHistory = state.conversationHistory;
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

    // Update the comic record
    const comic = await DB.get(DB.STORES.comics, state.comicId);
    if (comic) {
      comic.pageCount = state.pages.length;
      comic.conversationHistory = state.conversationHistory;
      comic.updatedAt = Date.now();
      await DB.put(DB.STORES.comics, comic);
    }

    App.toast('Went back to previous choice', 'info');
    state.step = 'reading';
    await App.refreshPage();
  }

  /**
   * Open a full-size panel image in a modal lightbox.
   * Uses the panel index to look up from the current page in state (avoids
   * embedding data URLs in onclick attributes).
   */
  function zoomPanel(panelIndex) {
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
      characters: [],
      isGenerating: false,
      generatingContext: 'initial',
      draftLoaded: false,
    };
  }

  function onUnmount() {
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

  return {
    render, onUnmount, selectGenre, setCustomGenre, toggleCharacter, selectWorld, selectPreset,
    toggleAdvanced, startGenerating, makeChoice, continueStory, finishComic, cancelGeneration,
    rerollPage, undoChoice, zoomPanel, resetState,
    setTitle, setStoryPrompt, resetSetup,
  };
})();
