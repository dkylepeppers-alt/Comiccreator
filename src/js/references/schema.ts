import type { ReferenceClassification, ReferenceFacets, ReferenceSubjectType, ReferenceUse } from './types.js';

export interface ReferenceRoster {
  worldId: string;
  characterIds: ReadonlySet<string>;
  locationIds: ReadonlySet<string>;
}

export interface ReferenceLabels {
  characterNames: Readonly<Record<string, string>>;
  locationNames: Readonly<Record<string, string>>;
}

const SUBJECT_USES: Readonly<Record<ReferenceSubjectType, ReadonlySet<ReferenceUse>>> = {
  character: new Set(['identity', 'appearance', 'expression', 'pose', 'action']),
  location: new Set(['establishing', 'spatial', 'landmark', 'detail']),
  interaction: new Set(['relationship', 'action']),
  prop: new Set(['design', 'state']),
  style: new Set(['rendering']),
};

const FRAMINGS = new Set<NonNullable<ReferenceFacets['framing']>>([
  'extreme-close-up',
  'close-up',
  'medium-close-up',
  'medium',
  'three-quarter',
  'full-body',
  'wide',
  'establishing',
  'detail',
]);
const CAMERA_ELEVATIONS = new Set<NonNullable<ReferenceFacets['cameraElevation']>>([
  'eye-level',
  'high',
  'low',
  'overhead',
  'aerial',
  'ground-level',
]);
const VIEW_DIRECTIONS = new Set<NonNullable<ReferenceFacets['viewDirection']>>([
  'front',
  'three-quarter-front',
  'left-profile',
  'right-profile',
  'three-quarter-rear',
  'rear',
]);
const IDENTITY_COVERAGES = new Set<NonNullable<ReferenceFacets['identityCoverage']>>([
  'face',
  'upper-body',
  'full-body',
]);
const SPACE_TYPES = new Set<NonNullable<ReferenceFacets['spaceType']>>(['interior', 'exterior', 'threshold']);
const TIMES_OF_DAY = new Set<NonNullable<ReferenceFacets['timeOfDay']>>([
  'dawn',
  'morning',
  'midday',
  'afternoon',
  'dusk',
  'night',
]);
const SUBJECT_TYPES = new Set<ReferenceSubjectType>(Object.keys(SUBJECT_USES) as ReferenceSubjectType[]);
const CONFIDENCE_FIELDS = new Set(['subject', 'links', 'use', 'facets']);
const FACET_FIELDS = new Set<keyof ReferenceFacets>([
  'framing',
  'cameraElevation',
  'viewDirection',
  'identityCoverage',
  'spaceType',
  'timeOfDay',
  'interactionType',
  'spatialArrangement',
  'lighting',
  'visibility',
  'appearanceState',
  'expression',
  'pose',
  'activity',
  'weather',
  'season',
  'physicalContact',
  'screenPositions',
  'heldProps',
]);
const FREE_TEXT_FACETS = new Set<keyof ReferenceFacets>([
  'interactionType',
  'spatialArrangement',
  'lighting',
  'visibility',
  'appearanceState',
  'expression',
  'pose',
  'activity',
  'weather',
  'season',
  'physicalContact',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function parseFacets(
  value: unknown,
  characterIds: ReadonlySet<string>,
  roster: ReferenceRoster,
): ReferenceFacets | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !FACET_FIELDS.has(key as keyof ReferenceFacets))) {
    return null;
  }

  const facets: ReferenceFacets = {};
  const controlled = [
    ['framing', FRAMINGS],
    ['cameraElevation', CAMERA_ELEVATIONS],
    ['viewDirection', VIEW_DIRECTIONS],
    ['identityCoverage', IDENTITY_COVERAGES],
    ['spaceType', SPACE_TYPES],
    ['timeOfDay', TIMES_OF_DAY],
  ] as const;
  for (const [field, allowed] of controlled) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string' || !(allowed as ReadonlySet<string>).has(value[field])) return null;
    (facets as Record<string, unknown>)[field] = value[field];
  }

  for (const field of FREE_TEXT_FACETS) {
    if (value[field] === undefined) continue;
    const cleaned = cleanString(value[field]);
    if (!cleaned) return null;
    (facets as Record<string, unknown>)[field] = cleaned;
  }

  if (value.heldProps !== undefined) {
    if (!Array.isArray(value.heldProps)) return null;
    const heldProps: string[] = [];
    for (const item of value.heldProps) {
      const cleaned = cleanString(item);
      if (!cleaned) return null;
      if (!heldProps.includes(cleaned)) heldProps.push(cleaned);
    }
    facets.heldProps = heldProps;
  }

  if (value.screenPositions !== undefined) {
    if (!isRecord(value.screenPositions)) return null;
    const screenPositions: Record<string, string> = {};
    for (const [characterId, position] of Object.entries(value.screenPositions)) {
      const cleaned = cleanString(position);
      if (!roster.characterIds.has(characterId) || !characterIds.has(characterId) || !cleaned) return null;
      screenPositions[characterId] = cleaned;
    }
    facets.screenPositions = screenPositions;
  }

  return facets;
}

