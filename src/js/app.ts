import { escHtml, type PageModule } from './utils.js';
import { registerPageEventListeners } from './page-actions.js';
import DB from './db.js';
import HomePage from './pages/home.js';
import CharactersPage from './pages/characters.js';
import WorldsPage from './pages/worlds.js';
import CreatePage from './pages/create.js';
import LibraryPage from './pages/library.js';
import PresetsPage from './pages/presets.js';
import ImagePresetsPage from './pages/image-presets.js';
import SettingsPage from './pages/settings.js';
import { installReferenceQueueLifecycle } from './reference-workspace-runtime.js';

export type { PageModule };

/**
 * Main Application Router & Controller
 */
let currentPage: string = 'home';
let currentParam: string | null = null;

const pages: Record<string, PageModule & Record<string, any>> = {
  home: HomePage,
  characters: CharactersPage,
  worlds: WorldsPage,
  create: CreatePage,
  library: LibraryPage,
  presets: PresetsPage,
  'image-presets': ImagePresetsPage,
  settings: SettingsPage,
};

const pageTitles: Record<string, string> = {
  home: 'AI Comic Creator',
  characters: 'Character Builder',
  worlds: 'World Builder',
  create: 'Create Comic',
  library: 'My Comics',
  presets: 'Prompt Presets',
  'image-presets': 'Image Style Presets',
  settings: 'Settings',
};

