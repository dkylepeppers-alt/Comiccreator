import type {
  PanelReferenceRequest,
  ReferenceAsset,
  ReferenceFacets,
  ReferenceManifestItem,
  ReferenceUse,
} from './types.js';

export interface ResolvePanelReferencesInput {
  request: PanelReferenceRequest;
  assets: ReferenceAsset[];
  budget: number;
  preferredReferenceIds?: Record<string, string>;
  pinnedReferenceIds?: Record<string, string>;
  manualReferenceIds?: string[];
  previousFrame?: { dataUrl: string; sourcePageId?: string; sourcePanelIndex?: number } | null;
}

export interface ReferenceResolution {
  manifest: ReferenceManifestItem[];
  dataUrls: string[];
  missing: Array<{ role: ReferenceManifestItem['role']; id: string }>;
  warnings: string[];
  error?: { type: 'capacity'; required: number; budget: number; detail: string };
}

export type CandidateScore = readonly [
  entity: number,
  use: number,
  matching: number,
  negativeConflicts: number,
  preferred: number,
  id: string,
];

type ManifestRole = ReferenceManifestItem['role'];

interface SelectedReference {
  asset: ReferenceAsset;
  role: Exclude<ManifestRole, 'previous-frame'>;
  label: string;
  order: number;
}

const ROLE_ORDER: readonly ManifestRole[] = [
  'identity',
  'appearance',
  'location',
  'interaction',
  'prop',
  'style',
  'previous-frame',
];

export function compareCandidateScores(a: CandidateScore, b: CandidateScore): number {
  for (let index = 0; index < 5; index++) {
    if (a[index] !== b[index]) return Number(b[index]) - Number(a[index]);
  }
  return String(a[5]).localeCompare(String(b[5]));
}

function eligible(asset: ReferenceAsset): boolean {
  return asset.autoUse && (asset.classificationState === 'ready' || asset.acceptedAsIs);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
  }
  return JSON.stringify(value);
}

function facetComparison(asset: ReferenceAsset, requested: ReferenceFacets): { matching: number; conflicts: string[] } {
  let matching = 0;
  const conflicts: string[] = [];
  for (const [key, requestedValue] of Object.entries(requested)) {
    if (requestedValue === undefined || requestedValue === null || requestedValue === '') continue;
    const candidateValue = asset.facets[key as keyof ReferenceFacets];
    if (candidateValue === undefined || candidateValue === null || candidateValue === '') continue;
    if (stableValue(candidateValue) === stableValue(requestedValue)) matching += 1;
    else conflicts.push(key);
  }
  return { matching, conflicts };
}

function preferenceScore(
  assetId: string,
  keys: readonly string[],
  preferredReferenceIds: Record<string, string>,
  pinnedReferenceIds: Record<string, string>,
): number {
  if (keys.some((key) => pinnedReferenceIds[key] === assetId)) return 2;
  if (keys.some((key) => preferredReferenceIds[key] === assetId)) return 1;
  return 0;
}

function scoreCandidate(
  asset: ReferenceAsset,
  desiredUse: ReferenceUse | null,
  requestedFacets: ReferenceFacets,
  preferenceKeys: readonly string[],
  preferredReferenceIds: Record<string, string>,
  pinnedReferenceIds: Record<string, string>,
): CandidateScore {
  const facets = facetComparison(asset, requestedFacets);
  return [
    1,
    desiredUse && asset.use === desiredUse ? 1 : 0,
    facets.matching,
    -facets.conflicts.length,
    preferenceScore(asset.id, preferenceKeys, preferredReferenceIds, pinnedReferenceIds),
    asset.id,
  ];
}

function roleForAsset(asset: ReferenceAsset): SelectedReference['role'] | null {
  if (asset.subjectType === 'character') return asset.use === 'appearance' ? 'appearance' : 'identity';
  if (asset.subjectType === 'location') return 'location';
  if (asset.subjectType === 'interaction') return 'interaction';
  if (asset.subjectType === 'prop') return 'prop';
  if (asset.subjectType === 'style') return 'style';
  return null;
}

function manifestItem(selection: SelectedReference, index: number): ReferenceManifestItem {
  const { asset, role, label } = selection;
  return {
    index,
    role,
    label,
    imageId: asset.id,
    ...(asset.characterIds.length > 0 ? { characterIds: asset.characterIds } : {}),
    worldId: asset.worldId,
    ...(asset.locationId ? { locationId: asset.locationId } : {}),
  };
}

