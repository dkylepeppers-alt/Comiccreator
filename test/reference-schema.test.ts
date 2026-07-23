import { describe, expect, it } from 'vitest';
import {
  formatReferenceLabel,
  parseReferenceClassificationDraft,
  parseReferenceClassification,
  validateReferenceClassificationDraft,
} from '../src/js/references/schema.js';

describe('reference classification schema', () => {
  const roster = {
    worldId: 'w1',
    characterIds: new Set(['mara', 'theo']),
    locationIds: new Set(['yard']),
  };

  it('accepts a useful interaction classification', () => {
    const value = parseReferenceClassification(
      {
        subjectType: 'interaction',
        use: 'relationship',
        characterIds: ['mara', 'theo'],
        locationId: 'yard',
        facets: {
          framing: 'medium',
          interactionType: 'conversation',
          spatialArrangement: 'face-to-face',
        },
        description: 'Mara and Theo talk in the courtyard.',
      },
      roster,
    );

    expect(value?.characterIds).toEqual(['mara', 'theo']);
    expect(
      formatReferenceLabel(value!, {
        characterNames: { mara: 'Mara', theo: 'Theo' },
        locationNames: { yard: 'Castle courtyard' },
      }),
    ).toBe('Interaction / Mara + Theo / Relationship / Medium');
  });

  it('rejects unknown entity IDs and controlled values', () => {
    expect(
      parseReferenceClassification(
        {
          subjectType: 'character',
          use: 'identity',
          characterIds: ['ghost'],
          facets: {},
        },
        roster,
      ),
    ).toBeNull();
    expect(
      parseReferenceClassification(
        {
          subjectType: 'location',
          use: 'establishing',
          characterIds: [],
          facets: { framing: 'random' },
        },
        roster,
      ),
    ).toBeNull();
  });

  it('enforces subject and use compatibility', () => {
    expect(
      parseReferenceClassification(
        {
          subjectType: 'location',
          use: 'identity',
          characterIds: [],
          locationId: 'yard',
          facets: {},
        },
        roster,
      ),
    ).toBeNull();
    expect(
      parseReferenceClassification(
        {
          subjectType: 'character',
          use: 'appearance',
          characterIds: ['mara'],
          facets: {},
        },
        roster,
      )?.use,
    ).toBe('appearance');
  });

  it('deduplicates stable IDs and validates confidence ranges', () => {
    expect(
      parseReferenceClassification(
        {
          subjectType: 'interaction',
          use: 'relationship',
          characterIds: ['mara', 'mara', 'theo'],
          facets: {},
          confidence: { subject: 0.9, links: 0.8 },
        },
        roster,
      )?.characterIds,
    ).toEqual(['mara', 'theo']);
    expect(
      parseReferenceClassification(
        {
          subjectType: 'character',
          use: 'identity',
          characterIds: ['mara'],
          facets: {},
          confidence: { subject: 1.1 },
        },
        roster,
      ),
    ).toBeNull();
  });

  it('rejects malformed optional facet collections', () => {
    expect(
      parseReferenceClassification(
        {
          subjectType: 'character',
          use: 'action',
          characterIds: ['mara'],
          facets: { heldProps: ['sword', 3] },
        },
        roster,
      ),
    ).toBeNull();
    expect(
      parseReferenceClassification(
        {
          subjectType: 'interaction',
          use: 'spatial',
          characterIds: ['mara', 'theo'],
          facets: { screenPositions: { mara: 'left', ghost: 'right' } },
        },
        roster,
      ),
    ).toBeNull();
  });

  it('keeps an otherwise valid draft reviewable when its entity links no longer match the roster', () => {
    const draft = parseReferenceClassificationDraft({
      subjectType: 'character',
      use: 'identity',
      characterIds: ['Mara Vale'],
      locationId: 'Forgotten atrium',
      facets: { framing: 'medium' },
      description: 'A red-coated woman in an atrium.',
      confidence: { subject: 0.91, links: 0.83, use: 0.9, facets: 0.88 },
    });

    expect(validateReferenceClassificationDraft(draft!, roster).classification).toMatchObject({
      proposedCharacterNames: ['Mara Vale'],
      proposedLocationName: 'Forgotten atrium',
    });
    expect(validateReferenceClassificationDraft(draft!, roster)).toMatchObject({
      state: 'needs-review',
      validationReason: 'unmatched-entity-links',
    });
  });

  it('requires the 0.75 confidence threshold and the subject-specific roster links before a draft is ready', () => {
    const draft = parseReferenceClassificationDraft({
      subjectType: 'interaction',
      use: 'relationship',
      characterIds: ['mara', 'theo'],
      locationId: null,
      facets: {},
      description: 'Mara and Theo speak.',
      confidence: { subject: 0.75, links: 0.75, use: 0.75, facets: 0.75 },
    });
    const lowConfidence = parseReferenceClassificationDraft({
      subjectType: 'style',
      use: 'rendering',
      characterIds: [],
      locationId: null,
      facets: {},
      description: 'Ink wash.',
      confidence: { subject: 0.74, links: 1, use: 1, facets: 1 },
    });
    const missingConfidence = parseReferenceClassificationDraft({
      subjectType: 'prop',
      use: 'design',
      characterIds: [],
      locationId: null,
      facets: {},
      description: 'A silver locket.',
      confidence: {},
    });

    expect(validateReferenceClassificationDraft(draft!, roster)).toMatchObject({ state: 'ready' });
    expect(validateReferenceClassificationDraft(lowConfidence!, roster)).toMatchObject({
      state: 'needs-review',
      validationReason: 'low-confidence',
    });
    expect(validateReferenceClassificationDraft(missingConfidence!, roster)).toMatchObject({
      state: 'needs-review',
      validationReason: 'low-confidence',
    });
  });

  it('keeps subject/link requirements as review conditions instead of schema failures', () => {
    // An honest "no roster entity matches" answer must parse and land in review;
    // a terminal invalid-schema here made unknown characters unclassifiable forever.
    const unlinkedCharacter = parseReferenceClassificationDraft({
      subjectType: 'character',
      use: 'identity',
      characterIds: [],
      locationId: null,
      facets: {},
      description: 'An unknown swordsman.',
      confidence: { subject: 0.9, links: 0.9, use: 0.9, facets: 0.9 },
      proposedCharacterNames: ['Swordsman'],
    });
    expect(unlinkedCharacter).not.toBeNull();
    expect(validateReferenceClassificationDraft(unlinkedCharacter!, roster)).toMatchObject({
      state: 'needs-review',
      validationReason: 'subject-requirements',
      classification: { proposedCharacterNames: ['Swordsman'] },
    });

    const unlinkedLocation = parseReferenceClassificationDraft({
      subjectType: 'location',
      use: 'establishing',
      characterIds: [],
      locationId: null,
      facets: {},
      description: 'A ruined tower.',
      confidence: { subject: 0.9, links: 0.9, use: 0.9, facets: 0.9 },
    });
    expect(validateReferenceClassificationDraft(unlinkedLocation!, roster)).toMatchObject({
      state: 'needs-review',
      validationReason: 'subject-requirements',
    });

    const soloInteraction = parseReferenceClassificationDraft({
      subjectType: 'interaction',
      use: 'relationship',
      characterIds: ['mara'],
      locationId: null,
      facets: {},
      description: 'Mara reaches toward someone off-frame.',
      confidence: { subject: 0.9, links: 0.9, use: 0.9, facets: 0.9 },
    });
    expect(validateReferenceClassificationDraft(soloInteraction!, roster)).toMatchObject({
      state: 'needs-review',
      validationReason: 'subject-requirements',
    });

    // The strict import-path parser still refuses to promote these to usable records.
    expect(
      parseReferenceClassification(
        {
          subjectType: 'character',
          use: 'identity',
          characterIds: [],
          facets: {},
        },
        roster,
      ),
    ).toBeNull();
  });

  it('drops unmatched screen-position keys while preserving only an entity proposal', () => {
    const draft = parseReferenceClassificationDraft({
      subjectType: 'interaction',
      use: 'relationship',
      characterIds: ['mara', 'ghost'],
      locationId: null,
      facets: { screenPositions: { mara: 'left', ghost: 'right' } },
      description: 'Mara faces an unknown person.',
      confidence: { subject: 0.9, links: 0.9, use: 0.9, facets: 0.9 },
    });

    const result = validateReferenceClassificationDraft(draft!, roster);
    expect(result.classification.characterIds).toEqual(['mara']);
    expect(result.classification.proposedCharacterNames).toEqual(['ghost']);
    expect(result.classification.facets.screenPositions).toEqual({ mara: 'left' });
  });
});