async function init() {
  await DB.open();
  await DB.seedDefaults();
  await DB.dedupePresets();
  installReferenceQueueLifecycle();

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
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate((link as HTMLElement).dataset.page);
      closeSidebar();
    });
  });

  // Bottom nav
  document.querySelectorAll('.bnav-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigate((btn as HTMLElement).dataset.page));
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

let previousPageModule: (PageModule & Record<string, any>) | null = null;

async function navigate(page: string, param: string | null = null): Promise<void> {
  if (!pages[page]) return;

  // Call onUnmount on the previous page if it has one
  if (previousPageModule && typeof previousPageModule.onUnmount === 'function') {
    try {
      previousPageModule.onUnmount();
    } catch (e) {
      logError('onUnmount', e);
    }
  }

  currentPage = page;
  currentParam = param;
  previousPageModule = pages[page];

  // Update URL hash
  window.location.hash = page;

  // Update title
  document.getElementById('page-title').textContent = pageTitles[page] || page;

  // Update active states
  document.querySelectorAll('.nav-link').forEach((l) => {
    l.classList.toggle('active', (l as HTMLElement).dataset.page === page);
  });
  document.querySelectorAll('.bnav-btn').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.page === page);
  });

  // Render page
  const content = document.getElementById('content');
  try {
    logDebug('Navigation', `Rendering page "${page}"${param ? ` (param: ${param})` : ''}`);
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

function getCurrentPage(): string {
  return currentPage;
}

/** Show/hide the top-bar "generation in progress" spinner badge. */
function setGenIndicator(visible: boolean): void {
  const el = document.getElementById('gen-indicator');
  if (el) el.classList.toggle('hidden', !visible);
}

// Modal
function showModal(html: string): void {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function hideModal(): void {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// Toast
interface ToastOptions {
  duration?: number;
  onClick?: (() => void) | null;
}

function toast(message: string, type: string = 'info', options: ToastOptions = {}): void {
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

// --- Global Debug Log ---
// Captures errors, warnings, and informational debug events so the panel can
// be used to trace app behavior, not just failures.
type DebugLogLevel = 'error' | 'warn' | 'info';

interface DebugLogEntry {
  timestamp: string;
  level: DebugLogLevel;
  context: string;
  message: string;
  stack: string | null;
  details: string | null;
}

const MAX_LOG_ENTRIES = 500;
const LOG_TRIM_HYSTERESIS = 50;
let debugLog: DebugLogEntry[] = [];
let errorPanelOpen: boolean = false;

function addLogEntry(
  level: DebugLogLevel,
  context: string,
  message: string,
  stack?: string | null,
  details?: string | null,
): void {
  debugLog.push({
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
    stack: stack || null,
    details: details || null,
  });
  // Trim in batches (hysteresis) so we don't shift the array on every push once at capacity.
  if (debugLog.length > MAX_LOG_ENTRIES + LOG_TRIM_HYSTERESIS) debugLog.splice(0, debugLog.length - MAX_LOG_ENTRIES);
  updateErrorBadge();
  if (errorPanelOpen) renderErrorPanel();
}

function logError(context: string, error: any, extraDetails?: string): void {
  addLogEntry('error', context, error?.message || String(error), error?.stack, extraDetails);
}

function logWarn(context: string, message: string, extraDetails?: string): void {
  addLogEntry('warn', context, message, null, extraDetails);
}

function logDebug(context: string, message: string, extraDetails?: string): void {
  addLogEntry('info', context, message, null, extraDetails);
}

function updateErrorBadge(): void {
  const badge = document.getElementById('error-badge');
  if (!badge) return;
  const errorCount = debugLog.filter((e) => e.level === 'error').length;
  if (errorCount === 0) {
    badge.classList.add('hidden');
  } else {
    badge.classList.remove('hidden');
    badge.textContent = errorCount > 99 ? '99+' : String(errorCount);
  }
}

function toggleErrorPanel(): void {
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

function renderErrorPanel(): void {
  const body = document.getElementById('error-panel-body');
  if (!body) return;
  if (debugLog.length === 0) {
    body.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">No log entries.</div>';
    return;
  }
  let html = '';
  for (let i = debugLog.length - 1; i >= 0; i--) {
    const e = debugLog[i];
    html += `<div class="error-log-entry error-log-entry-${e.level}">`;
    html += `<div class="error-log-header"><span class="error-log-level error-log-level-${e.level}">${e.level.toUpperCase()}</span>`;
    html += `<span class="error-log-context">${escHtml(e.context)}</span>`;
    html += `<span class="error-log-time">${escHtml(e.timestamp.replace('T', ' ').substring(0, 19))}</span></div>`;
    html += `<div class="error-log-msg">${escHtml(e.message)}</div>`;
    if (e.details) html += `<div class="error-log-details">${escHtml(e.details)}</div>`;
    if (e.stack) html += `<pre class="error-log-stack">${escHtml(e.stack)}</pre>`;
    html += `</div>`;
  }
  body.innerHTML = html;
}

async function copyErrorLog() {
  if (debugLog.length === 0) {
    toast('No log entries to copy', 'info');
    return;
  }
  const text = debugLog
    .map((e) => {
      const lines = [`[${e.timestamp}] [${e.level.toUpperCase()}] ${e.context}`, `Message: ${e.message}`];
      if (e.details) lines.push(`Details: ${e.details}`);
      if (e.stack) lines.push(`Stack:\n${e.stack}`);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Debug log copied!', 'success');
  } catch (err) {
    toast(`Copy failed: ${err.message}`, 'error');
  }
}

function clearErrorLog(): void {
  debugLog = [];
  updateErrorBadge();
  renderErrorPanel();
  toast('Debug log cleared', 'info');
}

function getErrorLog(): DebugLogEntry[] {
  return debugLog;
}

// Global error handlers
window.addEventListener('error', (event) => {
  logError('Uncaught Error', event.error || new Error(event.message));
});
window.addEventListener('unhandledrejection', (event) => {
  logError('Unhandled Promise', event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
});

// Service Worker (Workbox-generated by vite-plugin-pwa)
let _swVisibilityListenerAdded: boolean = false;
let _swControllerChangeListenerAdded: boolean = false;
let _swUpdateToastShown: boolean = false;
function registerSW(): void {
  if ('serviceWorker' in navigator) {
    // Clean up old hand-written SW caches from before the Vite migration
    if ('caches' in window) {
      caches.keys().then((keys) => {
        keys.filter((k) => k.startsWith('comic-creator-')).forEach((k) => caches.delete(k));
      });
    }

    // Track whether there was already a controller when the page loaded.
    const hadController = !!navigator.serviceWorker.controller;

    function showUpdateToast() {
      if (_swUpdateToastShown) return;
      _swUpdateToastShown = true;
      toast('App updated — tap here to reload', 'info', {
        duration: 0,
        onClick: () => window.location.reload(),
      });
    }

    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        console.log('SW registered:', reg.scope);

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast();
            }
          });
        });
      })
      .catch((err) => {
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
          navigator.serviceWorker
            .getRegistration()
            .then((reg) => {
              if (reg) reg.update().catch(() => {});
            })
            .catch(() => {});
        }
      });
    }
  }
}

// Close modal on overlay click
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) hideModal();
});

// Delegated page events: templates use data-action / data-action-change /
// data-action-input / data-navigate instead of inline onclick handlers.
// Dispatch semantics live in page-actions.ts.
registerPageEventListeners({
  getPage: () => currentPage,
  getModule: (page) => pages[page],
  navigate,
  logWarn,
  logError,
});

// Init on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

const App = {
  navigate,
  refreshPage,
  getCurrentPage,
  setGenIndicator,
  showModal,
  hideModal,
  toast,
  logError,
  logWarn,
  logDebug,
  toggleErrorPanel,
  copyErrorLog,
  clearErrorLog,
  getErrorLog,
};
export default App;

// Expose to window for the few remaining inline App.* handlers (index.html
// error panel, modal Cancel buttons) and the Playwright smoke tests. Page
// modules are reached via the delegated data-action dispatcher instead.
window.App = App;
