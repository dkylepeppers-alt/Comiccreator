/**
 * Home Page
 */
const { GENRES, escHtml, timeAgo, getGenreEmoji } = globalThis;

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
          <div style="font-size:3rem;margin-bottom:8px;animation:float 3s ease-in-out infinite;">🎨</div>
          <h2 style="font-size:1.8rem;font-weight:800;margin-bottom:8px;">
            <span style="background:linear-gradient(135deg,var(--accent),#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">AI Comic Creator</span>
          </h2>
          <p class="text-muted">Create unique comics with AI-generated stories and artwork</p>
        </div>

        <!-- Quick Stats -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:24px;">
          <div class="card-glass text-center" style="padding:16px;">
            <div style="font-size:1.4rem;margin-bottom:4px;">📚</div>
            <div style="font-size:1.6rem;font-weight:800;color:var(--accent);">${comics.length}</div>
            <div class="text-sm text-muted">Comics</div>
          </div>
          <div class="card-glass text-center" style="padding:16px;">
            <div style="font-size:1.4rem;margin-bottom:4px;">🦸</div>
            <div style="font-size:1.6rem;font-weight:800;color:var(--accent);">${characters.length}</div>
            <div class="text-sm text-muted">Characters</div>
          </div>
          <div class="card-glass text-center" style="padding:16px;">
            <div style="font-size:1.4rem;margin-bottom:4px;">🌍</div>
            <div style="font-size:1.6rem;font-weight:800;color:var(--accent);">${worlds.length}</div>
            <div class="text-sm text-muted">Worlds</div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="card-glass">
          <h3 class="card-title mb-sm">Quick Start</h3>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="btn btn-primary btn-block" onclick="App.navigate('create')">✨ Create New Comic</button>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <button class="btn btn-secondary" onclick="App.navigate('characters')">Add Character</button>
              <button class="btn btn-secondary" onclick="App.navigate('worlds')">Build World</button>
            </div>
          </div>
        </div>

        <!-- Recent Comics -->
        ${
          recentComics.length > 0
            ? `
          <div class="mt-md">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <h3 class="card-title">Recent Comics</h3>
              <button class="btn btn-sm btn-secondary" onclick="App.navigate('library')">View All</button>
            </div>
            ${recentComics
              .map(
                (c) => `
              <div class="list-item" onclick="App.navigate('library', '${c.id}')">
                <div class="list-item-avatar">${getGenreEmoji(c.genre)}</div>
                <div class="list-item-info">
                  <div class="list-item-title">${escHtml(c.title)}</div>
                  <div class="list-item-desc">${escHtml(c.genre)} &middot; ${c.pageCount || 0} pages &middot; ${timeAgo(c.updatedAt || c.createdAt)}</div>
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        `
            : `
          <div class="empty-state mt-md">
            <div class="empty-state-icon">&#128214;</div>
            <div class="empty-state-text">No comics yet. Create your first one!</div>
          </div>
        `
        }

        <!-- Genre Showcase -->
        <div class="mt-md">
          <h3 class="card-title mb-sm">Available Genres</h3>
          <div class="genre-grid">
            ${GENRES.map(
              (g) => `
              <div class="genre-card" onclick="App.navigate('create', '${g.id}')">
                <span class="genre-emoji">${g.emoji}</span>
                ${g.name}
              </div>
            `,
            ).join('')}
          </div>
        </div>
      </div>
    `;
  }

  return { render };
})();