export function resolvePanelReferences(input: ResolvePanelReferencesInput): ReferenceResolution {
  const { request } = input;
  const preferredReferenceIds = input.preferredReferenceIds || {};
  const pinnedReferenceIds = input.pinnedReferenceIds || {};
  const warnings: string[] = [];
  const missing: ReferenceResolution['missing'] = [];
  const worldAssets = input.assets.filter((asset) => asset.worldId === request.worldId);
  const automaticAssets = worldAssets.filter(eligible);
  const selected: SelectedReference[] = [];
  let order = 0;

  for (const manualId of [...new Set(input.manualReferenceIds || [])]) {
    const asset = worldAssets.find((candidate) => candidate.id === manualId);
    if (!asset) {
      warnings.push(`Manual reference "${manualId}" is unavailable in world "${request.worldId}"`);
      continue;
    }
    const role = roleForAsset(asset);
    if (!role) {
      warnings.push(`Manual reference "${manualId}" has no classified role`);
      continue;
    }
    selected.push({ asset, role, label: asset.description || `${role} reference`, order: order++ });
  }

  function addRequirement(
    role: SelectedReference['role'],
    id: string,
    desiredUse: ReferenceUse | null,
    preferenceKeys: readonly string[],
    matches: (asset: ReferenceAsset) => boolean,
  ): void {
    if (selected.some((selection) => selection.role === role && matches(selection.asset))) return;
    const candidates = automaticAssets.filter(
      (asset) => !selected.some((selection) => selection.asset.id === asset.id) && matches(asset),
    );
    candidates.sort((left, right) =>
      compareCandidateScores(
        scoreCandidate(left, desiredUse, request.facets, preferenceKeys, preferredReferenceIds, pinnedReferenceIds),
        scoreCandidate(right, desiredUse, request.facets, preferenceKeys, preferredReferenceIds, pinnedReferenceIds),
      ),
    );
    const chosen = candidates[0];
    if (!chosen) {
      missing.push({ role, id });
      return;
    }
    const conflicts = facetComparison(chosen, request.facets).conflicts;
    if (conflicts.length > 0) {
      warnings.push(`Reference "${chosen.id}" conflicts with requested facets: ${conflicts.join(', ')}`);
    }
    selected.push({ asset: chosen, role, label: id, order: order++ });
  }

  for (const characterId of [...new Set(request.characterIds)]) {
    addRequirement('identity', characterId, 'identity', [characterId, 'identity'], (asset) =>
      Boolean(
        asset.subjectType === 'character' && asset.use === 'identity' && sameIds(asset.characterIds, [characterId]),
      ),
    );
  }

  for (const [characterId, appearanceState] of Object.entries(request.characterStates)) {
    if (!appearanceState) continue;
    addRequirement(
      'appearance',
      `${characterId}:${appearanceState}`,
      'appearance',
      [characterId, `${characterId}:${appearanceState}`, 'appearance'],
      (asset) =>
        asset.subjectType === 'character' &&
        asset.use === 'appearance' &&
        sameIds(asset.characterIds, [characterId]) &&
        asset.facets.appearanceState === appearanceState,
    );
  }

  if (request.locationId) {
    const desiredUse: ReferenceUse =
      request.facets.framing === 'detail'
        ? 'detail'
        : request.facets.framing === 'establishing'
          ? 'establishing'
          : 'spatial';
    addRequirement(
      'location',
      request.locationId,
      desiredUse,
      [request.locationId, 'location'],
      (asset) => asset.subjectType === 'location' && asset.locationId === request.locationId,
    );
  }

  if (request.interaction) {
    const participantIds = [...new Set(request.interaction.participantIds)];
    const interactionId = `${[...participantIds].sort().join('+')}:${request.interaction.type}`;
    addRequirement(
      'interaction',
      interactionId,
      'relationship',
      [interactionId, 'interaction'],
      (asset) =>
        asset.subjectType === 'interaction' &&
        sameIds(asset.characterIds, participantIds) &&
        asset.facets.interactionType === request.interaction?.type,
    );
  }

  for (const propName of [...new Set(request.propNames)]) {
    if (!selected.some((selection) => selection.role === 'prop' && selection.label === propName)) {
      missing.push({ role: 'prop', id: propName });
    }
  }

  const styleReferenceId = pinnedReferenceIds.style || preferredReferenceIds.style;
  if (styleReferenceId) {
    addRequirement(
      'style',
      request.worldId,
      'rendering',
      ['style', request.worldId],
      (asset) => asset.subjectType === 'style' && asset.use === 'rendering',
    );
  }

  selected.sort((left, right) => {
    const roleOrder = ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role);
    return roleOrder || left.order - right.order;
  });

  const budget = Math.max(0, Math.floor(input.budget));
  if (selected.length > budget) {
    return {
      manifest: [],
      dataUrls: [],
      missing,
      warnings,
      error: {
        type: 'capacity',
        required: selected.length,
        budget,
        detail: `This panel needs ${selected.length} mandatory reference image(s), but only ${budget} fit.`,
      },
    };
  }

  const manifest = selected.map((selection, index) => manifestItem(selection, index + 1));
  const dataUrls = selected.map((selection) => selection.asset.dataUrl);
  if (input.previousFrame?.dataUrl && manifest.length < budget) {
    manifest.push({
      index: manifest.length + 1,
      role: 'previous-frame',
      label: 'previous page final panel',
      sourcePageId: input.previousFrame.sourcePageId,
      sourcePanelIndex: input.previousFrame.sourcePanelIndex,
    });
    dataUrls.push(input.previousFrame.dataUrl);
  }

  return { manifest, dataUrls, missing, warnings };
}
