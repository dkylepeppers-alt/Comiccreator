import { escHtml } from './utils.js';
import type { ClassificationProgress } from './references/classification-queue.js';
import type {
  ClassificationJob,
  ReferenceAsset,
  ReferenceFacets,
  ReferenceSubjectType,
  ReferenceUse,
  WorldLocation,
} from './references/types.js';

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
    getAsset(id: string): Promise<ReferenceAsset | undefined>;
    putAsset(asset: ReferenceAsset): Promise<void>;
    deleteAsset(id: string): Promise<void>;
    getJobByAsset(assetId: string): Promise<ClassificationJob | undefined>;
    putJob(job: ClassificationJob): Promise<void>;
    setAutoUse(id: string, autoUse: boolean): Promise<void>;
  };
  queue: {
    acceptAsIs(assetId: string): Promise<void>;
    retry(assetId: string): Promise<void>;
    retryAllFailed(): Promise<number>;
    reclassify(assetId: string): Promise<void>;
    pause(): void;
    resume(): Promise<void>;
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
  | 'resume-classification'
  | 'retry-failed-references'
  | 'save-reference-classification'
  | 'save-reference-draft'
  | 'delete-reference'
  | 'review-reference';

export interface ManualClassificationInput {
  subjectType: ReferenceSubjectType | null;
  use: ReferenceUse | null;
  characterIds: string[];
  locationId: string | null;
  facets: ReferenceFacets;
  description: string;
  proposedCharacterNames?: string[];
  proposedLocationName?: string | null;
}

const SUBJECTS: ReferenceSubjectType[] = ['character', 'location', 'interaction', 'prop', 'style'];
const USES: ReferenceUse[] = [
  'identity',
  'appearance',
  'expression',
  'pose',
  'action',
  'establishing',
  'spatial',
  'landmark',
  'detail',
  'relationship',
  'design',
  'state',
  'rendering',
];
const COMPATIBLE_USES: Record<ReferenceSubjectType, readonly ReferenceUse[]> = {
  character: ['identity', 'appearance', 'expression', 'pose', 'action', 'state'],
  location: ['establishing', 'spatial', 'landmark', 'detail'],
  interaction: ['action', 'pose', 'relationship'],
  prop: ['detail', 'design'],
  style: ['design', 'rendering'],
};

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

interface WorldProgress {
  total: number;
  ready: number;
  needsReview: number;
  couldNotClassify: number;
  queued: number;
  running: number;
  failed: number;
  paused: boolean;
}

function progressPanel(progress: WorldProgress, worldId: string): string {
  const processed = progress.ready + progress.needsReview;
  return `<aside class="reference-progress" aria-label="Classification progress">
    <div>
      <span class="reference-progress-label">Local classification</span>
      <strong>${processed} / ${progress.total} processed</strong>
    </div>
    <div class="reference-progress-track" aria-hidden="true"><span style="width:${progress.total ? Math.round((processed / progress.total) * 100) : 0}%"></span></div>
    <span>${progress.ready} Ready · ${progress.needsReview} Needs review · ${progress.couldNotClassify} Could not classify</span>
    <span>${progress.queued} queued · ${progress.running} running</span>
    <div class="reference-progress-actions">
      <button class="btn btn-sm btn-secondary" data-action="${progress.paused ? 'resume-classification' : 'pause-classification'}">${progress.paused ? 'Resume' : 'Pause'}</button>
      ${
        progress.failed
          ? `<button class="btn btn-sm btn-secondary" data-action="retry-failed-references" data-args="${escHtml(JSON.stringify([worldId]))}">Retry failed (${progress.failed})</button>`
          : ''
      }
    </div>
  </aside>`;
}

function option(value: string, label: string, selected: boolean, disabled = false): string {
  return `<option value="${escHtml(value)}"${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}>${escHtml(label)}</option>`;
}

function facetInput(name: string, label: string, value: string | undefined): string {
  return `<div class="form-group"><label class="form-label" for="reference-facet-${escHtml(name)}">${escHtml(label)}</label><input id="reference-facet-${escHtml(name)}" name="facet-${escHtml(name)}" value="${escHtml(value || '')}"></div>`;
}

function errorLabel(job: ClassificationJob | undefined): string {
  return job?.lastError ? `Could not classify: ${job.lastError}` : 'No classification failure recorded.';
}

function normalizeManualClassification(input: ManualClassificationInput): ManualClassificationInput {
  const subjectType = input.subjectType && SUBJECTS.includes(input.subjectType) ? input.subjectType : null;
  const compatibleUses = subjectType ? COMPATIBLE_USES[subjectType] : [];
  const use = input.use && compatibleUses.includes(input.use) ? input.use : null;
  const shared = {
    ...input,
    subjectType,
    use,
    characterIds: [...new Set(input.characterIds.filter(Boolean))],
    locationId: input.locationId || null,
    proposedCharacterNames: [
      ...new Set((input.proposedCharacterNames || []).map((name) => name.trim()).filter(Boolean)),
    ],
    proposedLocationName: input.proposedLocationName?.trim() || null,
  };
  if (subjectType === 'character' || subjectType === 'interaction') return { ...shared, locationId: null };
  if (subjectType === 'location') return { ...shared, characterIds: [] };
  return { ...shared, characterIds: [], locationId: null };
}

function validateReadyClassification(input: ManualClassificationInput, locations: readonly WorldLocation[]): void {
  if (!input.subjectType) throw new Error('Choose a reference subject.');
  if (!input.use) throw new Error('Choose a use compatible with the selected subject.');
  if (input.subjectType === 'character' && input.characterIds.length < 1) {
    throw new Error('Choose at least one current-world character.');
  }
  if (input.subjectType === 'interaction' && input.characterIds.length < 2) {
    throw new Error('Choose at least two current-world characters for an interaction.');
  }
  if (input.subjectType === 'location' && !locations.some((location) => location.id === input.locationId)) {
    throw new Error('Choose a current-world location.');
  }
}

function worldProgress(
  assets: readonly ReferenceAsset[],
  jobs: readonly (ClassificationJob | undefined)[],
  progress: ClassificationProgress,
): WorldProgress {
  return {
    total: assets.length,
    ready: assets.filter((asset) => asset.classificationState === 'ready').length,
    needsReview: assets.filter((asset) => asset.classificationState === 'needs-review').length,
    couldNotClassify: assets.filter((asset) => asset.classificationState === 'could-not-classify').length,
    queued: jobs.filter((job) => job?.status === 'pending').length,
    running: jobs.filter((job) => job?.status === 'running').length,
    failed: jobs.filter((job) => job?.status === 'failed').length,
    paused: progress.paused,
  };
}

export function readReferenceEditorForm(form: HTMLElement): ManualClassificationInput {
  const field = (name: string) =>
    form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`);
  const selected = (name: string) =>
    [...((field(name) as HTMLSelectElement | null)?.selectedOptions || [])].map((item) => item.value).filter(Boolean);
  const value = (name: string) => field(name)?.value.trim() || '';
  const subjectType = value('subjectType') as ReferenceSubjectType | '';
  const use = value('use') as ReferenceUse | '';
  const facets = Object.fromEntries(
    [
      'framing',
      'viewDirection',
      'appearanceState',
      'expression',
      'pose',
      'activity',
      'interactionType',
      'spatialArrangement',
      'lighting',
    ]
      .map((name) => [name, value(`facet-${name}`)])
      .filter(([, facetValue]) => facetValue),
  ) as ReferenceFacets;
  return {
    subjectType: subjectType || null,
    use: use || null,
    characterIds: selected('characterIds'),
    locationId: value('locationId') || null,
    facets,
    description: value('description'),
    proposedCharacterNames: value('proposedCharacterNames')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    proposedLocationName: value('proposedLocationName') || null,
  };
}

export function normalizeReferenceEditorSubject(form: HTMLElement): void {
  const subject = form.querySelector<HTMLSelectElement>('[name="subjectType"]')?.value as ReferenceSubjectType | '';
  const use = form.querySelector<HTMLSelectElement>('[name="use"]');
  const allowed = subject ? COMPATIBLE_USES[subject] : [];
  if (use) {
    for (const candidate of [...use.options]) {
      if (!candidate.value) continue;
      candidate.disabled = !allowed.includes(candidate.value as ReferenceUse);
    }
    if (use.value && !allowed.includes(use.value as ReferenceUse)) use.value = '';
  }
  const characterIds = form.querySelector<HTMLSelectElement>('[name="characterIds"]');
  const locationId = form.querySelector<HTMLSelectElement>('[name="locationId"]');
  if (!subject || subject === 'location' || subject === 'prop' || subject === 'style') {
    for (const candidate of [...(characterIds?.options || [])]) candidate.selected = false;
  }
  if (!subject || subject === 'character' || subject === 'interaction' || subject === 'prop' || subject === 'style') {
    if (locationId) locationId.value = '';
  }
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
      const jobs = await Promise.all(assets.map((asset) => dependencies.repository.getJobByAsset(asset.id)));
      const characterNames = new Map(characters.map(({ id, name }) => [id, name]));
      const locationNames = new Map(locations.map(({ id, name }) => [id, name]));
      const visible = filterAssets(assets, options);
      const filters: ReferenceFilter[] = ['all', 'world', 'characters', 'interactions', 'needs-review', 'hidden'];

      return `<section class="reference-workspace" data-world-id="${escHtml(options.worldId)}">
        <header class="reference-workspace-header">
          <div>
            <p class="reference-eyebrow">References</p>
            <h3>Reference Library</h3>
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
        ${progressPanel(worldProgress(assets, jobs, progress), options.worldId)}
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

    async renderEditor({ worldId, referenceId }: { worldId: string; referenceId: string }): Promise<string> {
      const [asset, characters, locations, job] = await Promise.all([
        dependencies.repository.getAsset(referenceId),
        dependencies.listCharacters(worldId),
        dependencies.listLocations(worldId),
        dependencies.repository.getJobByAsset(referenceId),
      ]);
      if (!asset || asset.worldId !== worldId) {
        return `<section class="reference-editor-empty" role="alert"><strong>Reference unavailable.</strong><span>It may have been deleted or moved to another world.</span></section>`;
      }
      const compatibleUses = asset.subjectType ? COMPATIBLE_USES[asset.subjectType] : [];
      const hidden = !asset.autoUse;
      return `<section class="reference-editor" data-reference-editor data-reference-id="${escHtml(asset.id)}">
        <header class="reference-editor-header">
          <div><p class="reference-eyebrow">References</p><h3>Manual classification</h3></div>
          <button class="btn btn-sm btn-secondary" data-action="preview-reference" data-args="${actionArgs(asset.id)}">Preview image</button>
        </header>
        <img class="reference-review-image" src="${escHtml(asset.dataUrl)}" alt="${escHtml(asset.description || 'Reference image')}">
        <p class="text-muted">Choose how this image should be used in this world. Save a draft when it still needs review.</p>
        <div class="reference-form-grid">
          <div class="form-group"><label class="form-label" for="reference-subject">Subject</label><select id="reference-subject" name="subjectType" data-action-change="normalize-reference-subject" data-args="${actionArgs(asset.id)}" autofocus>${option('', 'Choose a subject', !asset.subjectType)}${SUBJECTS.map((subject) => option(subject, titleCase(subject), asset.subjectType === subject)).join('')}</select></div>
          <div class="form-group"><label class="form-label" for="reference-use">Use</label><select id="reference-use" name="use">${option('', 'Choose a use', !asset.use)}${USES.map((use) => option(use, titleCase(use), asset.use === use, !!asset.subjectType && !compatibleUses.includes(use))).join('')}</select></div>
        </div>
        <div class="reference-form-grid">
          <div class="form-group"><label class="form-label" for="reference-character-ids">Current-world characters</label><select id="reference-character-ids" name="characterIds" multiple aria-describedby="reference-character-help">${characters.map((character) => option(character.id, character.name, asset.characterIds.includes(character.id))).join('')}</select><span id="reference-character-help" class="form-help">Choose one character, or two or more for an interaction.</span></div>
          <div class="form-group"><label class="form-label" for="reference-location-id">Current-world location</label><select id="reference-location-id" name="locationId">${option('', 'No location', !asset.locationId)}${locations.map((location) => option(location.id, location.name, asset.locationId === location.id)).join('')}</select></div>
        </div>
        <div class="reference-form-grid">
          <div class="form-group"><label class="form-label" for="reference-proposed-character-names">Proposed unmatched character names</label><input id="reference-proposed-character-names" name="proposedCharacterNames" value="${escHtml((asset.proposedCharacterNames || []).join(', '))}" placeholder="Names separated by commas"></div>
          <div class="form-group"><label class="form-label" for="reference-proposed-location-name">Proposed unmatched location</label><input id="reference-proposed-location-name" name="proposedLocationName" value="${escHtml(asset.proposedLocationName || '')}" placeholder="Name from the image"></div>
        </div>
        <fieldset class="reference-facets"><legend>Useful facets</legend><div class="reference-form-grid">${facetInput('framing', 'Framing', asset.facets.framing)}${facetInput('viewDirection', 'View direction', asset.facets.viewDirection)}${facetInput('appearanceState', 'Appearance state', asset.facets.appearanceState)}${facetInput('expression', 'Expression', asset.facets.expression)}${facetInput('pose', 'Pose', asset.facets.pose)}${facetInput('activity', 'Activity', asset.facets.activity)}${facetInput('interactionType', 'Interaction type', asset.facets.interactionType)}${facetInput('spatialArrangement', 'Spatial arrangement', asset.facets.spatialArrangement)}${facetInput('lighting', 'Lighting', asset.facets.lighting)}</div></fieldset>
        <div class="form-group"><label class="form-label" for="reference-description">Description</label><textarea id="reference-description" name="description" rows="4" placeholder="Describe the visual information this reference preserves">${escHtml(asset.description)}</textarea></div>
        <dl class="reference-editor-provenance"><div><dt>Classification source</dt><dd>${escHtml(asset.provenance.source)} / ${escHtml(asset.provenance.metadata)}</dd></div><div><dt>Classification mode</dt><dd>${asset.provenance.metadata === 'manual' ? 'Manual' : 'Local'}</dd></div><div><dt>Failure reason</dt><dd>${escHtml(errorLabel(job))}</dd></div></dl>
        <div class="modal-actions">
          <button class="btn btn-secondary" data-action="save-reference-draft" data-args="${actionArgs(asset.id)}">Save draft</button>
          <button class="btn btn-primary" data-action="save-reference-classification" data-args="${actionArgs(asset.id)}">Save classification</button>
        </div>
        <div class="reference-editor-actions">
          <button class="btn btn-sm btn-secondary" data-action="${hidden ? 'unhide' : 'hide'}-reference" data-args="${actionArgs(asset.id)}">${hidden ? 'Unhide reference' : 'Hide reference'}</button>
          <button class="btn btn-sm btn-secondary" data-action="retry-reference" data-args="${actionArgs(asset.id)}">Retry classification</button>
          <button class="btn btn-sm btn-secondary" data-action="reclassify-reference" data-args="${actionArgs(asset.id)}">Reclassify</button>
          <button class="btn btn-sm btn-danger" data-action="delete-reference" data-args="${actionArgs(asset.id)}">Delete reference</button>
        </div>
      </section>`;
    },

    async handleAction({
      action,
      referenceId,
      worldId,
      classification,
      confirmed = false,
    }: {
      action: ReferenceWorkspaceAction;
      referenceId?: string;
      worldId?: string;
      classification?: ManualClassificationInput;
      confirmed?: boolean;
    }): Promise<{ requiresConfirmation: true } | void> {
      if (action === 'pause-classification') {
        dependencies.queue.pause();
        return;
      }
      if (action === 'resume-classification') {
        await dependencies.queue.resume();
        return;
      }
      if (action === 'retry-failed-references') {
        if (!worldId) return;
        const assets = await dependencies.repository.listByWorld(worldId);
        const jobs = await Promise.all(assets.map((asset) => dependencies.repository.getJobByAsset(asset.id)));
        await Promise.all(
          assets
            .filter((_, index) => jobs[index]?.status === 'failed')
            .map((asset) => dependencies.queue.retry(asset.id)),
        );
        return;
      }
      if (!referenceId) return;
      if (action === 'hide-reference') await dependencies.repository.setAutoUse(referenceId, false);
      else if (action === 'unhide-reference') await dependencies.repository.setAutoUse(referenceId, true);
      else if (action === 'accept-reference') await dependencies.queue.acceptAsIs(referenceId);
      else if (action === 'retry-reference') await dependencies.queue.retry(referenceId);
      else if (action === 'delete-reference') await dependencies.repository.deleteAsset(referenceId);
      else if (action === 'reclassify-reference') {
        const asset = await dependencies.repository.getAsset(referenceId);
        if (asset?.provenance.metadata === 'manual' && !confirmed) return { requiresConfirmation: true };
        await dependencies.queue.reclassify(referenceId);
      } else if (action === 'save-reference-classification' || action === 'save-reference-draft') {
        const asset = await dependencies.repository.getAsset(referenceId);
        if (!asset || !classification) return;
        const normalized = normalizeManualClassification(classification);
        if (action === 'save-reference-classification') {
          const locations = await dependencies.listLocations(asset.worldId);
          validateReadyClassification(normalized, locations);
        }
        const updated: ReferenceAsset = {
          ...asset,
          ...normalized,
          confidence: {},
          provenance: { ...asset.provenance, metadata: 'manual' },
          classificationState: action === 'save-reference-classification' ? 'ready' : 'needs-review',
          acceptedAsIs: false,
          updatedAt: Date.now(),
        };
        await dependencies.repository.putAsset(updated);
        if (action === 'save-reference-classification') {
          const job = await dependencies.repository.getJobByAsset(referenceId);
          if (job)
            await dependencies.repository.putJob({
              ...job,
              status: 'complete',
              lastError: undefined,
              updatedAt: Date.now(),
            });
        }
      }
    },
  };
}
