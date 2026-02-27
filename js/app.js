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
      try { previousPageModule.onUnmount(); } catch (e) { console.warn('onUnmount error:', e); }
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
      console.error('Page render error:', err);
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
  function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  // Service Worker
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(reg => {
        console.log('SW registered:', reg.scope);
      }).catch(err => {
        console.warn('SW registration failed:', err);
      });
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

  return { navigate, refreshPage, showModal, hideModal, toast };
})();
