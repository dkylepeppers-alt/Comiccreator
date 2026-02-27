/**
 * Home Page
 */
const HomePage = (() => {
  async function render() {
    const [comics, characters, worlds] = await Promise.all([
      DB.getAll(DB.STORES.comics),
      DB.getAll(DB.STORES.characters),
      DB.getAll(DB.STORES.worlds),
    ]);
    const recentComics = comics.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)).slice(0, 3);

    return `
      <div class="slide-up">
        <div class="text-center mb-md">
          <h2 style="font-size:1.8rem;font-weight:800;margin-bottom:8px;">
            <span style="background:linear-gradient(135deg,var(--accent),#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">AI Comic Creator</span>
          </h2>
          <p class="text-muted">Create unique comics with AI-generated stories and artwork</p>
        </div>

        <!-- Quick Stats -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:24px;">
          <div class="card text-center" style="padding:14px;">
            <div style="font-size:1.6rem;font-weight:800;color:var(--accent);">${comics.length}</div>
            <div class="text-sm text-muted">Comics</div>
          </div>
          <div class="card text-center" style="padding:14px;">
            <div style="font-size:1.6rem;font-weight:800;color:var(--accent);">${characters.length}</div>
            <div class="text-sm text-muted">Characters</div>
          </div>
          <div class="card text-center" style="padding:14px;">
            <div style="font-size:1.6rem;font-weight:800;color:var(--accent);">${worlds.length}</div>
            <div class="text-sm text-muted">Worlds</div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="card">
          <h3 class="card-title mb-sm">Quick Start</h3>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="btn btn-primary btn-block" onclick="App.navigate('create')">Create New Comic</button>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <button class="btn btn-secondary" onclick="App.navigate('characters')">Add Character</button>
              <button class="btn btn-secondary" onclick="App.navigate('worlds')">Build World</button>
            </div>
          </div>
        </div>

        <!-- Recent Comics -->
        ${recentComics.length > 0 ? `
          <div class="mt-md">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <h3 class="card-title">Recent Comics</h3>
              <button class="btn btn-sm btn-secondary" onclick="App.navigate('library')">View All</button>
            </div>
            ${recentComics.map(c => `
              <div class="list-item" onclick="App.navigate('library', '${c.id}')">
                <div class="list-item-avatar">${getGenreEmoji(c.genre)}</div>
                <div class="list-item-info">
                  <div class="list-item-title">${escHtml(c.title)}</div>
                  <div class="list-item-desc">${escHtml(c.genre)} &middot; ${c.pageCount || 0} pages &middot; ${timeAgo(c.updatedAt || c.createdAt)}</div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="empty-state mt-md">
            <div class="empty-state-icon">&#128214;</div>
            <div class="empty-state-text">No comics yet. Create your first one!</div>
          </div>
        `}

        <!-- Genre Showcase -->
        <div class="mt-md">
          <h3 class="card-title mb-sm">Available Genres</h3>
          <div class="genre-grid">
            ${GENRES.map(g => `
              <div class="genre-card" onclick="App.navigate('create', '${g.id}')">
                <span class="genre-emoji">${g.emoji}</span>
                ${g.name}
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  return { render };
})();

// Shared genres list
const GENRES = [
  { id: 'classic-horror', name: 'Classic Horror', emoji: '&#128123;' },
  { id: 'superhero', name: 'Superhero Action', emoji: '&#129464;' },
  { id: 'dark-scifi', name: 'Dark Sci-Fi', emoji: '&#128125;' },
  { id: 'high-fantasy', name: 'High Fantasy', emoji: '&#128050;' },
  { id: 'neon-noir', name: 'Neon Noir', emoji: '&#128373;' },
  { id: 'wasteland', name: 'Wasteland', emoji: '&#9762;' },
  { id: 'comedy', name: 'Comedy', emoji: '&#128514;' },
  { id: 'teen-drama', name: 'Teen Drama', emoji: '&#127915;' },
  { id: 'custom', name: 'Custom', emoji: '&#9999;' },
];

// Utility functions
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function getGenreEmoji(genre) {
  const g = GENRES.find(x => x.id === genre);
  return g ? g.emoji : '&#128214;';
}
