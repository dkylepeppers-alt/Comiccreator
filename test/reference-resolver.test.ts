import { describe, expect, it } from 'vitest';
import { compareCandidateScores, resolvePanelReferences } from '../src/js/references/resolver.js';
import type { PanelReferenceRequest, ReferenceAsset } from '../src/js/references/types.js';

function asset(overrides: Partial<ReferenceAsset>): ReferenceAsset {
  return {
    id: 'r1',
    worldId: 'w1',
    dataUrl: 'data:image/png;base64,r1',
    subjectType: 'character',
    use: 'identity',
    characterIds: ['mara'],
    locationId: null,
    facets: {},
    description: '',
    confidence: {},
    provenance: { source: 'uploaded', metadata: 'local' },
    classificationState: 'ready',
    acceptedAsIs: false,
    autoUse: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function request(overrides: Partial<PanelReferenceRequest> = {}): PanelReferenceRequest {
  return {
    worldId: 'w1',
    characterIds: [],
    locationId: null,
    characterStates: {},
    interaction: null,
    facets: {},
    propNames: [],
    ...overrides,
  };
}

describe('panel reference resolver', () => {
  it('selects identity, exact state, location, and shared interaction in role order', () => {
    const result = resolvePanelReferences({
      request: request({
        characterIds: ['mara', 'theo'],
        locationId: 'yard',
        interaction: { participantIds: ['mara', 'theo'], type: 'conversation' },
        facets: { framing: 'medium', timeOfDay: 'night' },
        characterStates: { mara: 'red-coat' },
      }),
      assets: [
        asset({ id: 'mara-id', dataUrl: 'mara-id', characterIds: ['mara'] }),
        asset({ id: 'theo-id', dataUrl: 'theo-id', characterIds: ['theo'] }),
        asset({
          id: 'mara-red',
          dataUrl: 'mara-red',
          use: 'appearance',
          characterIds: ['mara'],
          facets: { appearanceState: 'red-coat' },
        }),
        asset({
          id: 'yard-night',
          dataUrl: 'yard-night',
          subjectType: 'location',
          use: 'establishing',
          characterIds: [],
          locationId: 'yard',
          facets: { timeOfDay: 'night', framing: 'medium' },
        }),
        asset({
          id: 'conversation',
          dataUrl: 'conversation',
          subjectType: 'interaction',
          use: 'relationship',
          characterIds: ['theo', 'mara'],
          facets: { interactionType: 'conversation', framing: 'medium' },
        }),
      ],
      budget: 5,
    });

    expect(result.manifest.map((item) => item.role)).toEqual([
      'identity',
      'identity',
      'appearance',
      'location',
      'interaction',
    ]);
    expect(result.dataUrls).toEqual(['mara-id', 'theo-id', 'mara-red', 'yard-night', 'conversation']);
    expect(result.missing).toEqual([]);
  });

  it('excludes hidden and unaccepted review assets but permits explicit manual IDs', () => {
    const hidden = asset({ autoUse: false });
    const review = asset({ id: 'r2', classificationState: 'needs-review' });
    const input = { request: request({ characterIds: ['mara'] }), assets: [hidden, review], budget: 2 };

    expect(resolvePanelReferences(input).manifest).toEqual([]);
    expect(resolvePanelReferences({ ...input, manualReferenceIds: ['r1'] }).manifest[0].imageId).toBe('r1');

    review.acceptedAsIs = true;
    expect(resolvePanelReferences(input).manifest[0].imageId).toBe('r2');
  });

  it('never crosses worlds or silently substitutes a missing location', () => {
    const result = resolvePanelReferences({
      request: request({ locationId: 'missing' }),
      assets: [
        asset({
          id: 'other-world-yard',
          worldId: 'w2',
          subjectType: 'location',
          use: 'establishing',
          characterIds: [],
          locationId: 'missing',
        }),
      ],
      budget: 1,
    });

    expect(result.manifest).toEqual([]);
    expect(result.missing).toContainEqual({ role: 'location', id: 'missing' });
  });

  it('uses facet, pinned, preferred, and stable-ID scoring deterministically', () => {
    const base = {
      request: request({ characterIds: ['mara'] }),
      budget: 1,
      assets: [asset({ id: 'b', dataUrl: 'b' }), asset({ id: 'a', dataUrl: 'a' })],
    };

    expect(resolvePanelReferences(base).manifest[0].imageId).toBe('a');
    expect(resolvePanelReferences({ ...base, preferredReferenceIds: { mara: 'b' } }).manifest[0].imageId).toBe('b');
    expect(resolvePanelReferences({ ...base, pinnedReferenceIds: { mara: 'b' } }).manifest[0].imageId).toBe('b');
    expect(compareCandidateScores([1, 1, 0, 0, 0, 'a'], [1, 1, 0, 0, 0, 'b'])).toBeLessThan(0);

    const locationResult = resolvePanelReferences({
      request: request({ locationId: 'yard', facets: { timeOfDay: 'night' } }),
      budget: 1,
      assets: [
        asset({
          id: 'day',
          subjectType: 'location',
          use: 'establishing',
          characterIds: [],
          locationId: 'yard',
          facets: { timeOfDay: 'day' as never },
        }),
        asset({
          id: 'night',
          subjectType: 'location',
          use: 'establishing',
          characterIds: [],
          locationId: 'yard',
          facets: { timeOfDay: 'night' },
        }),
      ],
    });
    expect(locationResult.manifest[0].imageId).toBe('night');
  });

  it('returns a capacity error instead of dropping mandatory references', () => {
    const result = resolvePanelReferences({
      request: request({ characterIds: ['mara', 'theo'] }),
      assets: [asset({ id: 'mara', characterIds: ['mara'] }), asset({ id: 'theo', characterIds: ['theo'] })],
      budget: 1,
    });

    expect(result.manifest).toEqual([]);
    expect(result.dataUrls).toEqual([]);
    expect(result.error).toMatchObject({ type: 'capacity', required: 2, budget: 1 });
  });

  it('appends previous-frame continuity only when capacity remains', () => {
    const result = resolvePanelReferences({
      request: request({ characterIds: ['mara'] }),
      assets: [asset({ id: 'mara' })],
      budget: 2,
      previousFrame: { dataUrl: 'previous', sourcePageId: 'p1', sourcePanelIndex: 3 },
    });

    expect(result.manifest.map((item) => item.role)).toEqual(['identity', 'previous-frame']);
    expect(result.manifest[1]).toMatchObject({ sourcePageId: 'p1', sourcePanelIndex: 3 });
    expect(result.dataUrls).toEqual(['data:image/png;base64,r1', 'previous']);
  });

  it('resolves an exact prop asset instead of reporting every prop missing', () => {
    const result = resolvePanelReferences({
      request: request({ propNames: ['signal lamp'] }),
      assets: [
        asset({
          id: 'lamp',
          subjectType: 'prop',
          use: 'design',
          characterIds: [],
          description: 'signal lamp',
        }),
      ],
      budget: 1,
    });

    expect(result.manifest).toContainEqual(expect.objectContaining({ role: 'prop', imageId: 'lamp' }));
    expect(result.missing).toEqual([]);
  });
});
