import { describe, expect, it } from 'vitest';
import {
  formatReferenceLabel,
  parseReferenceClassification,
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
});
