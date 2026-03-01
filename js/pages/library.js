/**
 * Library Page - View, resume, export, and delete comics
 * Includes PDF export using browser print or jsPDF-like canvas rendering
 */
const LibraryPage = (() => {
  let viewingComicId = null;

  // Search / filter state — persists within a session, reset on unmount
  let _searchQuery = '';
  let _genreFilter = '';

  async function render(param) {
    if (param && param.length > 10) {
      viewingComicId = param;
      return renderComic(param);
    }
    viewingComicId = null;
    return renderList();
  }

  function applyFilter(comics) {
    const q = _searchQuery.toLowerCase().trim();
    return comics.filter(c => {
      const matchesSearch = !q ||
        c.title.toLowerCase().includes(q) ||
        (c.genreName || c.genre || '').toLowerCase().includes(q);
      const matchesGenre = !_genreFilter || c.genre === _genreFilter;
      return matchesSearch && matchesGenre;
    });
  }

  function setSearch(query) {
    _searchQuery = query;
    App.refreshPage();
  }

  function setGenre(genre) {
    _genreFilter = genre;
    App.refreshPage();
  }

  function clearFilter() {
    _searchQuery = '';
    _genreFilter = '';
    App.refreshPage();
  }

  async function renderList() {
    const comics = await DB.getAll(DB.STORES.comics);
    comics.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

    const filtered = applyFilter(comics);
    // Collect genres that exist in the collection for the filter dropdown
    const usedGenreIds = [...new Set(comics.map(c => c.genre).filter(Boolean))];
    const usedGenres = GENRES.filter(g => usedGenreIds.includes(g.id));

    return `
      <div class="slide-up">
        <h2 class="section-title">My Comics</h2>
        <p class="section-subtitle">Your comic book collection</p>

        ${comics.length > 1 ? `
          <div style="display:flex;gap:8px;margin-bottom:12px;">
            <input type="search" placeholder="Search..." value="${escHtml(_searchQuery)}"
              oninput="LibraryPage.setSearch(this.value)"
              style="flex:1;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:0.9rem;">
            ${usedGenres.length > 1 ? `
              <select onchange="LibraryPage.setGenre(this.value)"
                style="padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:0.9rem;">
                <option value="" ${!_genreFilter ? 'selected' : ''}>All Genres</option>
                ${usedGenres.map(g => `<option value="${g.id}" ${_genreFilter === g.id ? 'selected' : ''}>${escHtml(g.name)}</option>`).join('')}
              </select>
            ` : ''}
          </div>
        ` : ''}

        ${comics.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">&#128214;</div>
            <div class="empty-state-text">No comics yet. Create your first one!</div>
            <button class="btn btn-primary" onclick="App.navigate('create')">Create Comic</button>
          </div>
        ` : filtered.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-text">No comics match your search.</div>
            <button class="btn btn-secondary btn-sm" onclick="LibraryPage.clearFilter()">Clear Filter</button>
          </div>
        ` : filtered.map(c => `
          <div class="list-item" onclick="App.navigate('library', '${c.id}')">
            <div class="list-item-avatar">${getGenreEmoji(c.genre)}</div>
            <div class="list-item-info">
              <div class="list-item-title">${escHtml(c.title)}</div>
              <div class="list-item-desc">
                ${escHtml(c.genreName || c.genre)} &middot; ${c.pageCount || 0} pages
                ${c.finished ? ' &middot; Complete' : ' &middot; In Progress'}
                &middot; ${timeAgo(c.updatedAt || c.createdAt)}
              </div>
            </div>
            <div class="list-item-actions">
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();LibraryPage.deleteComic('${c.id}','${escHtml(c.title)}')">&#128465;</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function renderComic(comicId) {
    const comic = await DB.get(DB.STORES.comics, comicId);
    if (!comic) return '<p class="text-muted">Comic not found</p>';

    const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', comicId);
    pages.sort((a, b) => a.pageNum - b.pageNum);

    return `
      <div class="slide-up">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="btn btn-sm btn-secondary" onclick="LibraryPage.backToList()">&#8592; Back</button>
          <div style="flex:1;">
            <h2 class="section-title" style="margin:0;">${escHtml(comic.title)}</h2>
            <p class="text-sm text-muted">${escHtml(comic.genreName || comic.genre)} &middot; ${pages.length} pages</p>
          </div>
        </div>

        <!-- Actions -->
        <div class="btn-group mb-md" style="flex-wrap:wrap;">
          ${!comic.finished ? `<button class="btn btn-primary btn-sm" onclick="App.navigate('create', '${comic.id}')">Continue Story</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="LibraryPage.exportPDF('${comic.id}')">Export PDF</button>
          <button class="btn btn-danger btn-sm" onclick="LibraryPage.deleteComic('${comic.id}','${escHtml(comic.title)}')">Delete</button>
        </div>

        <!-- Comic Pages -->
        <div id="comic-render-area">
          ${pages.map((p, i) => `
            <div class="card">
              <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
                <span class="card-title">Page ${i + 1}${p.data?.title ? ': ' + escHtml(p.data.title) : ''}</span>
                <button class="btn btn-sm btn-secondary" onclick="LibraryPage.downloadPageImage(${i})">&#128247; Save Image</button>
              </div>
              <div class="comic-page${p.data?.panels?.length >= 3 ? ' layout-grid' : ''}">
                ${renderPanels(p.data)}
              </div>
            </div>
          `).join('')}
        </div>

        ${pages.length === 0 ? '<p class="text-muted text-center">No pages generated yet.</p>' : ''}
      </div>
    `;
  }

  function renderPanels(pageData) {
    if (!pageData || !pageData.panels) return '<p class="text-muted">Empty page</p>';

    return pageData.panels.map((panel, i) => `
      <div class="comic-panel">
        ${panel.imageUrl ? `<img src="${panel.imageUrl}" alt="Panel ${i+1}" loading="lazy" class="zoomable-panel" style="cursor:zoom-in;">` :
          panel.imagePrompt ? `<div style="background:linear-gradient(135deg,#1a1a3e,#2a1a4e);padding:20px;min-height:150px;display:flex;align-items:center;justify-content:center;"><p class="text-sm" style="color:#9898cc;font-style:italic;text-align:center;">${escHtml(panel.imagePrompt).slice(0, 200)}</p></div>` :
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

  /**
   * Open a panel image full-size in the modal lightbox.
   * src is set via DOM after the modal renders to safely handle data URLs.
   */
  function zoomImage(src) {
    App.showModal(`
      <div style="text-align:center;padding:8px;">
        <img id="zoom-img" style="max-width:100%;max-height:75vh;border-radius:8px;display:block;margin:0 auto 12px;">
        <button class="btn btn-secondary" onclick="App.hideModal()">Close</button>
      </div>
    `);
    const imgEl = document.getElementById('zoom-img');
    if (imgEl) imgEl.src = src;
  }

  /** Bind zoom click handlers after the comic reader HTML is in the DOM. */
  function onMount() {
    document.querySelectorAll('.zoomable-panel').forEach(img => {
      img.addEventListener('click', function () { zoomImage(this.src); });
    });
  }

  function onUnmount() {
    _searchQuery = '';
    _genreFilter = '';
  }

  function backToList() {
    viewingComicId = null;
    App.refreshPage();
  }

  async function deleteComic(id, title) {
    App.showModal(`
      <div class="modal-title">Delete Comic</div>
      <p>Delete <strong>${escHtml(title)}</strong> and all its pages?</p>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
        <button class="btn btn-danger btn-sm" onclick="LibraryPage.confirmDelete('${id}')">Delete</button>
      </div>
    `);
  }

  async function confirmDelete(id) {
    // Delete all pages for this comic
    const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', id);
    for (const p of pages) await DB.del(DB.STORES.pages, p.id);
    await DB.del(DB.STORES.comics, id);
    App.hideModal();
    App.toast('Comic deleted', 'info');
    viewingComicId = null;
    App.refreshPage();
  }

  /**
   * PDF Export using canvas rendering
   * Creates a printable PDF-like output using window.print() or canvas-based approach
   */
  async function exportPDF(comicId) {
    const comic = await DB.get(DB.STORES.comics, comicId);
    if (!comic) return App.toast('Comic not found', 'error');

    const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', comicId);
    pages.sort((a, b) => a.pageNum - b.pageNum);

    if (pages.length === 0) return App.toast('No pages to export', 'error');

    App.toast('Preparing PDF...', 'info');

    // Build a printable HTML document
    const printContent = buildPrintHTML(comic, pages);

    // Open in new window for printing
    const printWindow = window.open('', '_blank', 'width=800,height=1100');
    if (!printWindow) {
      // Fallback: download as HTML
      const blob = new Blob([printContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${comic.title.replace(/[^a-z0-9]/gi, '_')}.html`;
      a.click();
      URL.revokeObjectURL(url);
      App.toast('Downloaded as HTML (enable popups for PDF)', 'info');
      return;
    }

    printWindow.document.write(printContent);
    printWindow.document.close();

    // Trigger print after images load
    printWindow.onload = () => {
      setTimeout(() => {
        printWindow.print();
      }, 500);
    };
  }

  function buildPrintHTML(comic, pages) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escHtml(comic.title)}</title>
<style>
  @page { margin: 0.5in; size: letter; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Comic Sans MS', 'Segoe UI', sans-serif; background: #fff; color: #000; }
  .cover { text-align: center; padding: 40vh 20px 0; page-break-after: always; }
  .cover h1 { font-size: 2.5rem; margin-bottom: 12px; }
  .cover .genre { font-size: 1.2rem; color: #666; }
  .page-container { page-break-after: always; padding: 20px 0; }
  .page-title { font-size: 1.2rem; font-weight: bold; margin-bottom: 16px; text-align: center; }
  .panel { border: 3px solid #000; border-radius: 8px; margin-bottom: 16px; overflow: hidden; background: #fafafa; }
  .panel img { width: 100%; display: block; }
  .narration { background: #fffde7; border: 1px solid #e6d85e; padding: 10px 14px; margin: 10px; border-radius: 4px; font-style: italic; font-size: 0.95rem; }
  .dialogue-bubble { background: #fff; border: 2px solid #000; border-radius: 18px; padding: 10px 16px; margin: 10px; position: relative; }
  .dialogue-bubble::after { content:''; position:absolute; bottom:-10px; left:24px; width:0; height:0; border-left:10px solid transparent; border-right:10px solid transparent; border-top:10px solid #000; }
  .speaker { font-weight: bold; font-size: 0.8rem; color: #555; margin-bottom: 4px; }
  .img-placeholder { background: #eee; padding: 30px; text-align: center; color: #999; font-style: italic; min-height: 200px; display: flex; align-items: center; justify-content: center; }
  .panels-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .panels-grid .panel:first-child { grid-column: 1 / -1; }
  .panels-grid .panel:last-child:nth-child(even) { grid-column: 1 / -1; }
</style>
</head>
<body>
  <div class="cover">
    <h1>${escHtml(comic.title)}</h1>
    <div class="genre">${escHtml(comic.genreName || comic.genre)}</div>
    <div style="margin-top:20px;color:#999;">Generated with AI Comic Creator</div>
  </div>

  ${pages.map((p, i) => `
    <div class="page-container">
      <div class="page-title">Page ${i + 1}${p.data?.title ? ': ' + escHtml(p.data.title) : ''}</div>
      <div class="${(p.data?.panels?.length >= 3) ? 'panels-grid' : ''}">
      ${(p.data?.panels || []).map((panel, pi) => `
        <div class="panel">
          ${panel.imageUrl ? `<img src="${panel.imageUrl}" alt="Panel ${pi+1}">` :
            panel.imagePrompt ? `<div class="img-placeholder">${escHtml(panel.imagePrompt).slice(0, 200)}</div>` : ''}
          ${panel.narration ? `<div class="narration">${escHtml(panel.narration)}</div>` : ''}
          ${(panel.dialogue || []).map(d => `
            <div class="dialogue-bubble">
              <div class="speaker">${escHtml(d.speaker)}</div>
              <div>${escHtml(d.text)}</div>
            </div>
          `).join('')}
        </div>
      `).join('')}
      </div>
    </div>
  `).join('')}
</body>
</html>`;
  }

  /**
   * Render a comic page to Canvas and download as PNG image.
   */
  async function downloadPageImage(pageIdx) {
    if (!viewingComicId) return;

    const pages = await DB.getByIndex(DB.STORES.pages, 'comicId', viewingComicId);
    pages.sort((a, b) => a.pageNum - b.pageNum);
    const page = pages[pageIdx];
    if (!page?.data) return App.toast('Page not found', 'error');

    App.toast('Rendering page image...', 'info');
    const panels = page.data.panels || [];
    const W = 800;
    const PAD = 16;
    const panelW = W - PAD * 2;

    // Pre-load all panel images
    const loadedImages = await Promise.all(panels.map(p => {
      if (!p.imageUrl) return Promise.resolve(null);
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = p.imageUrl;
      });
    }));

    // Calculate total height
    let totalH = PAD;
    const panelHeights = panels.map((panel, i) => {
      let h = 0;
      const img = loadedImages[i];
      if (img) {
        h += panelW * (img.naturalHeight / img.naturalWidth);
      } else {
        h += 200;
      }
      if (panel.narration) h += 50;
      if (panel.dialogue) h += panel.dialogue.length * 60;
      return h + PAD;
    });
    totalH += panelHeights.reduce((a, b) => a + b, 0) + PAD;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, totalH);

    // Title
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 18px sans-serif';
    const titleText = `Page ${pageIdx + 1}${page.data.title ? ': ' + page.data.title : ''}`;
    ctx.fillText(titleText, PAD, PAD + 14, panelW);

    let y = PAD + 30;

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      const img = loadedImages[i];
      const x = PAD;

      // Panel border
      ctx.strokeStyle = '#333333';
      ctx.lineWidth = 3;

      if (img) {
        const imgH = panelW * (img.naturalHeight / img.naturalWidth);
        ctx.drawImage(img, x, y, panelW, imgH);
        ctx.strokeRect(x, y, panelW, imgH);
        y += imgH;
      } else {
        ctx.fillStyle = '#eeeeff';
        ctx.fillRect(x, y, panelW, 200);
        ctx.strokeRect(x, y, panelW, 200);
        if (panel.imagePrompt) {
          ctx.fillStyle = '#666688';
          ctx.font = 'italic 13px sans-serif';
          ctx.fillText(panel.imagePrompt.slice(0, 80) + '...', x + 16, y + 105, panelW - 32);
        }
        y += 200;
      }

      // Narration box
      if (panel.narration) {
        ctx.fillStyle = '#fffde7';
        ctx.fillRect(x + 8, y + 4, panelW - 16, 40);
        ctx.strokeStyle = '#e6d85e';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 8, y + 4, panelW - 16, 40);
        ctx.fillStyle = '#333333';
        ctx.font = 'italic 14px sans-serif';
        ctx.fillText(panel.narration.slice(0, 100), x + 16, y + 28, panelW - 32);
        y += 50;
      }

      // Dialogue bubbles
      for (const d of (panel.dialogue || [])) {
        const bx = x + 16, by = y + 4, bw = panelW - 32, bh = 48, r = 12;

        // Rounded rect bubble
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by);
        ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
        ctx.lineTo(bx + r, by + bh);
        ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Bubble tail
        ctx.beginPath();
        ctx.moveTo(bx + 20, by + bh);
        ctx.lineTo(bx + 28, by + bh + 10);
        ctx.lineTo(bx + 34, by + bh);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.stroke();

        // Speaker name
        ctx.fillStyle = '#555555';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(d.speaker, bx + 12, by + 16);

        // Dialogue text
        ctx.fillStyle = '#000000';
        ctx.font = '13px sans-serif';
        ctx.fillText(d.text.slice(0, 90), bx + 12, by + 36, bw - 24);

        y += 60;
      }

      y += PAD;
    }

    // Export as PNG download
    canvas.toBlob(blob => {
      if (!blob) return App.toast('Failed to render image', 'error');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `page-${pageIdx + 1}.png`;
      a.click();
      URL.revokeObjectURL(url);
      App.toast('Page image downloaded!', 'success');
    }, 'image/png');
  }

  return {
    render, onMount, onUnmount, backToList,
    deleteComic, confirmDelete, exportPDF, downloadPageImage,
    zoomImage, setSearch, setGenre, clearFilter,
  };
})();
