/**
 * Cloud Sync — Firebase Auth + Cloud Storage
 *
 * Provides automatic cloud backup and restore:
 *   - Google Sign-In (one-click login, persistent sessions)
 *   - Auto-save: debounced upload after every DB write
 *   - Auto-restore: download all data on sign-in
 *   - Per-collection JSON files in Firebase Cloud Storage
 *
 * Depends on: DB, App, firebase (loaded from CDN), FIREBASE_CONFIG
 */
const CloudSync = (() => {
  // How long to wait after a DB write before uploading (ms)
  const SAVE_DEBOUNCE_MS = 3000;

  // Map of DB store names → cloud file paths (relative to user root)
  const STORE_FILES = {
    characters: 'characters.json',
    worlds: 'worlds.json',
    comics: 'comics.json',
    pages: 'pages.json',
    presets: 'presets.json',
    imagePresets: 'image-presets.json',
  };

  // Settings keys to sync (excludes apiKey for security — users re-enter it per device)
  const SETTINGS_SYNC_KEYS = [
    'model', 'imageModel', 'temperature', 'topP', 'maxTokens',
    'contextExchanges', 'enableImages', 'useRefImages', 'includeAppearanceText',
    'charRefMode', 'captionModel', 'embeddingModel', 'showExplicitContent',
    'dynamicImageSizes', 'imageSize',
  ];

  let _initialised = false;
  let _user = null;
  let _saveTimers = {};        // per-store debounce timers
  let _settingsSaveTimer = null;
  let _syncing = false;        // true while a save or restore is in progress
  let _authListeners = [];     // callbacks notified on auth state change
  let _enabled = false;        // true once Firebase is successfully initialised

  // ─── Initialisation ────────────────────────────────────────────────

  function init() {
    if (_initialised) return;
    _initialised = true;

    // Firebase SDK not loaded or no config → cloud sync unavailable
    if (typeof firebase === 'undefined' || !FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey) {
      return;
    }

    try {
      firebase.initializeApp(FIREBASE_CONFIG);
      _enabled = true;
    } catch (e) {
      // App already initialised (hot-reload)
      if (e.code === 'app/duplicate-app') {
        _enabled = true;
      } else {
        console.warn('CloudSync: Firebase init failed', e);
        return;
      }
    }

    firebase.auth().onAuthStateChanged(async (user) => {
      _user = user;
      _authListeners.forEach(fn => fn(user));
      if (user) {
        // Auto-restore on login
        try {
          await restoreAll();
        } catch (e) {
          console.warn('CloudSync: auto-restore failed', e);
          if (typeof App !== 'undefined') {
            App.toast('Cloud restore failed — check console', 'error');
          }
        }
      }
    });
  }

  // ─── Auth ──────────────────────────────────────────────────────────

  async function signIn() {
    if (!_enabled) {
      App.toast('Cloud sync is not configured', 'error');
      return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await firebase.auth().signInWithPopup(provider);
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') {
        App.toast('Sign-in failed: ' + e.message, 'error');
      }
    }
  }

  async function signOut() {
    if (!_enabled) return;
    // Cancel pending saves
    Object.keys(_saveTimers).forEach(k => { clearTimeout(_saveTimers[k]); delete _saveTimers[k]; });
    if (_settingsSaveTimer) { clearTimeout(_settingsSaveTimer); _settingsSaveTimer = null; }
    await firebase.auth().signOut();
  }

  function isSignedIn() { return _enabled && !!_user; }
  function getUser() { return _user; }
  function isEnabled() { return _enabled; }

  function onAuthChange(fn) {
    _authListeners.push(fn);
    // Immediately call with current state
    fn(_user);
  }

  // ─── Cloud Storage helpers ─────────────────────────────────────────

  function _storageRef(path) {
    return firebase.storage().ref('users/' + _user.uid + '/' + path);
  }

  /** Upload a JSON string to Cloud Storage */
  async function _uploadJson(path, jsonStr) {
    const ref = _storageRef(path);
    await ref.putString(jsonStr, 'raw', { contentType: 'application/json' });
  }

  /** Download a JSON string from Cloud Storage; returns null if not found */
  async function _downloadJson(path) {
    try {
      const ref = _storageRef(path);
      const url = await ref.getDownloadURL();
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      // storage/object-not-found → file doesn't exist yet
      if (e.code === 'storage/object-not-found') return null;
      throw e;
    }
  }

  // ─── Strip panel imageUrls (shared logic) ─────────────────────────

  function stripPanelImageUrls(pages) {
    return pages.map(p => {
      const copy = Object.assign({}, p);
      if (copy.data && Array.isArray(copy.data.panels)) {
        copy.data = Object.assign({}, copy.data, {
          panels: copy.data.panels.map(panel => {
            const pc = Object.assign({}, panel);
            delete pc.imageUrl;
            return pc;
          }),
        });
      }
      return copy;
    });
  }

  // ─── Save (upload) ─────────────────────────────────────────────────

  /** Save a single data store to the cloud */
  async function saveStore(storeName) {
    if (!isSignedIn() || _syncing) return;
    const file = STORE_FILES[storeName];
    if (!file) return;

    let items = await DB.getAll(DB.STORES[storeName]);
    if (storeName === 'pages') {
      items = stripPanelImageUrls(items);
    }
    const json = JSON.stringify({ [storeName]: items, savedAt: new Date().toISOString() });
    await _uploadJson(file, json);
  }

  /** Save app settings to the cloud */
  async function saveSettings() {
    if (!isSignedIn() || _syncing) return;
    const settings = {};
    for (const key of SETTINGS_SYNC_KEYS) {
      settings[key] = await DB.getSetting(key, null);
    }
    const json = JSON.stringify({ settings, savedAt: new Date().toISOString() });
    await _uploadJson('settings.json', json);
  }

  /** Save all stores + settings (for manual "back up now") */
  async function saveAll() {
    if (!isSignedIn()) return;
    _syncing = true;
    try {
      await Promise.all([
        ...Object.keys(STORE_FILES).map(storeName => saveStore(storeName)),
        saveSettings(),
      ]);
    } finally {
      _syncing = false;
    }
  }

  // ─── Restore (download) ────────────────────────────────────────────

  /** Restore all stores + settings from the cloud */
  async function restoreAll() {
    if (!isSignedIn()) return;
    _syncing = true;
    try {
      const validArray = (arr) =>
        Array.isArray(arr) && arr.every(item => item && typeof item === 'object' && item.id);

      // Restore settings
      const settingsRaw = await _downloadJson('settings.json');
      if (settingsRaw) {
        const parsed = JSON.parse(settingsRaw);
        if (parsed.settings && typeof parsed.settings === 'object') {
          for (const key of SETTINGS_SYNC_KEYS) {
            if (Object.prototype.hasOwnProperty.call(parsed.settings, key)) {
              await DB.setSetting(key, parsed.settings[key]);
            }
          }
        }
      }

      // Restore each data store
      let totalItems = 0;
      for (const [storeName, file] of Object.entries(STORE_FILES)) {
        const raw = await _downloadJson(file);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const items = parsed[storeName];
        if (!validArray(items)) continue;
        await Promise.all(items.map(item => DB.put(DB.STORES[storeName], item)));
        totalItems += items.length;
      }

      if (totalItems > 0 && typeof App !== 'undefined') {
        App.toast('Cloud data restored (' + totalItems + ' items)', 'success');
      }
    } finally {
      _syncing = false;
    }
  }

  // ─── Auto-save hooks ──────────────────────────────────────────────

  /**
   * Called by DB after a put() or del() to schedule a debounced cloud save.
   * @param {string} storeName - the DB store that was modified
   */
  function notifyWrite(storeName) {
    if (!isSignedIn() || _syncing) return;

    if (storeName === 'settings') {
      if (_settingsSaveTimer) clearTimeout(_settingsSaveTimer);
      _settingsSaveTimer = setTimeout(() => {
        _settingsSaveTimer = null;
        saveSettings().catch(e => console.warn('CloudSync: settings save failed', e));
      }, SAVE_DEBOUNCE_MS);
      return;
    }

    const file = STORE_FILES[storeName];
    if (!file) return;

    if (_saveTimers[storeName]) clearTimeout(_saveTimers[storeName]);
    _saveTimers[storeName] = setTimeout(() => {
      delete _saveTimers[storeName];
      saveStore(storeName).catch(e => console.warn('CloudSync: ' + storeName + ' save failed', e));
    }, SAVE_DEBOUNCE_MS);
  }

  // ─── Public API ────────────────────────────────────────────────────

  return {
    init,
    signIn,
    signOut,
    isSignedIn,
    isEnabled,
    getUser,
    onAuthChange,
    saveAll,
    restoreAll,
    notifyWrite,
    stripPanelImageUrls,
    SETTINGS_SYNC_KEYS,
  };
})();
