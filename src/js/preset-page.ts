// @ts-nocheck
import { escHtml, dedupeByNameLatest } from './utils.js';
import DB from './db.js';

/**
 * Shared page factory for the two preset pages (Prompt Presets and Image Style
 * Presets). Both pages are the same list/edit CRUD flow over a DB store; the
 * per-page pieces — list card markup, editor form, and field collection — are
 * injected via config. Generated markup uses data-action attributes resolved
 * against the current page module by app.ts's delegated dispatcher, so the
 * returned method names must stay stable.
 *
 * config fields:
 * - store: DB store name
 * - navKey: App.navigate() page key ('presets' | 'image-presets')
 * - label: entity label for toasts ('Preset' | 'Image preset')
 * - deleteModalTitle: title of the delete confirmation modal
 * - title / subtitle: list-view header texts
 * - emptyIcon / emptyText: empty-state content
 * - listItem: (preset) => list card HTML
 * - defaults: default field values for a new preset
 * - editorHtml: (preset, editingId) => editor view HTML
 * - collectFields: () => field object read from the editor DOM, or null after
 *   toasting a validation error (aborts the save)
 */
export function createPresetPage(cfg) {
  let currentView: string = 'list';
  let editingId: string | null = null;

  async function render(param?: string | null): Promise<string> {
    if (param === 'new') {
      currentView = 'edit';
      editingId = null;
    } else if (param) {
      // param is a preset ID — switch to edit mode
      currentView = 'edit';
      editingId = param;
    } else {
      // Reset to list view on normal navigation (prevents stale edit state)
      currentView = 'list';
      editingId = null;
    }
    if (currentView === 'edit') return renderEditor();
    return renderList();
  }

  async function renderList() {
    const presets = dedupeByNameLatest(await DB.getAll(cfg.store));

    return `
    <div class="slide-up">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <h2 class="section-title" style="margin-bottom:4px;">${cfg.title}</h2>
          <p class="text-sm text-muted">${cfg.subtitle}</p>
        </div>
        <button class="btn btn-primary btn-sm" data-action="newPreset">+ New</button>
      </div>

      ${
        presets.length === 0
          ? `
        <div class="empty-state">
          <div class="empty-state-icon">${cfg.emptyIcon}</div>
          <div class="empty-state-text">${cfg.emptyText}</div>
          <button class="btn btn-primary" data-action="newPreset">Create Preset</button>
        </div>
      `
          : presets.map((p) => cfg.listItem(p)).join('')
      }
    </div>
  `;
  }

  async function renderEditor() {
    let preset = { ...cfg.defaults };
    if (editingId) {
      const saved = await DB.get(cfg.store, editingId);
      if (saved) preset = { ...preset, ...saved };
    }
    return cfg.editorHtml(preset, editingId);
  }

  function newPreset() {
    App.navigate(cfg.navKey, 'new');
  }

  async function editPreset(id: string): Promise<void> {
    App.navigate(cfg.navKey, id);
  }

  function backToList() {
    App.navigate(cfg.navKey, null);
  }

  async function savePreset() {
    const fields = cfg.collectFields();
    if (!fields) return;

    const preset = {
      id: editingId || DB.uuid(),
      ...fields,
      createdAt: editingId ? (await DB.get(cfg.store, editingId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await DB.put(cfg.store, preset);
    App.toast(`${cfg.label} ${editingId ? 'updated' : 'created'}!`, 'success');
    backToList();
  }

  async function deletePreset(id: string, name?: string): Promise<void> {
    if (!name) name = (await DB.get(cfg.store, id))?.name || 'this preset';
    App.showModal(`
    <div class="modal-title">${cfg.deleteModalTitle}</div>
    <p>Delete preset <strong>${escHtml(name)}</strong>?</p>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
      <button class="btn btn-danger btn-sm" data-action="confirmDelete" data-args="${escHtml(JSON.stringify([id]))}">Delete</button>
    </div>
  `);
  }

  async function confirmDelete(id: string): Promise<void> {
    await DB.del(cfg.store, id);
    App.hideModal();
    App.toast(`${cfg.label} deleted`, 'info');
    App.refreshPage();
  }

  function onUnmount(): void {
    currentView = 'list';
    editingId = null;
  }

  return {
    render,
    onUnmount,
    newPreset,
    editPreset,
    backToList,
    savePreset,
    deletePreset,
    confirmDelete,
  };
}
