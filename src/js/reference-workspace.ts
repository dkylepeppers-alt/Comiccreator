import { escHtml } from './utils.js';
import type { ClassificationProgress } from './references/classification-queue.js';
import type { ReferenceAsset, WorldLocation } from './references/types.js';

export type ReferenceFilter = 'all' | 'world' | 'characters' | 'interactions' | 'needs-review' | 'hidden';

export interface ReferenceWorkspaceRenderOptions {
  worldId: string;
  characterId?: string;
  filter: ReferenceFilter;
  picker?: boolean;
}

export interface ReferenceWorkspaceDependencies {
  repository: {
    listByWorld(worldId: string): Promise<ReferenceAsset[]>;
    setAutoUse(id: string, autoUse: boolean): Promise<void>;
  };
  queue: {
    acceptAsIs(assetId: string): Promise<void>;
    retry(assetId: string): Promise<void>;
    reclassify(assetId: string): Promise<void>;
    pause(): void;
    getProgress(): Promise<ClassificationProgress>;
  };
  listCharacters(worldId: string): Promise<Array<{ id: string; name: string }>>;
  listLocations(worldId: string): Promise<WorldLocation[]>;
}

export type ReferenceWorkspaceAction =
  | 'hide-reference'
  | 'unhide-reference'
  | 'accept-reference'
  | 'retry-reference'
  | 'reclassify-reference'
  | 'pause-classification'
  | 'review-reference';

