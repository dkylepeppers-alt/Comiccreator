import { z } from 'zod/mini';
import type {
  ReferenceClassification,
  ReferenceClassificationDraft,
  ReferenceFacets,
  ReferenceSubjectType,
  ReferenceUse,
} from './types.js';

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

/**
 * Facets are enrichment, not structure: a single unknown key, misspelled controlled
 * value, or empty phrase drops that one facet rather than terminally failing the
 * whole classification. Only a facets payload that is not an object at all is a
 * schema violation.
 */
function parseFacets(value: unknown, characterIds: ReadonlySet<string>): ReferenceFacets | null {
  if (!isRecord(value)) return null;

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
    if (typeof value[field] === 'string' && (allowed as ReadonlySet<string>).has(value[field])) {
      (facets as Record<string, unknown>)[field] = value[field];
    }
  }

  for (const field of FREE_TEXT_FACETS) {
    const cleaned = cleanString(value[field]);
    if (cleaned) (facets as Record<string, unknown>)[field] = cleaned;
  }

  if (Array.isArray(value.heldProps)) {
    const heldProps: string[] = [];
    for (const item of value.heldProps) {
      const cleaned = cleanString(item);
      if (cleaned && !heldProps.includes(cleaned)) heldProps.push(cleaned);
    }
    if (heldProps.length) facets.heldProps = heldProps;
  }

  if (isRecord(value.screenPositions)) {
    const screenPositions: Record<string, string> = {};
    for (const [characterId, position] of Object.entries(value.screenPositions)) {
      const cleaned = cleanString(position);
      if (characterIds.has(characterId) && cleaned) screenPositions[characterId] = cleaned;
    }
    if (Object.keys(screenPositions).length) facets.screenPositions = screenPositions;
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

const rawDraftSchema = z.object({
  subjectType: z.string(),
  use: z.string(),
  characterIds: z.array(z.string()),
  locationId: z.optional(z.union([z.string(), z.null()])),
  facets: z.record(z.string(), z.unknown()),
  description: z.optional(z.string()),
  confidence: z.optional(z.record(z.string(), z.number())),
  proposedCharacterNames: z.optional(z.array(z.string())),
  proposedLocationName: z.optional(z.union([z.string(), z.null()])),
});

export function parseReferenceClassificationDraft(value: unknown): ReferenceClassificationDraft | null {
  const parsed = rawDraftSchema.safeParse(value);
  if (!parsed.success) return null;
  const candidate = parsed.data;
  const subjectType = candidate.subjectType;
  const use = candidate.use;
  if (
    typeof subjectType !== 'string' ||
    !SUBJECT_TYPES.has(subjectType as ReferenceSubjectType) ||
    typeof use !== 'string' ||
    !SUBJECT_USES[subjectType as ReferenceSubjectType].has(use as ReferenceUse)
  ) {
    return null;
  }

  const characterIds = [...new Set(candidate.characterIds.map((id) => id.trim()).filter(Boolean))];

  const locationId =
    candidate.locationId === undefined || candidate.locationId === null ? null : cleanString(candidate.locationId);
  if (candidate.locationId !== undefined && candidate.locationId !== null && !locationId) {
    return null;
  }

  // Subject/link requirements (a character image needs a character link, an
  // interaction needs two, a location needs a location) are review conditions,
  // not schema violations: an honest "this character is not in the roster yet"
  // answer must land in needs-review via validateReferenceClassificationDraft,
  // not die here as a terminal invalid-schema failure.
  const characterIdSet = new Set(characterIds);
  const facets = parseFacets(candidate.facets, characterIdSet);
  const confidence = parseConfidence(candidate.confidence);
  if (!facets || !confidence) return null;

  let description = '';
  if (candidate.description !== undefined) {
    const cleaned = cleanString(candidate.description);
    if (!cleaned) return null;
    description = cleaned;
  }

  const proposedCharacterNames = [
    ...new Set((candidate.proposedCharacterNames || []).map(cleanString).filter(Boolean)),
  ] as string[];
  const proposedLocationName =
    candidate.proposedLocationName === undefined || candidate.proposedLocationName === null
      ? null
      : cleanString(candidate.proposedLocationName);
  if (candidate.proposedLocationName !== undefined && candidate.proposedLocationName !== null && !proposedLocationName)
    return null;

  return {
    subjectType: subjectType as ReferenceSubjectType,
    use: use as ReferenceUse,
    characterIds,
    locationId,
    facets,
    description,
    confidence,
    proposedCharacterNames,
    proposedLocationName,
  };
}

export interface ValidatedReferenceClassification {
  state: 'ready' | 'needs-review';
  classification: ReferenceClassification;
  validationReason?: 'unmatched-entity-links' | 'low-confidence' | 'subject-requirements';
}

export function validateReferenceClassificationDraft(
  draft: ReferenceClassificationDraft,
  roster: ReferenceRoster,
): ValidatedReferenceClassification {
  const matchedCharacterIds = draft.characterIds.filter((id) => roster.characterIds.has(id));
  const unmatchedCharacterNames = draft.characterIds.filter((id) => !roster.characterIds.has(id));
  const hasMatchedLocation = draft.locationId !== null && roster.locationIds.has(draft.locationId);
  const unmatchedLocationName = draft.locationId && !hasMatchedLocation ? draft.locationId : null;
  const classification: ReferenceClassification = {
    ...draft,
    characterIds: matchedCharacterIds,
    locationId: hasMatchedLocation ? draft.locationId : null,
    facets:
      draft.facets.screenPositions === undefined
        ? draft.facets
        : {
            ...draft.facets,
            screenPositions: Object.fromEntries(
              Object.entries(draft.facets.screenPositions).filter(([id]) => matchedCharacterIds.includes(id)),
            ),
          },
    proposedCharacterNames: [...new Set([...(draft.proposedCharacterNames || []), ...unmatchedCharacterNames])],
    proposedLocationName: draft.proposedLocationName || unmatchedLocationName,
  };
  const hasUnmatchedLinks = unmatchedCharacterNames.length > 0 || Boolean(unmatchedLocationName);
  const subjectSatisfied =
    (draft.subjectType === 'character' && matchedCharacterIds.length >= 1) ||
    (draft.subjectType === 'interaction' && matchedCharacterIds.length >= 2) ||
    (draft.subjectType === 'location' && hasMatchedLocation) ||
    draft.subjectType === 'prop' ||
    draft.subjectType === 'style';
  const confidenceFields = ['subject', 'links', 'use', 'facets'] as const;
  const hasLowConfidence = confidenceFields.some((field) => (draft.confidence[field] || 0) < 0.75);
  if (hasUnmatchedLinks) return { state: 'needs-review', classification, validationReason: 'unmatched-entity-links' };
  if (!subjectSatisfied) return { state: 'needs-review', classification, validationReason: 'subject-requirements' };
  if (hasLowConfidence) return { state: 'needs-review', classification, validationReason: 'low-confidence' };
  return { state: 'ready', classification };
}

export function parseReferenceClassification(value: unknown, roster: ReferenceRoster): ReferenceClassification | null {
  const draft = parseReferenceClassificationDraft(value);
  if (!draft) return null;
  const validated = validateReferenceClassificationDraft(draft, roster);
  return ['unmatched-entity-links', 'subject-requirements'].includes(validated.validationReason || '')
    ? null
    : validated.classification;
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
