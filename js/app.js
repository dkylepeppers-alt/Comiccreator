/**
 * Main Application Router & Controller
 */
const App = (() => {
  let currentPage = 'home';
  let currentParam = null;

  const pages = {
    home: HomePage,
    characters: CharactersPage,
    worlds: WorldsPage,
    create: CreatePage,
    library: LibraryPage,
    presets: PresetsPage,
    settings: SettingsPage,
  };

  const pageTitles = {
    home: 'AI Comic Creator',
    characters: 'Character Builder',
    worlds: 'World Builder',
    create: 'Create Comic',
    library: 'My Comics',
    presets: 'Prompt Presets',
    settings: 'Settings',
  };

  async function init() {
    await DB.open();
    await DB.seedDefaults();
    await DB.dedupePresets();

    // Set up navigation
    setupNavigation();

    // Register service worker
    registerSW();

    // Check for API key on first run
    const apiKey = await DB.getSetting('apiKey', '');
    if (!apiKey) {
      navigate('settings');
      setTimeout(() => toast('Welcome! Set your NanoGPT API key to get started.', 'info'), 500);
    } else {
      // Check URL hash for deep linking
      const hash = window.location.hash.slice(1);
      if (hash && pages[hash]) {
        navigate(hash);
      } else {
        navigate('home');
      }
    }
  }

  function setupNavigation() {
    // Sidebar toggle
    document.getElementById('menu-btn').addEventListener('click', openSidebar);
    document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
    document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

    // Sidebar links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(link.dataset.page);
        closeSidebar();
      });
    });

    // Bottom nav
    document.querySelectorAll('.bnav-btn').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.page));
    });

    // Settings button -> settings
    document.getElementById('settings-btn').addEventListener('click', () => navigate('settings'));

    // Hash change
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.slice(1);
      if (hash && pages[hash] && hash !== currentPage) {
        navigate(hash);
      }
    });
  }

  function openSidebar() {
    document.getElementById('sidebar').classList.remove('closed');
    document.getElementById('sidebar-overlay').classList.remove('hidden');
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.add('closed');
    document.getElementById('sidebar-overlay').classList.add('hidden');
  }

  let previousPageModule = null;

  async function navigate(page, param = null) {
    if (!pages[page]) return;

    // Call onUnmount on the previous page if it has one
    if (previousPageModule && typeof previousPageModule.onUnmount === 'function') {
      try { previousPageModule.onUnmount(); } catch (e) { logError('onUnmount', e); }
    }

    currentPage = page;
    currentParam = param;
    previousPageModule = pages[page];

    // Update URL hash
    window.location.hash = page;

    // Update title
    document.getElementById('page-title').textContent = pageTitles[page] || page;

    // Update active states
    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.dataset.page === page);
    });
    document.querySelectorAll('.bnav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.page === page);
    });

    // Render page
    const content = document.getElementById('content');
    try {
      const html = await pages[page].render(param);
      content.innerHTML = html;
      content.scrollTop = 0;

      // Allow pages to run post-render logic (e.g. async model fetching)
      if (typeof pages[page].postRender === 'function') {
        pages[page].postRender(param);
      }
      // Call onMount after DOM is updated, if the page module supports it
      if (typeof pages[page].onMount === 'function') {
        await pages[page].onMount(param);
      }
    } catch (err) {
      logError(`Page render (${page})`, err);
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">&#9888;</div><div class="empty-state-text">Error loading page: ${escHtml(err.message)}</div></div>`;
    }
  }

  async function refreshPage() {
    await navigate(currentPage, currentParam);
  }

  // Modal
  function showModal(html) {
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  function hideModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
  }

  // Toast
  // options.duration: ms before auto-dismiss (default: 3000; 0 = persistent — click to dismiss)
  // options.onClick: optional callback fired when the user clicks the toast
  function toast(message, type = 'info', options = {}) {
    const { duration = 3000, onClick = null } = options;
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    // Persistent toasts (duration === 0) are always click-to-dismiss so they
    // can never become permanently stuck even if no onClick handler is given.
    if (duration === 0 || onClick) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        el.remove();
        if (onClick) onClick();
      });
    }
    container.appendChild(el);
    if (duration > 0) {
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.3s';
        setTimeout(() => el.remove(), 300);
      }, duration);
    }
  }

  // --- Global Error Log ---
  let errorLog = [];
  let errorPanelOpen = false;

  function logError(context, error, extraDetails) {
    const entry = {
      timestamp: new Date().toISOString(),
      context,
      message: error?.message || String(error),
      stack: error?.stack || null,
      details: extraDetails || null,
    };
    errorLog.push(entry);
    updateErrorBadge();
    if (errorPanelOpen) renderErrorPanel();
  }

  function updateErrorBadge() {
    const badge = document.getElementById('error-badge');
    if (!badge) return;
    if (errorLog.length === 0) {
      badge.classList.add('hidden');
    } else {
      badge.classList.remove('hidden');
      badge.textContent = errorLog.length > 99 ? '99+' : errorLog.length;
    }
  }

  function toggleErrorPanel() {
    errorPanelOpen = !errorPanelOpen;
    const panel = document.getElementById('error-panel');
    if (!panel) return;
    if (errorPanelOpen) {
      renderErrorPanel();
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  function renderErrorPanel() {
    const body = document.getElementById('error-panel-body');
    if (!body) return;
    if (errorLog.length === 0) {
      body.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">No errors logged.</div>';
      return;
    }
    let html = '';
    for (let i = errorLog.length - 1; i >= 0; i--) {
      const e = errorLog[i];
      html += `<div class="error-log-entry">`;
      html += `<div class="error-log-header"><span class="error-log-context">${escHtml(e.context)}</span>`;
      html += `<span class="error-log-time">${escHtml(e.timestamp.replace('T', ' ').substring(0, 19))}</span></div>`;
      html += `<div class="error-log-msg">${escHtml(e.message)}</div>`;
      if (e.details) html += `<div class="error-log-details">${escHtml(e.details)}</div>`;
      if (e.stack) html += `<pre class="error-log-stack">${escHtml(e.stack)}</pre>`;
      html += `</div>`;
    }
    body.innerHTML = html;
  }

  async function copyErrorLog() {
    if (errorLog.length === 0) { toast('No errors to copy', 'info'); return; }
    const text = errorLog.map(e => {
      const lines = [`[${e.timestamp}] ${e.context}`, `Message: ${e.message}`];
      if (e.details) lines.push(`Details: ${e.details}`);
      if (e.stack) lines.push(`Stack:\n${e.stack}`);
      return lines.join('\n');
    }).join('\n\n---\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Error log copied!', 'success');
    } catch (err) {
      toast(`Copy failed: ${err.message}`, 'error');
    }
  }

  function clearErrorLog() {
    errorLog = [];
    updateErrorBadge();
    renderErrorPanel();
    toast('Error log cleared', 'info');
  }

  function getErrorLog() {
    return errorLog;
  }

  // Global error handlers
  window.addEventListener('error', (event) => {
    logError('Uncaught Error', event.error || new Error(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    logError('Unhandled Promise', event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
  });

  // Service Worker
  let _swVisibilityListenerAdded = false;
  let _swControllerChangeListenerAdded = false;
  let _swUpdateToastShown = false;
  function registerSW() {
    if ('serviceWorker' in navigator) {
      // Track whether there was already a controller when the page loaded.
      // Used to distinguish a first-time install (no reload needed) from an
      // update (user must reload to get fresh assets).
      const hadController = !!navigator.serviceWorker.controller;

      // Shared helper — show a persistent, tap-to-reload banner when a new
      // version of the SW has taken over.  duration:0 keeps it visible until
      // the user acts; the onClick callback reloads the page to apply the
      // freshly cached assets.  The flag prevents both the statechange path
      // and the controllerchange path from each firing for the same update,
      // which would stack two identical toasts.
      function showUpdateToast() {
        if (_swUpdateToastShown) return;
        _swUpdateToastShown = true;
        toast('App updated — tap here to reload', 'info', {
          duration: 0,
          onClick: () => window.location.reload(),
        });
      }

      navigator.serviceWorker.register('sw.js').then(reg => {
        console.log('SW registered:', reg.scope);

        // Detect when a new service worker is installed and waiting to activate
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // A new version has been cached and is ready — show persistent tap-to-reload prompt
              showUpdateToast();
            }
          });
        });
      }).catch(err => {
        logError('SW registration', err);
      });

      // Also listen for the controller changing (fires after skipWaiting + clients.claim).
      // This is a reliable second trigger in case the statechange fires too fast.
      // Guard against duplicate registrations if registerSW() is ever called again.
      if (!_swControllerChangeListenerAdded) {
        _swControllerChangeListenerAdded = true;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadController) return; // first install — no reload needed
          showUpdateToast();
        });
      }

      // Re-check for SW updates whenever the user returns to the tab (register once)
      if (!_swVisibilityListenerAdded) {
        _swVisibilityListenerAdded = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            navigator.serviceWorker.getRegistration().then(reg => {
              if (reg) reg.update().catch(() => {});
            }).catch(() => {});
          }
        });
      }
    }
  }

  // Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) hideModal();
  });

  // Init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { navigate, refreshPage, showModal, hideModal, toast, logError, toggleErrorPanel, copyErrorLog, clearErrorLog, getErrorLog };
})();