function parseConfidence(value: unknown): ReferenceClassification['confidence'] | null {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => !CONFIDENCE_FIELDS.has(key))) return null;
  const confidence: ReferenceClassification['confidence'] = {};
  for (const [field, score] of Object.entries(value)) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return null;
    confidence[field as keyof ReferenceClassification['confidence']] = score;
  }
  return confidence;
}

export function parseReferenceClassification(value: unknown, roster: ReferenceRoster): ReferenceClassification | null {
  if (!isRecord(value)) return null;
  const subjectType = value.subjectType;
  const use = value.use;
  if (
    typeof subjectType !== 'string' ||
    !SUBJECT_TYPES.has(subjectType as ReferenceSubjectType) ||
    typeof use !== 'string' ||
    !SUBJECT_USES[subjectType as ReferenceSubjectType].has(use as ReferenceUse)
  ) {
    return null;
  }

  if (!Array.isArray(value.characterIds) || value.characterIds.some((id) => typeof id !== 'string')) return null;
  const characterIds = [...new Set(value.characterIds.map((id) => id.trim()).filter(Boolean))];
  if (characterIds.some((id) => !roster.characterIds.has(id))) return null;

  const locationId = value.locationId === undefined || value.locationId === null ? null : cleanString(value.locationId);
  if (
    (value.locationId !== undefined && value.locationId !== null && !locationId) ||
    (locationId && !roster.locationIds.has(locationId))
  ) {
    return null;
  }

  if (subjectType === 'character' && characterIds.length === 0) return null;
  if (subjectType === 'interaction' && characterIds.length < 2) return null;
  if (subjectType === 'location' && !locationId) return null;

  const characterIdSet = new Set(characterIds);
  const facets = parseFacets(value.facets, characterIdSet, roster);
  const confidence = parseConfidence(value.confidence);
  if (!facets || !confidence) return null;

  let description = '';
  if (value.description !== undefined) {
    const cleaned = cleanString(value.description);
    if (!cleaned) return null;
    description = cleaned;
  }

  return {
    subjectType: subjectType as ReferenceSubjectType,
    use: use as ReferenceUse,
    characterIds,
    locationId,
    facets,
    description,
    confidence,
  };
}

function titleCase(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function facetLabel(classification: ReferenceClassification): string | null {
  const { facets, subjectType, use } = classification;
  if (subjectType === 'character') {
    if (use === 'appearance' && facets.appearanceState) return facets.appearanceState;
    if (use === 'expression' && facets.expression) return facets.expression;
    if (use === 'pose' && facets.pose) return facets.pose;
    if (use === 'action' && facets.activity) return facets.activity;
    return facets.viewDirection || facets.identityCoverage || facets.framing || null;
  }
  if (subjectType === 'location') {
    return facets.timeOfDay || facets.spaceType || facets.framing || null;
  }
  if (subjectType === 'interaction') {
    return facets.framing || facets.interactionType || facets.spatialArrangement || null;
  }
  return facets.framing || facets.appearanceState || facets.lighting || null;
}

export function formatReferenceLabel(classification: ReferenceClassification, labels: ReferenceLabels): string {
  let entityLabel = '';
  if (classification.subjectType === 'location') {
    const locationId = classification.locationId || '';
    entityLabel = labels.locationNames[locationId] || locationId;
  } else if (classification.characterIds.length > 0) {
    entityLabel = classification.characterIds.map((id) => labels.characterNames[id] || id).join(' + ');
  }

  return [titleCase(classification.subjectType), entityLabel, titleCase(classification.use), facetLabel(classification)]
    .filter((part): part is string => Boolean(part))
    .map(titleCase)
    .join(' / ');
}
