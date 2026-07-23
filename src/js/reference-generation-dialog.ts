/**
 * Pure rendering and form-reading helpers for the "Generate reference" dialog.
 *
 * The dialog lets the user pick which character the generated reference is
 * for and select one or more existing reference images to send to the image
 * model. DOM wiring lives in reference-workspace-runtime.ts.
 */
import { escHtml } from './utils.js';
import type { ReferenceAsset } from './references/types.js';

export interface GenerateReferenceCharacterOption {
  id: string;
  name: string;
}

export interface GenerateReferenceDialogData {
  worldName: string;
  characters: GenerateReferenceCharacterOption[];
  references: ReferenceAsset[];
  defaultCharacterId?: string | null;
}

export interface GenerateReferenceDialogValues {
  prompt: string;
  characterId: string | null;
  referenceIds: string[];
}

const MAX_DEFAULT_SOURCES = 3;

/**
 * Choose which existing references are pre-selected as generation sources.
 * Prefers the character's auto-use identity references; falls back to any
 * auto-use reference linked to the character (covers freshly uploaded images
 * that have not been classified yet), capped to keep the request small.
 */
export function defaultSelectedReferenceIds(references: ReferenceAsset[], characterId: string | null): string[] {
  if (!characterId) return [];
  const linked = references.filter((asset) => asset.autoUse && asset.characterIds.includes(characterId));
  const identity = linked.filter((asset) => asset.subjectType === 'character' && asset.use === 'identity');
  const chosen = identity.length > 0 ? identity : linked;
  return chosen.slice(0, MAX_DEFAULT_SOURCES).map((asset) => asset.id);
}

function referenceLabel(asset: ReferenceAsset, characterNames: Map<string, string>): string {
  const names = asset.characterIds.map((id) => characterNames.get(id)).filter(Boolean);
  const parts = [
    asset.description || [asset.subjectType, asset.use].filter(Boolean).join(' / ') || 'Unclassified reference',
  ];
  if (names.length > 0) parts.push(names.join(', '));
  return parts.join(' — ');
}

export function renderGenerateReferenceDialog(data: GenerateReferenceDialogData): string {
  const defaultCharacterId = data.defaultCharacterId || '';
  const characterNames = new Map(data.characters.map((character) => [character.id, character.name]));
  const preselected = new Set(defaultSelectedReferenceIds(data.references, defaultCharacterId || null));

  const characterOptions = [
    `<option value=""${defaultCharacterId ? '' : ' selected'}>World / ${escHtml(data.worldName)} (no character)</option>`,
    ...data.characters.map(
      (character) =>
        `<option value="${escHtml(character.id)}"${character.id === defaultCharacterId ? ' selected' : ''}>${escHtml(character.name)}</option>`,
    ),
  ].join('');

  const sourceOptions =
    data.references.length === 0
      ? '<p class="text-muted">No existing references yet — the image will be generated from the prompt alone.</p>'
      : data.references
          .map((asset) => {
            const label = referenceLabel(asset, characterNames);
            return `<label class="generate-ref-option">
              <input type="checkbox" data-generate-ref-source value="${escHtml(asset.id)}"${preselected.has(asset.id) ? ' checked' : ''}>
              <img src="${escHtml(asset.thumbnailDataUrl || asset.dataUrl)}" alt="${escHtml(label)}">
              <span>${escHtml(label)}</span>
            </label>`;
          })
          .join('');

  return `<section data-generate-reference-dialog>
    <div class="modal-title">Generate reference</div>
    <div class="form-group">
      <label for="generate-ref-prompt">Describe the reference to generate</label>
      <textarea id="generate-ref-prompt" rows="3" autofocus></textarea>
    </div>
    <div class="form-group">
      <label for="generate-ref-character">Use for character</label>
      <select id="generate-ref-character">${characterOptions}</select>
    </div>
    <div class="form-group">
      <label>Existing reference images to send to the model</label>
      <div class="generate-ref-sources">${sourceOptions}</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" onclick="App.hideModal()">Cancel</button>
      <button class="btn btn-primary btn-sm" data-action="submit-generate-reference" data-generate-ref-submit>Generate</button>
    </div>
  </section>`;
}

export function readGenerateReferenceDialog(root: ParentNode): GenerateReferenceDialogValues {
  const prompt = root.querySelector<HTMLTextAreaElement>('#generate-ref-prompt')?.value.trim() || '';
  const characterId = root.querySelector<HTMLSelectElement>('#generate-ref-character')?.value || null;
  const referenceIds = [...root.querySelectorAll<HTMLInputElement>('[data-generate-ref-source]:checked')].map(
    (input) => input.value,
  );
  return { prompt, characterId, referenceIds };
}
