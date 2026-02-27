/**
 * Library Page - View, resume, export, and delete comics
 * Includes PDF export using browser print or jsPDF-like canvas rendering
 */
const LibraryPage = (() => {
  let viewingComicId = null;

  async function render(param) {
    if (param && param.length > 10) {
      viewingComicId = param;
      return renderComic(param);
    }
    viewingComicId = null;
    return renderList();
  }

  async function renderList() {
    const comics = await DB.getAll(DB.STORES.comics);
    comics.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

    return `
      <div class="slide-up">
        <h2 class="section-title">My Comics</h2>
        <p class="section-subtitle">Your comic book collection</p>

        ${comics.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">&#128214;</div>
            <div class="empty-state-text">No comics yet. Create your first one!</div>
            <button class="btn btn-primary" onclick="App.navigate('create')">Create Comic</button>
          </div>
        ` : comics.map(c => `
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
              <div class="card-header">
                <span class="card-title">Page ${i + 1}${p.data?.title ? ': ' + escHtml(p.data.title) : ''}</span>
              </div>
              <div class="comic-page">
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
        ${panel.imageUrl ? `<img src="${panel.imageUrl}" alt="Panel ${i+1}" loading="lazy">` :
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

  function backToList() {
    viewingComicId = null;
    App.refreshPage();
  }

  async function deleteComic(id, title) {
    App.showModal(`
      <div class="modal-title">Delete Comic</div>
      <p>Delete <strong>${title}</strong> and all its pages?</p>
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
  `).join('')}
</body>
</html>`;
  }

  return { render, backToList, deleteComic, confirmDelete, exportPDF };
})();