function titleCase(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function filterAssets(
  assets: readonly ReferenceAsset[],
  { characterId, filter }: ReferenceWorkspaceRenderOptions,
): ReferenceAsset[] {
  return assets.filter((asset) => {
    if (characterId && !asset.characterIds.includes(characterId)) return false;
    if (filter === 'hidden') return !asset.autoUse;
    if (filter === 'needs-review') return asset.classificationState === 'needs-review';
    if (!asset.autoUse) return false;
    if (filter === 'world') return ['location', 'prop', 'style'].includes(asset.subjectType || '');
    if (filter === 'characters') return asset.subjectType === 'character';
    if (filter === 'interactions') return asset.subjectType === 'interaction';
    return true;
  });
}

function assetLabel(
  asset: ReferenceAsset,
  characterNames: ReadonlyMap<string, string>,
  locationNames: ReadonlyMap<string, string>,
): string {
  const subject = titleCase(asset.subjectType || 'unclassified');
  const entity =
    asset.subjectType === 'character' || asset.subjectType === 'interaction'
      ? asset.characterIds.map((id) => characterNames.get(id) || id).join(' + ') || 'Unlinked'
      : asset.locationId
        ? locationNames.get(asset.locationId) || asset.locationId
        : 'World';
  const use = titleCase(asset.use || 'needs review');
  const view =
    asset.facets.viewDirection ||
    asset.facets.framing ||
    asset.facets.interactionType ||
    asset.facets.appearanceState ||
    '';
  return [subject, entity, use, view ? titleCase(view) : null].filter(Boolean).join(' / ');
}

function actionArgs(referenceId: string): string {
  return escHtml(JSON.stringify([referenceId]));
}

function referenceCard(asset: ReferenceAsset, label: string, picker: boolean): string {
  const hidden = !asset.autoUse;
  return `<article class="reference-card" data-reference-id="${escHtml(asset.id)}">
    <button class="reference-preview" data-action="preview-reference" data-args="${actionArgs(asset.id)}" aria-label="Preview ${escHtml(label)}">
      <img src="${escHtml(asset.thumbnailDataUrl || asset.dataUrl)}" alt="${escHtml(label)}">
    </button>
    <div class="reference-card-copy">
      <p class="reference-label">${escHtml(label)}</p>
      <p class="reference-description">${escHtml(asset.description || 'No description yet')}</p>
    </div>
    <div class="reference-card-status">
      <span class="reference-status reference-status-${escHtml(asset.classificationState)}">${escHtml(asset.classificationState)}</span>
      ${asset.provenance.metadata === 'manual' ? '<span class="reference-status">manual</span>' : ''}
    </div>
    <div class="reference-card-actions">
      <button class="btn btn-sm btn-secondary" data-action="review-reference" data-args="${actionArgs(asset.id)}">Review</button>
      <button class="btn btn-sm btn-secondary" data-action="${hidden ? 'unhide' : 'hide'}-reference" data-args="${actionArgs(asset.id)}">${hidden ? 'Unhide' : 'Hide'}</button>
      ${
        asset.classificationState === 'needs-review'
          ? `<button class="btn btn-sm btn-secondary" data-action="accept-reference" data-args="${actionArgs(asset.id)}">Accept as-is</button>
             <button class="btn btn-sm btn-secondary" data-action="retry-reference" data-args="${actionArgs(asset.id)}">Retry</button>`
          : ''
      }
      ${picker ? `<button class="btn btn-sm btn-primary" data-action="select-reference" data-args="${actionArgs(asset.id)}">Use for panel</button>` : ''}
    </div>
  </article>`;
}

function progressPanel(progress: ClassificationProgress): string {
  const finished = progress.complete + progress.failed;
  return `<aside class="reference-progress" aria-label="Classification progress">
    <div>
      <span class="reference-progress-label">Local classification</span>
      <strong>${finished} / ${progress.total}</strong>
    </div>
    <div class="reference-progress-track" aria-hidden="true"><span style="width:${progress.total ? Math.round((finished / progress.total) * 100) : 0}%"></span></div>
    <span>${progress.pending} queued · ${progress.running} running · ${progress.failed} review</span>
    <button class="btn btn-sm btn-secondary" data-action="pause-classification"${progress.paused ? ' disabled' : ''}>${progress.paused ? 'Paused' : 'Pause'}</button>
  </aside>`;
}

export function createReferenceWorkspace(dependencies: ReferenceWorkspaceDependencies) {
  return {
    async render(options: ReferenceWorkspaceRenderOptions): Promise<string> {
      const [assets, characters, locations, progress] = await Promise.all([
        dependencies.repository.listByWorld(options.worldId),
        dependencies.listCharacters(options.worldId),
        dependencies.listLocations(options.worldId),
        dependencies.queue.getProgress(),
      ]);
      const characterNames = new Map(characters.map(({ id, name }) => [id, name]));
      const locationNames = new Map(locations.map(({ id, name }) => [id, name]));
      const visible = filterAssets(assets, options);
      const filters: ReferenceFilter[] = ['all', 'world', 'characters', 'interactions', 'needs-review', 'hidden'];

      return `<section class="reference-workspace" data-world-id="${escHtml(options.worldId)}">
        <header class="reference-workspace-header">
          <div>
            <p class="reference-eyebrow">Reference contact sheet</p>
            <h3>Visual evidence</h3>
          </div>
          <div class="reference-workspace-tools">
            <button class="btn btn-sm btn-primary" data-action="upload-reference">Upload</button>
            <button class="btn btn-sm btn-secondary" data-action="generate-reference">Generate</button>
          </div>
        </header>
        <nav class="reference-filter-rail" aria-label="Reference filters">
          ${filters
            .map(
              (filter) =>
                `<button class="reference-filter${options.filter === filter ? ' active' : ''}" data-action="set-reference-filter" data-args="${escHtml(JSON.stringify([filter]))}">${titleCase(filter)}</button>`,
            )
            .join('')}
        </nav>
        ${progressPanel(progress)}
        <div class="reference-grid">
          ${
            visible.length
              ? visible
                  .map((asset) =>
                    referenceCard(asset, assetLabel(asset, characterNames, locationNames), !!options.picker),
                  )
                  .join('')
              : `<div class="reference-empty"><strong>No references in this view.</strong><span>Upload an image or choose another filter.</span></div>`
          }
        </div>
      </section>`;
    },

    async handleAction({
      action,
      referenceId,
    }: {
      action: ReferenceWorkspaceAction;
      referenceId?: string;
    }): Promise<void> {
      if (action === 'pause-classification') {
        dependencies.queue.pause();
        return;
      }
      if (!referenceId) return;
      if (action === 'hide-reference') await dependencies.repository.setAutoUse(referenceId, false);
      else if (action === 'unhide-reference') await dependencies.repository.setAutoUse(referenceId, true);
      else if (action === 'accept-reference') await dependencies.queue.acceptAsIs(referenceId);
      else if (action === 'retry-reference') await dependencies.queue.retry(referenceId);
      else if (action === 'reclassify-reference') await dependencies.queue.reclassify(referenceId);
    },
  };
}
