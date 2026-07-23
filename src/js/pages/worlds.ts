// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml, slugifyName } from '../utils.js';
import DB from '../db.js';
import {
  normalizeReferenceEditorSubject,
  readReferenceEditorForm,
  type ReferenceFilter,
  type ReferenceWorkspaceAction,
} from '../reference-workspace.js';
import {
  addUploadedReference,
  closeReferenceEditor,
  fileToDataUrl,
  openGenerateReferenceDialog,
  openReferenceEditor,
  referenceRepository,
  referenceWorkspace,
  submitGenerateReference,
} from '../reference-workspace-runtime.js';

let editingId: string | null = null;
let referenceFilter: ReferenceFilter = 'all';

async function render(param?: string | null): Promise<string> {
  if (!param) {
    editingId = null;
    return renderList();
  }
  editingId = param === 'new' ? null : param;
  return renderEditor();
}

async function renderList(): Promise<string> {
  const worlds = await DB.getAll(DB.STORES.worlds);
  return `<div class="slide-up">
    <div class="section-header">
      <div>
        <h2 class="section-title">World Builder</h2>
        <p class="text-muted">Worlds own locations, characters, and every visual reference.</p>
      </div>
      <button class="btn btn-primary btn-sm" data-action="newWorld">New World</button>
    </div>
    <div class="list">
      ${
        worlds.length
          ? worlds
              .sort((left, right) => String(left.name).localeCompare(String(right.name)))
              .map(
                (
                  world,
                ) => `<article class="list-item" data-action="editWorld" data-args="${escHtml(JSON.stringify([world.id]))}">
                  <div class="list-item-avatar">&#127758;</div>
                  <div class="list-item-info">
                    <div class="list-item-title">${escHtml(world.name)}</div>
                    <div class="list-item-desc">${escHtml(world.description || '').slice(0, 100)}</div>
                  </div>
                  <div class="list-item-actions">
                    <button class="btn btn-sm btn-secondary" data-action="exportWorld" data-args="${escHtml(JSON.stringify([world.id]))}">Export</button>
                    <button class="btn btn-sm btn-danger" data-action="deleteWorld" data-args="${escHtml(JSON.stringify([world.id, world.name]))}">Delete</button>
                  </div>
                </article>`,
              )
              .join('')
          : `<div class="empty-state"><div class="empty-icon">&#127758;</div><p>No worlds yet.</p><button class="btn btn-primary" data-action="newWorld">Create World</button></div>`
      }
    </div>
  </div>`;
}

async function renderEditor(): Promise<string> {
  const saved = editingId ? await DB.get(DB.STORES.worlds, editingId) : null;
  const world = saved || {
    name: '',
    description: '',
    era: '',
    atmosphere: '',
    details: '',
  };
  const [locations, characters, workspaceHtml] = editingId
    ? await Promise.all([
        referenceRepository.listLocations(editingId),
        DB.getAll(DB.STORES.characters).then((records) =>
          records.filter((character) => (character.worldId || character.linkedWorldId) === editingId),
        ),
        referenceWorkspace.render({ worldId: editingId, filter: referenceFilter }),
      ])
    : [[], [], ''];

  return `<div class="slide-up">
    <div class="section-header">
      <button class="btn btn-sm btn-secondary" data-action="backToList">&#8592; Worlds</button>
      <h2 class="section-title">${editingId ? 'World archive' : 'New World'}</h2>
      ${editingId ? `<button class="btn btn-sm btn-secondary" data-action="exportWorld" data-args="${escHtml(JSON.stringify([editingId]))}">Export</button>` : ''}
    </div>

    <section class="card world-record-card">
      <p class="reference-eyebrow">${editingId ? `World / ${escHtml(world.name)}` : 'World / Unsaved'}</p>
      <div class="form-group">
        <label class="form-label" for="world-name">World name *</label>
        <input id="world-name" value="${escHtml(world.name)}" placeholder="Neo-Tokyo 2099">
      </div>
      <div class="form-group">
        <label class="form-label" for="world-desc">Description *</label>
        <textarea id="world-desc" rows="3" placeholder="What makes this world visually distinct?">${escHtml(world.description)}</textarea>
      </div>
      <div class="reference-form-grid">
        <div class="form-group"><label class="form-label" for="world-era">Era</label><input id="world-era" value="${escHtml(world.era || '')}"></div>
        <div class="form-group"><label class="form-label" for="world-atmosphere">Atmosphere</label><input id="world-atmosphere" value="${escHtml(world.atmosphere || '')}"></div>
      </div>
      <div class="form-group"><label class="form-label" for="world-details">Additional details</label><textarea id="world-details" rows="3">${escHtml(world.details || '')}</textarea></div>
      <button class="btn btn-primary" id="world-save-btn" data-action="saveWorld">${editingId ? 'Save world' : 'Create world'}</button>
    </section>

    ${
      editingId
        ? `<section class="reference-hierarchy">
            <div class="reference-hierarchy-column">
              <div class="reference-hierarchy-heading"><div><p class="reference-eyebrow">World / Locations</p><h3>Locations</h3></div></div>
              <div class="reference-entity-list">
                ${locations.length ? locations.map((location) => `<div class="reference-entity-row"><strong>${escHtml(location.name)}</strong><code>${escHtml(location.id)}</code><span>${escHtml(location.description || '')}</span></div>`).join('') : '<p class="text-muted">No locations yet.</p>'}
              </div>
              <div class="reference-inline-create">
                <input id="location-name" placeholder="Location name">
                <input id="location-description" placeholder="Visual description">
                <button class="btn btn-sm btn-secondary" data-action="saveLocation">Add location</button>
              </div>
            </div>
            <div class="reference-hierarchy-column">
              <div class="reference-hierarchy-heading">
                <div><p class="reference-eyebrow">World / Characters</p><h3>Characters</h3></div>
                <button class="btn btn-sm btn-secondary" data-action="newCharacterForWorld" data-args="${escHtml(JSON.stringify([editingId]))}">New character</button>
              </div>
              <div class="reference-entity-list">
                ${characters.length ? characters.map((character) => `<button class="reference-entity-row reference-entity-link" data-navigate="characters" data-param="${escHtml(character.id)}"><strong>${escHtml(character.name)}</strong><span>${escHtml(character.role || 'No role')}</span></button>`).join('') : '<p class="text-muted">No characters belong to this world yet.</p>'}
              </div>
            </div>
          </section>
          <input type="file" id="reference-upload-input" class="hidden" accept="image/*" data-action-change="handleReferenceUpload">
          ${workspaceHtml}`
        : `<section class="card reference-save-first"><strong>Save the world to open its reference archive.</strong><span>Locations, characters, and visual evidence all need a stable world ID.</span></section>`
    }
  </div>`;
}

function newWorld(): void {
  App.navigate('worlds', 'new');
}

function editWorld(id: string): void {
  App.navigate('worlds', id);
}

function backToList(): void {
  App.navigate('worlds', null);
}

async function saveWorld(): Promise<void> {
  const name = document.getElementById('world-name')?.value.trim();
  const description = document.getElementById('world-desc')?.value.trim();
  if (!name || !description) return App.toast('World name and description are required', 'error');
  const existing = editingId ? await DB.get(DB.STORES.worlds, editingId) : null;
  const id = editingId || DB.uuid();
  await DB.put(DB.STORES.worlds, {
    ...(existing || {}),
    id,
    name,
    description,
    era: document.getElementById('world-era')?.value.trim() || '',
    atmosphere: document.getElementById('world-atmosphere')?.value.trim() || '',
    details: document.getElementById('world-details')?.value.trim() || '',
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
  App.toast(editingId ? 'World saved' : 'World created', 'success');
  App.navigate('worlds', id);
}

async function saveLocation(): Promise<void> {
  if (!editingId) return;
  const name = document.getElementById('location-name')?.value.trim();
  if (!name) return App.toast('Location name is required', 'error');
  let id = slugifyName(name);
  const existing = await referenceRepository.listLocations(editingId);
  if (existing.some((location) => location.id === id)) id = `${id}-${existing.length + 1}`;
  await referenceRepository.putLocation({
    id,
    worldId: editingId,
    name,
    description: document.getElementById('location-description')?.value.trim() || '',
    aliases: [],
    preferredReferenceId: null,
  });
  App.toast('Location added', 'success');
  App.refreshPage();
}

function newCharacterForWorld(worldId: string): void {
  App.navigate('characters', `new:${worldId}`);
}

function uploadReference(): void {
  document.getElementById('reference-upload-input')?.click();
}

async function handleReferenceUpload(input: HTMLInputElement): Promise<void> {
  if (!editingId || !input.files?.[0]) return;
  await addUploadedReference({ worldId: editingId, dataUrl: await fileToDataUrl(input.files[0]) });
  input.value = '';
  App.toast('Reference added and queued for local review', 'success');
  App.refreshPage();
}

async function generateReference(): Promise<void> {
  if (!editingId) return;
  await openGenerateReferenceDialog({ worldId: editingId });
}

function setReferenceFilter(filter: ReferenceFilter): void {
  referenceFilter = filter;
  App.refreshPage();
}

async function runWorkspaceAction(
  action: ReferenceWorkspaceAction,
  referenceId?: string,
  worldId = editingId || undefined,
): Promise<void> {
  await referenceWorkspace.handleAction({ action, referenceId, worldId });
  App.refreshPage();
}

async function reviewReference(referenceId: string): Promise<void> {
  if (!editingId) return;
  await openReferenceEditor(editingId, referenceId);
}

function normalizeReferenceSubject(_referenceId: string, element: HTMLElement): void {
  const form = element.closest<HTMLElement>('[data-reference-editor]');
  if (form) normalizeReferenceEditorSubject(form);
}

async function saveReferenceClassification(referenceId: string, element: HTMLElement, draft = false): Promise<void> {
  const form = element.closest<HTMLElement>('[data-reference-editor]');
  if (!form) return;
  try {
    await referenceWorkspace.handleAction({
      action: draft ? 'save-reference-draft' : 'save-reference-classification',
      referenceId,
      classification: readReferenceEditorForm(form),
    });
    App.toast(draft ? 'Reference draft saved for review' : 'Reference classification saved', 'success');
    App.refreshPage();
  } catch (error) {
    App.toast(error instanceof Error ? error.message : 'Could not save reference classification', 'error');
  }
}

async function reclassifyReference(referenceId: string): Promise<void> {
  const result = await referenceWorkspace.handleAction({ action: 'reclassify-reference', referenceId });
  if (result?.requiresConfirmation) {
    if (!window.confirm('Reclassify this reference? This will replace its manual metadata.')) return;
    await referenceWorkspace.handleAction({ action: 'reclassify-reference', referenceId, confirmed: true });
  }
  App.refreshPage();
}

async function deleteReference(referenceId: string): Promise<void> {
  if (!window.confirm('Delete this reference? This cannot be undone.')) return;
  await runWorkspaceAction('delete-reference', referenceId);
}

async function previewReference(referenceId: string): Promise<void> {
  const asset = await referenceRepository.getAsset(referenceId);
  if (asset)
    App.showModal(
      `<img class="reference-preview-large" src="${escHtml(asset.dataUrl)}" alt="${escHtml(asset.description)}">`,
    );
}

async function exportWorld(id: string): Promise<void> {
  const world = await DB.get(DB.STORES.worlds, id);
  if (!world) return;
  const payload = JSON.stringify({ schemaVersion: 2, world }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `world-${slugifyName(world.name) || id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function deleteWorld(id: string, name: string): Promise<void> {
  if (!window.confirm(`Delete ${name}?`)) return;
  await DB.del(DB.STORES.worlds, id);
  App.toast('World deleted', 'info');
  App.refreshPage();
}

const WorldsPage: PageModule & Record<string, any> = {
  render,
  newWorld,
  editWorld,
  backToList,
  saveWorld,
  saveLocation,
  newCharacterForWorld,
  uploadReference,
  handleReferenceUpload,
  generateReference,
  setReferenceFilter,
  reviewReference,
  previewReference,
  'hide-reference': (id) => runWorkspaceAction('hide-reference', id),
  'unhide-reference': (id) => runWorkspaceAction('unhide-reference', id),
  'accept-reference': (id) => runWorkspaceAction('accept-reference', id),
  'retry-reference': (id) => runWorkspaceAction('retry-reference', id),
  'reclassify-reference': reclassifyReference,
  'pause-classification': () => runWorkspaceAction('pause-classification'),
  'resume-classification': () => runWorkspaceAction('resume-classification'),
  'retry-failed-references': (worldId) => runWorkspaceAction('retry-failed-references', undefined, worldId),
  'save-reference-classification': (id, element) => saveReferenceClassification(id, element),
  'save-reference-draft': (id, element) => saveReferenceClassification(id, element, true),
  'delete-reference': deleteReference,
  'close-reference-editor': closeReferenceEditor,
  'normalize-reference-subject': normalizeReferenceSubject,
  'set-reference-filter': setReferenceFilter,
  'review-reference': reviewReference,
  'preview-reference': previewReference,
  'upload-reference': uploadReference,
  'generate-reference': generateReference,
  'submit-generate-reference': submitGenerateReference,
  exportWorld,
  deleteWorld,
};

export default WorldsPage;
