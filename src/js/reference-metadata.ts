import type { ImageRef } from './utils.js';
import { normalizeLocationKey } from './utils.js';
import type { CharacterVisualStateDefaults } from './visual-continuity.js';

export type ReferenceViewAngle = 'front' | 'side' | 'back' | 'three-quarter' | 'multiple' | 'unspecified';
export type ReferenceFraming = 'close-up' | 'medium' | 'full-body' | 'character-sheet' | 'unspecified';
export type ReferenceActivity = 'neutral' | 'action' | 'expression' | 'interaction' | 'unspecified';
export type ReferenceContext = 'isolated' | 'in-world' | 'unspecified';
export type ReferenceMetadataSource = 'legacy' | 'local' | 'manual';

export interface ReferenceClassifications {
  schemaVersion: 1;
  viewAngle: ReferenceViewAngle;
  framing: ReferenceFraming;
  activity: ReferenceActivity;
  context: ReferenceContext;
}

export interface CharacterReferenceImage extends ImageRef {
  referenceKey?: string | null;
  referenceKeySource?: ReferenceMetadataSource;
  referenceClassifications?: ReferenceClassifications;
  referenceVisualState?: CharacterVisualStateDefaults;
  referenceMetadataSource?: ReferenceMetadataSource;
  generationPrompt?: string;
  tag?: string;
}

export interface ReferenceClassification {
  referenceKey: string;
  classifications: ReferenceClassifications;
  visualState: Required<CharacterVisualStateDefaults>;
}

const VIEW_ANGLES = new Set<ReferenceViewAngle>(['front', 'side', 'back', 'three-quarter', 'multiple', 'unspecified']);
const FRAMINGS = new Set<ReferenceFraming>(['close-up', 'medium', 'full-body', 'character-sheet', 'unspecified']);
const ACTIVITIES = new Set<ReferenceActivity>(['neutral', 'action', 'expression', 'interaction', 'unspecified']);
const CONTEXTS = new Set<ReferenceContext>(['isolated', 'in-world', 'unspecified']);

export function normalizeReferenceKey(value: unknown): string {
  return normalizeLocationKey(typeof value === 'string' ? value : '');
}

function legacyClassifications(tag: string): ReferenceClassifications {
  const viewAngle: ReferenceViewAngle =
    tag === 'front-view'
      ? 'front'
      : tag === 'side-view'
        ? 'side'
        : tag === 'back-view'
          ? 'back'
          : tag === 'character-sheet'
            ? 'multiple'
            : 'unspecified';
  const framing: ReferenceFraming =
    tag === 'close-up' ? 'close-up' : tag === 'character-sheet' ? 'character-sheet' : 'unspecified';
  const activity: ReferenceActivity =
    tag === 'action-pose'
      ? 'action'
      : tag === 'expression'
        ? 'expression'
        : tag === 'character-in-world'
          ? 'interaction'
          : 'unspecified';
  const context: ReferenceContext = tag === 'character-in-world' ? 'in-world' : 'unspecified';
  return { schemaVersion: 1, viewAngle, framing, activity, context };
}

export function migrateCharacterReferenceMetadata(source: CharacterReferenceImage[] | null | undefined): {
  images: CharacterReferenceImage[];
  changed: boolean;
} {
  if (!Array.isArray(source)) return { images: [], changed: false };
  const used = new Set<string>();
  let changed = false;
  const images = source.map((image) => {
    if (!image) return image;
    if (image.referenceKey) used.add(normalizeReferenceKey(image.referenceKey));
    if (image.referenceKey !== undefined && image.referenceClassifications) return image;

    const legacyTag = normalizeReferenceKey(image.tag || '');
    const generic = !legacyTag || legacyTag === 'default' || legacyTag === 'custom';
    let referenceKey: string | null = generic ? null : legacyTag;
    if (referenceKey) {
      const base = referenceKey;
      let suffix = 2;
      while (used.has(referenceKey)) referenceKey = `${base}-${suffix++}`;
      used.add(referenceKey);
    }
    changed = true;
    return {
      ...image,
      referenceKey,
      referenceKeySource: 'legacy' as const,
      referenceClassifications: legacyClassifications(legacyTag),
      referenceMetadataSource: 'legacy' as const,
    };
  });
  return { images: changed ? images : source, changed };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean).slice(0, 12);
}

export function parseReferenceClassification(text: string): ReferenceClassification | null {
  try {
    const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const parsed = JSON.parse(fenced ? fenced[1] : text.trim());
    const key = normalizeReferenceKey(parsed.referenceKey);
    const c = parsed.classifications || {};
    if (
      !key ||
      !VIEW_ANGLES.has(c.viewAngle) ||
      !FRAMINGS.has(c.framing) ||
      !ACTIVITIES.has(c.activity) ||
      !CONTEXTS.has(c.context)
    ) {
      return null;
    }
    const visual = parsed.visualState || {};
    return {
      referenceKey: key,
      classifications: {
        schemaVersion: 1,
        viewAngle: c.viewAngle,
        framing: c.framing,
        activity: c.activity,
        context: c.context,
      },
      visualState: {
        wardrobeDescription: stringValue(visual.wardrobeDescription),
        hairState: stringValue(visual.hairState),
        carriedItems: stringArray(visual.carriedItems),
        injuries: stringArray(visual.injuries),
        temporaryChanges: stringArray(visual.temporaryChanges),
      },
    };
  } catch {
    return null;
  }
}

const VISUAL_STATE_FIELDS = [
  'wardrobeDescription',
  'hairState',
  'carriedItems',
  'injuries',
  'temporaryChanges',
] as const;

function hasVisualValue(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0;
}

export function applyReferenceClassification(
  character: any,
  imageId: string,
  classification: ReferenceClassification,
): { record: any; changed: boolean } {
  const index = (character.images || []).findIndex((image: CharacterReferenceImage) => image?.id === imageId);
  if (index < 0 || character.images[index]?.referenceMetadataSource === 'manual') {
    return { record: character, changed: false };
  }

  const used = new Set(
    (character.images || [])
      .filter((image: CharacterReferenceImage) => image?.id !== imageId)
      .map((image: CharacterReferenceImage) => normalizeReferenceKey(image.referenceKey))
      .filter(Boolean),
  );
  const base = classification.referenceKey;
  let referenceKey = base;
  let suffix = 2;
  while (used.has(referenceKey)) referenceKey = `${base}-${suffix++}`;

  const images = [...character.images];
  images[index] = {
    ...images[index],
    referenceKey,
    referenceKeySource: 'local',
    referenceClassifications: classification.classifications,
    referenceVisualState: classification.visualState,
    referenceMetadataSource: 'local',
  };
  let record = { ...character, images };

  if (character.identityAnchorImageId === imageId) {
    const defaults = { ...(character.defaultVisualState || {}) };
    const sources = { ...(character.defaultVisualStateSources || {}) };
    for (const field of VISUAL_STATE_FIELDS) {
      const source = sources[field];
      if (source === 'manual' || (!source && hasVisualValue(defaults[field]))) continue;
      defaults[field] = classification.visualState[field] as never;
      if (hasVisualValue(classification.visualState[field]) || source === 'local') sources[field] = 'local';
    }
    record = { ...record, defaultVisualState: defaults, defaultVisualStateSources: sources };
  }
  return { record, changed: true };
}
