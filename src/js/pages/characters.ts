// @ts-nocheck
import type { PageModule } from '../utils.js';
import { escHtml, normalizeLocationKey } from '../utils.js';
import DB from '../db.js';
import API from '../api.js';
import type { ReferenceFilter, ReferenceWorkspaceAction } from '../reference-workspace.js';
import {
  addUploadedReference,
  fileToDataUrl,
  referenceRepository,
  referenceWorkspace,
} from '../reference-workspace-runtime.js';

let editingId: string | null = null;
let parentWorldId: string | null = null;
let referenceFilter: ReferenceFilter = 'all';

async function render(param?: string | null): Promise<string> {
  if (!param) {
    editingId = null;
    parentWorldId = null;
    return renderList();
  }
  if (param.startsWith('new:')) {
    editingId = null;
    parentWorldId = param.slice(4) || null;
  } else if (param === 'new') {
    editingId = null;
    parentWorldId = null;
  } else {
    editingId = param;
    const character = await DB.get(DB.STORES.characters, param);
    parentWorldId = character?.worldId || character?.linkedWorldId || null;
  }
  return renderEditor();
}

async function renderList(): Promise<string> {
  const [worlds, characters] = await Promise.all([DB.getAll(DB.STORES.worlds), DB.getAll(DB.STORES.characters)]);
  const groups = worlds
    .sort((left, right) => String(left.name).localeCompare(String(right.name)))
    .map((world) => ({
      world,
      characters: characters.filter((character) => (character.worldId || character.linkedWorldId) === world.id),
    }));

  return `<div class="slide-up">
    <div class="section-header">
      <div><h2 class="section-title">Character Builder</h2><p class="text-muted">Characters live inside a world and share its reference archive.</p></div>
    </div>
    ${
      groups.length
        ? groups
            .map(
              ({ world, characters: worldCharacters }) => `<section class="card character-world-group">
                <header class="reference-hierarchy-heading">
                  <div><p class="reference-eyebrow">World / ${escHtml(world.name)}</p><h3>${escHtml(world.name)}</h3></div>
                  <button class="btn btn-sm btn-primary" data-action="newCharacterForWorld" data-args="${escHtml(JSON.stringify([world.id]))}">New character</button>
                </header>
                <div class="reference-entity-list">
                  ${
                    worldCharacters.length
                      ? worldCharacters
                          .map(
                            (
                              character,
                            ) => `<article class="list-item" data-action="editCharacter" data-args="${escHtml(JSON.stringify([character.id]))}">
                              <div class="list-item-avatar">&#129464;</div>
                              <div class="list-item-info"><div class="list-item-title">${escHtml(character.name)}</div><div class="list-item-desc">${escHtml(character.role || 'No role')} · ${escHtml(character.description || '').slice(0, 80)}</div></div>
                              <div class="list-item-actions">
                                <button class="btn btn-sm btn-secondary" data-action="exportCharacter" data-args="${escHtml(JSON.stringify([character.id]))}">Export</button>
                                <button class="btn btn-sm btn-danger" data-action="deleteCharacter" data-args="${escHtml(JSON.stringify([character.id, character.name]))}">Delete</button>
                              </div>
                            </article>`,
                          )
                          .join('')
                      : '<p class="text-muted">No characters in this world yet.</p>'
                  }
                </div>
              </section>`,
            )
            .join('')
        : `<div class="empty-state"><div class="empty-icon">&#127758;</div><p>Create a world before adding characters.</p><button class="btn btn-primary" data-navigate="worlds" data-param="new">Create World</button></div>`
    }
  </div>`;
}

async function renderEditor(): Promise<string> {
  const character = editingId ? await DB.get(DB.STORES.characters, editingId) : null;
  const worldId = character?.worldId || character?.linkedWorldId || parentWorldId;
  if (!worldId) {
    const worlds = await DB.getAll(DB.STORES.worlds);
    return `<div class="slide-up"><div class="section-header"><button class="btn btn-sm btn-secondary" data-action="backToList">&#8592; Characters</button><h2 class="section-title">Choose a world</h2></div>
      <div class="card"><p class="text-muted mb-sm">Every character needs a parent world.</p><div class="reference-parent-picker">${worlds.map((world) => `<button class="btn btn-secondary" data-action="newCharacterForWorld" data-args="${escHtml(JSON.stringify([world.id]))}">${escHtml(world.name)}</button>`).join('')}</div></div></div>`;
  }
  const world = await DB.get(DB.STORES.worlds, worldId);
  if (!world) return `<div class="card">The parent world no longer exists.</div>`;
  const record = character || {
    name: '',
    role: 'hero',
    description: '',
    appearance: '',
    backstory: '',
    powers: '',
    defaultVisualState: {},
  };
  const defaults = record.defaultVisualState || {};
  const workspaceHtml = editingId
    ? await referenceWorkspace.render({
        worldId,
        characterId: editingId,
        filter: referenceFilter,
      })
    : '';

  return `<div class="slide-up">
    <div class="section-header">
      <button class="btn btn-sm btn-secondary" data-action="backToList">&#8592; Characters</button>
      <div><p class="reference-eyebrow">World / ${escHtml(world.name)} / Character</p><h2 class="section-title">${editingId ? escHtml(record.name) : 'New character'}</h2></div>
      ${editingId ? `<button class="btn btn-sm btn-secondary" data-action="exportCharacter" data-args="${escHtml(JSON.stringify([editingId]))}">Export</button>` : ''}
    </div>
    <section class="card character-record-card" data-world-id="${escHtml(worldId)}">
      <input type="hidden" id="char-world-id" value="${escHtml(worldId)}">
      <div class="reference-form-grid">
        <div class="form-group"><label class="form-label" for="char-name">Name *</label><input id="char-name" value="${escHtml(record.name)}"></div>
        <div class="form-group"><label class="form-label" for="char-role">Role</label><input id="char-role" value="${escHtml(record.role || '')}" placeholder="Hero, rival, mentor…"></div>
      </div>
      <div class="form-group"><label class="form-label" for="char-desc">Description *</label><textarea id="char-desc" rows="3">${escHtml(record.description || '')}</textarea></div>
      <div class="form-group"><label class="form-label" for="char-appearance">Stable appearance</label><textarea id="char-appearance" rows="3">${escHtml(record.appearance || '')}</textarea></div>
      <div class="reference-form-grid">
        <div class="form-group"><label class="form-label" for="char-backstory">Backstory</label><textarea id="char-backstory">${escHtml(record.backstory || '')}</textarea></div>
        <div class="form-group"><label class="form-label" for="char-powers">Abilities</label><textarea id="char-powers">${escHtml(record.powers || '')}</textarea></div>
      </div>
      <details class="continuity-gen-details">
        <summary>Reusable visual defaults</summary>
        <div class="form-group"><label class="form-label" for="char-dvs-wardrobe">Wardrobe</label><input id="char-dvs-wardrobe" value="${escHtml(defaults.wardrobeDescription || '')}"></div>
        <div class="form-group"><label class="form-label" for="char-dvs-hair">Hair state</label><input id="char-dvs-hair" value="${escHtml(defaults.hairState || '')}"></div>
        <div class="form-group"><label class="form-label" for="char-dvs-items">Carried items</label><input id="char-dvs-items" value="${escHtml((defaults.carriedItems || []).join(', '))}"></div>
      </details>
      <button class="btn btn-primary" id="char-save-btn" data-action="saveCharacter">${editingId ? 'Save character' : 'Create character'}</button>
    </section>
    ${
      editingId
        ? `<input type="file" id="reference-upload-input" class="hidden" accept="image/*" data-action-change="handleReferenceUpload">${workspaceHtml}`
        : `<section class="card reference-save-first"><strong>Save the character to open its reference view.</strong><span>It will use the same records as ${escHtml(world.name)}.</span></section>`
    }
  </div>`;
}

function newCharacterForWorld(worldId: string): void {
  App.navigate('characters', `new:${worldId}`);
}

function editCharacter(id: string): void {
  App.navigate('characters', id);
}

function backToList(): void {
  App.navigate('characters', null);
}

function parseList(id: string): string[] {
  return (document.getElementById(id)?.value || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function saveCharacter(): Promise<void> {
  const worldId = document.getElementById('char-world-id')?.value;
  const name = document.getElementById('char-name')?.value.trim();
  const description = document.getElementById('char-desc')?.value.trim();
  if (!worldId) return App.toast('Choose a world first', 'error');
  if (!name || !description) return App.toast('Character name and description are required', 'error');
  const existing = editingId ? await DB.get(DB.STORES.characters, editingId) : null;
  const id = editingId || DB.uuid();
  await DB.put(DB.STORES.characters, {
    ...(existing || {}),
    id,
    worldId,
    linkedWorldId: worldId,
    name,
    role: document.getElementById('char-role')?.value.trim() || '',
    description,
    appearance: document.getElementById('char-appearance')?.value.trim() || '',
    backstory: document.getElementById('char-backstory')?.value.trim() || '',
    powers: document.getElementById('char-powers')?.value.trim() || '',
    defaultVisualState: {
      wardrobeDescription: document.getElementById('char-dvs-wardrobe')?.value.trim() || '',
      hairState: document.getElementById('char-dvs-hair')?.value.trim() || '',
      carriedItems: parseList('char-dvs-items'),
      injuries: existing?.defaultVisualState?.injuries || [],
      temporaryChanges: existing?.defaultVisualState?.temporaryChanges || [],
    },
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
  App.toast(editingId ? 'Character saved' : 'Character created', 'success');
  App.navigate('characters', id);
}

function uploadReference(): void {
  document.getElementById('reference-upload-input')?.click();
}

async function handleReferenceUpload(input: HTMLInputElement): Promise<void> {
  if (!editingId || !parentWorldId || !input.files?.[0]) return;
  await addUploadedReference({
    worldId: parentWorldId,
    characterId: editingId,
    dataUrl: await fileToDataUrl(input.files[0]),
  });
  input.value = '';
  App.toast('Character reference queued for local review', 'success');
  App.refreshPage();
}

async function generateReference(): Promise<void> {
  if (!editingId || !parentWorldId) return;
  const promptText = window.prompt('Describe the character reference to generate');
  if (!promptText?.trim()) return;
  const identity = (await referenceRepository.listByCharacter(parentWorldId, editingId)).find(
    (asset) => asset.subjectType === 'character' && asset.use === 'identity' && asset.autoUse,
  );
  const dataUrl = await API.generateRefVariation(identity?.dataUrl || null, promptText.trim(), {});
  if (!dataUrl) return App.toast('Reference generation failed', 'error');
  await addUploadedReference({
    worldId: parentWorldId,
    characterId: editingId,
    dataUrl,
    source: 'generated',
  });
  App.toast('Generated character reference added', 'success');
  App.refreshPage();
}

function setReferenceFilter(filter: ReferenceFilter): void {
  referenceFilter = filter;
  App.refreshPage();
}

async function runWorkspaceAction(action: ReferenceWorkspaceAction, referenceId?: string): Promise<void> {
  await referenceWorkspace.handleAction({ action, referenceId });
  App.refreshPage();
}

async function reviewReference(referenceId: string): Promise<void> {
  const asset = await referenceRepository.getAsset(referenceId);
  if (!asset) return;
  App.showModal(`<div class="modal-title">Review metadata</div>
    <img class="reference-review-image" src="${escHtml(asset.dataUrl)}" alt="">
    <p class="reference-label">${escHtml(asset.subjectType || 'Unclassified')} / ${escHtml(asset.use || 'Needs review')}</p>
    <p class="text-muted">${escHtml(asset.description || 'No description yet')}</p>
    <div class="modal-actions"><button class="btn btn-secondary" data-action="reclassify-reference" data-args="${escHtml(JSON.stringify([asset.id]))}">Reclassify</button><button class="btn btn-primary" data-action="accept-reference" data-args="${escHtml(JSON.stringify([asset.id]))}">Accept as-is</button></div>`);
}

async function previewReference(referenceId: string): Promise<void> {
  const asset = await referenceRepository.getAsset(referenceId);
  if (asset)
    App.showModal(
      `<img class="reference-preview-large" src="${escHtml(asset.dataUrl)}" alt="${escHtml(asset.description)}">`,
    );
}

async function exportCharacter(id: string): Promise<void> {
  const character = await DB.get(DB.STORES.characters, id);
  if (!character) return;
  const payload = JSON.stringify({ schemaVersion: 2, character }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `character-${normalizeLocationKey(character.name) || id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function deleteCharacter(id: string, name: string): Promise<void> {
  if (!window.confirm(`Delete ${name}?`)) return;
  await DB.del(DB.STORES.characters, id);
  App.toast('Character deleted', 'info');
  App.refreshPage();
}

const CharactersPage: PageModule & Record<string, any> = {
  render,
  newCharacterForWorld,
  editCharacter,
  backToList,
  saveCharacter,
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
  'reclassify-reference': (id) => runWorkspaceAction('reclassify-reference', id),
  'pause-classification': () => runWorkspaceAction('pause-classification'),
  'set-reference-filter': setReferenceFilter,
  'review-reference': reviewReference,
  'preview-reference': previewReference,
  'upload-reference': uploadReference,
  'generate-reference': generateReference,
  exportCharacter,
  deleteCharacter,
};

export default CharactersPage;
