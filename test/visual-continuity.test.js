import { describe, it, expect } from 'vitest';
import {
  SEQUENTIAL_MODEL_ID,
  normalizeStateText,
  createCharacterVisualState,
  initializeContinuity,
  applyVisualStateChange,
  reducePageStates,
  resolveIdentityAnchorImage,
  collectPageCast,
  effectiveReferenceBudget,
  resolveImageGenerationPlan,
  validatePlannedPage,
  compilePanelDescription,
  compileSequentialPagePrompt,
  compileIndependentPanelPrompt,
} from '../src/js/visual-continuity.js';

const mara = {
  id: 'char-mara',
  name: 'Mara',
  appearance: 'tall, wiry, cropped black hair',
  images: [
    { id: 'img-a', dataUrl: 'data:image/png;base64,AAA', tag: 'default' },
    { id: 'img-b', dataUrl: 'data:image/png;base64,BBB', tag: 'alternate-outfit' },
  ],
  primaryImageIndex: 1,
  identityAnchorImageId: 'img-a',
  defaultVisualState: {
    wardrobeDescription: 'faded olive coveralls,  sleeves rolled to the elbows',
    hairState: 'loose and dry',
    carriedItems: ['red shop rag'],
  },
};

const ellis = {
  id: 'char-ellis',
  name: 'Ellis',
  images: [{ id: 'img-e1', dataUrl: 'data:image/png;base64,EEE', tag: 'default' }],
  primaryImageIndex: 0,
  identityAnchorImageId: 'img-e1',
};

function panel(overrides = {}) {
  return {
    narration: '',
    dialogue: [],
    visual: {
      locationId: null,
      environment: '',
      framing: 'medium',
      cameraElevation: 'eye-level',
      lighting: '',
      characters: [],
      keyProps: [],
      ...overrides.visual,
    },
    visualStateChanges: overrides.visualStateChanges || [],
  };
}

describe('state initialization', () => {
  it('normalizes wardrobe whitespace once at state entry and preserves it verbatim after', () => {
    const s = createCharacterVisualState(mara);
    expect(s.wardrobeDescription).toBe('faded olive coveralls, sleeves rolled to the elbows');
    expect(s.revision).toBe(0);
    expect(s.identityAnchorImageId).toBe('img-a');
    expect(s.carriedItems).toEqual(['red shop rag']);
  });

  it('applies per-comic overrides over character defaults', () => {
    const s = createCharacterVisualState(mara, { wardrobeDescription: 'grey jumpsuit' });
    expect(s.wardrobeDescription).toBe('grey jumpsuit');
    expect(s.hairState).toBe('loose and dry');
  });

  it('initializeContinuity builds one state per character', () => {
    const cont = initializeContinuity([mara, ellis]);
    expect(Object.keys(cont.characterStates).sort()).toEqual(['char-ellis', 'char-mara']);
    expect(cont.schemaVersion).toBe(1);
  });
});

describe('applyVisualStateChange', () => {
  const base = createCharacterVisualState(mara);

  it('present string replaces; revision increments', () => {
    const next = applyVisualStateChange(base, { wardrobeDescription: 'black rain poncho' });
    expect(next.wardrobeDescription).toBe('black rain poncho');
    expect(next.revision).toBe(1);
    expect(base.wardrobeDescription).toBe('faded olive coveralls, sleeves rolled to the elbows');
  });

  it('null clears a string; omitted fields stay unchanged', () => {
    const next = applyVisualStateChange(base, { wardrobeDescription: null });
    expect(next.wardrobeDescription).toBe('');
    expect(next.hairState).toBe('loose and dry');
  });

  it('present array replaces; empty array clears; null clears', () => {
    const withItems = applyVisualStateChange(base, { carriedItems: ['wrench', 'lantern'] });
    expect(withItems.carriedItems).toEqual(['wrench', 'lantern']);
    const cleared = applyVisualStateChange(withItems, { carriedItems: [] });
    expect(cleared.carriedItems).toEqual([]);
    const nulled = applyVisualStateChange(withItems, { injuries: null });
    expect(nulled.injuries).toEqual([]);
  });

  it('no-op change returns the same object and does not bump revision', () => {
    const next = applyVisualStateChange(base, { hairState: 'loose and dry' });
    expect(next).toBe(base);
  });

  it('records lastChangedAt when provided', () => {
    const next = applyVisualStateChange(base, { hairState: 'soaked' }, { pageNum: 3, panelIndex: 1 });
    expect(next.lastChangedAt).toEqual({ pageNum: 3, panelIndex: 1 });
  });
});

describe('reducePageStates', () => {
  it('before-panel changes affect the same panel; after-panel affect the next', () => {
    const cont = initializeContinuity([mara]);
    const page = {
      title: 't',
      choices: [],
      panels: [
        panel({
          visual: { characters: [{ characterId: 'char-mara', action: 'walking', pose: '', expression: '' }] },
          visualStateChanges: [
            {
              characterId: 'char-mara',
              timing: 'after-panel',
              reason: 'gets soaked',
              set: { hairState: 'soaked flat' },
            },
          ],
        }),
        panel({
          visual: { characters: [{ characterId: 'char-mara', action: 'shivering', pose: '', expression: '' }] },
        }),
      ],
    };
    const { panelRenderStates, continuityAfter, errors } = reducePageStates(cont, page, 1);
    expect(errors).toEqual([]);
    expect(panelRenderStates[0]['char-mara'].hairState).toBe('loose and dry');
    expect(panelRenderStates[1]['char-mara'].hairState).toBe('soaked flat');
    expect(continuityAfter.characterStates['char-mara'].hairState).toBe('soaked flat');
    expect(continuityAfter.characterStates['char-mara'].revision).toBe(1);
  });

  it('before-panel wardrobe change applies to the current panel', () => {
    const cont = initializeContinuity([mara]);
    const page = {
      title: 't',
      choices: [],
      panels: [
        panel({
          visual: { characters: [{ characterId: 'char-mara', action: '', pose: '', expression: '' }] },
          visualStateChanges: [
            {
              characterId: 'char-mara',
              timing: 'before-panel',
              reason: 'changed',
              set: { wardrobeDescription: 'formal suit' },
            },
          ],
        }),
      ],
    };
    const { panelRenderStates } = reducePageStates(cont, page, 2);
    expect(panelRenderStates[0]['char-mara'].wardrobeDescription).toBe('formal suit');
  });

  it('ignores state changes for characters absent from the ledger and records an error', () => {
    const cont = initializeContinuity([mara]);
    const page = {
      title: 't',
      choices: [],
      panels: [
        panel({
          visualStateChanges: [
            { characterId: 'char-ghost', timing: 'before-panel', reason: 'x', set: { hairState: 'green' } },
          ],
        }),
      ],
    };
    const { continuityAfter, errors } = reducePageStates(cont, page, 1);
    expect(errors.length).toBe(1);
    expect(continuityAfter.characterStates['char-ghost']).toBeUndefined();
  });

  it('tracks the last used stable location ID', () => {
    const cont = initializeContinuity([mara]);
    const page = {
      title: 't',
      choices: [],
      panels: [panel({ visual: { locationId: 'machine-shop' } }), panel({ visual: { locationId: 'main-street' } })],
    };
    expect(reducePageStates(cont, page, 1).continuityAfter.currentLocationId).toBe('main-street');
  });
});

describe('anchor resolution', () => {
  it('resolves the identity anchor strictly by ID, not by index', () => {
    const { image, source } = resolveIdentityAnchorImage(mara);
    expect(image.id).toBe('img-a');
    expect(source).toBe('anchor');
  });

  it('anchor survives reordering and deletion of other images', () => {
    const reordered = { ...mara, images: [mara.images[1], mara.images[0]], primaryImageIndex: 0 };
    expect(resolveIdentityAnchorImage(reordered).image.id).toBe('img-a');
    const deletedOther = { ...mara, images: [mara.images[0]] };
    expect(resolveIdentityAnchorImage(deletedOther).image.id).toBe('img-a');
  });

  it('falls back primary → first when the anchor ID is missing', () => {
    const noAnchor = { ...mara, identityAnchorImageId: 'gone' };
    const res = resolveIdentityAnchorImage(noAnchor);
    expect(res.source).toBe('primary');
    expect(res.image.id).toBe('img-b');
    const none = { ...mara, images: [] };
    expect(resolveIdentityAnchorImage(none)).toEqual({ image: null, source: 'none' });
  });
});

describe('effectiveReferenceBudget', () => {
  it('auto means the live model limit, not always-maximum', () => {
    expect(effectiveReferenceBudget('auto', 10)).toBe(10);
    expect(effectiveReferenceBudget(null, 10)).toBe(10);
  });
  it('user budget is a ceiling capped at the model limit', () => {
    expect(effectiveReferenceBudget(4, 10)).toBe(4);
    expect(effectiveReferenceBudget(20, 10)).toBe(10);
  });
  it('conservative fallback of 1 when metadata is unavailable', () => {
    expect(effectiveReferenceBudget('auto', null)).toBe(1);
  });
});

describe('resolveImageGenerationPlan', () => {
  const seq = (over = {}) => ({
    modelId: SEQUENTIAL_MODEL_ID,
    modelMeta: { maxInputImages: 10, maxOutputImages: 15, sizes: ['1920x1920'] },
    imagePanelCount: 4,
    pageReferenceCount: 5,
    panelReferenceCounts: [2, 2, 3, 2],
    requestedSizes: ['1920x1920'],
    sequentialEnabled: true,
    ...over,
  });

  it('routes an eligible page to one sequential request', () => {
    expect(resolveImageGenerationPlan(seq()).strategy).toBe('sequential-page');
  });

  it('routes independently when page references exceed capacity but panels fit', () => {
    const plan = resolveImageGenerationPlan(seq({ pageReferenceCount: 12 }));
    expect(plan.strategy).toBe('independent-panels');
    expect(plan.blockedPanels).toEqual([]);
  });

  it('routes independently for mixed sizes', () => {
    const plan = resolveImageGenerationPlan(seq({ requestedSizes: ['1920x1920', '1024x1536'] }));
    expect(plan.strategy).toBe('independent-panels');
  });

  it('routes independently for models without a sequence adapter', () => {
    expect(resolveImageGenerationPlan(seq({ modelId: 'seedream-v4.5' })).strategy).toBe('independent-panels');
  });

  it('respects the contract-test gate', () => {
    expect(resolveImageGenerationPlan(seq({ sequentialEnabled: false })).strategy).toBe('independent-panels');
  });

  it('routes independently when output count exceeds the model max', () => {
    const plan = resolveImageGenerationPlan(
      seq({ modelMeta: { maxInputImages: 10, maxOutputImages: 3, sizes: null } }),
    );
    expect(plan.strategy).toBe('independent-panels');
  });

  it('blocks panels whose references exceed capacity', () => {
    const plan = resolveImageGenerationPlan(seq({ panelReferenceCounts: [2, 11, 2, 2] }));
    expect(plan.blockedPanels).toEqual([{ panelIndex: 1, required: 11, capacity: 10 }]);
  });

  it('blocks panels against the companion capacity when panelCapacity differs', () => {
    const plan = resolveImageGenerationPlan(seq({ panelReferenceCounts: [2, 4, 2, 2], panelCapacity: 3 }));
    expect(plan.blockedPanels).toEqual([{ panelIndex: 1, required: 4, capacity: 3 }]);
    // Sequential eligibility still judged against the page model's capacity
    expect(plan.strategy).toBe('sequential-page');
  });

  it('uses conservative 1/1 limits without metadata', () => {
    const plan = resolveImageGenerationPlan(seq({ modelMeta: null }));
    expect(plan.strategy).toBe('independent-panels');
    expect(plan.capacity).toBe(1);
    expect(plan.maxOutputs).toBe(1);
    expect(plan.metadataAvailable).toBe(false);
  });
});

describe('validatePlannedPage', () => {
  it('drops unknown character IDs and state changes without fuzzy matching', () => {
    const page = {
      title: 't',
      choices: [],
      panels: [
        panel({
          visual: {
            locationId: 'nowhere',
            characters: [
              { characterId: 'char-mara', action: '', pose: '', expression: '' },
              { characterId: 'Mara', action: '', pose: '', expression: '' }, // name, not an ID
            ],
          },
          visualStateChanges: [{ characterId: 'char-unknown', timing: 'before-panel', reason: '', set: {} }],
        }),
      ],
    };
    const { page: sanitized, errors } = validatePlannedPage(page, {
      characterIds: ['char-mara'],
      locationIds: ['machine-shop'],
    });
    expect(sanitized.panels[0].visual.characters.map((c) => c.characterId)).toEqual(['char-mara']);
    expect(sanitized.panels[0].visual.locationId).toBeNull();
    expect(sanitized.panels[0].visualStateChanges).toEqual([]);
    expect(errors.length).toBe(3);
  });

  it('keeps structured appearance and filters unknown interaction participants', () => {
    const page = {
      title: 't',
      choices: [],
      panels: [
        panel({
          visual: {
            characters: [
              { characterId: 'char-mara', appearanceState: 'battle-armor', action: '', pose: '', expression: '' },
            ],
            interaction: { participantIds: ['char-mara', 'char-ghost'], type: 'conversation' },
          },
        }),
      ],
    };
    const { page: sanitized, errors } = validatePlannedPage(page, {
      characterIds: ['char-mara'],
      locationIds: [],
    });
    expect(sanitized.panels[0].visual.characters[0].appearanceState).toBe('battle-armor');
    expect(sanitized.panels[0].visual.interaction).toBeNull();
    expect(errors[0]).toContain('unknown interaction participant');
  });
});

describe('prompt compilation', () => {
  const byId = { 'char-mara': mara, 'char-ellis': ellis };
  const manifest = [
    { index: 1, role: 'identity', label: 'char-mara', characterIds: ['char-mara'], imageId: 'img-a' },
    { index: 2, role: 'appearance', label: 'char-mara:battle-armor', characterIds: ['char-mara'], imageId: 'img-b' },
    {
      index: 3,
      role: 'location',
      label: 'machine-shop',
      locationId: 'machine-shop',
      worldId: 'world-1',
      imageId: 'w-1',
    },
    {
      index: 4,
      role: 'interaction',
      label: 'char-ellis+char-mara:conversation',
      characterIds: ['char-mara', 'char-ellis'],
      imageId: 'i-1',
    },
  ];
  const renderState = {
    'char-mara': createCharacterVisualState(mara),
  };
  const p = panel({
    visual: {
      locationId: 'machine-shop',
      environment: 'oil-stained workbenches',
      framing: 'wide',
      cameraElevation: 'eye-level',
      lighting: 'dusty shafts of light',
      characters: [
        {
          characterId: 'char-mara',
          appearanceState: 'battle-armor',
          action: 'tightening a bolt',
          pose: 'crouched',
          expression: 'focused',
        },
      ],
      interaction: { participantIds: ['char-mara', 'char-ellis'], type: 'conversation' },
      keyProps: ['red toolbox'],
    },
  });

  it('reproduces the wardrobe text verbatim and cites reference numbers', () => {
    const desc = compilePanelDescription({ panel: p, renderState, manifest, charactersById: byId });
    expect(desc).toContain('Mara (Reference image 1).');
    expect(desc).toContain('Wardrobe: faded olive coveralls, sleeves rolled to the elbows.');
    expect(desc).toContain('Location: machine-shop (Reference image 3).');
    expect(desc).toContain('Appearance state: battle-armor (Reference image 2).');
    expect(desc).toContain('Interaction: conversation between Mara and Ellis (Reference image 4).');
    expect(desc).toContain('Carrying: red shop rag.');
    expect(desc).toContain('Key props: red toolbox.');
  });

  it('points empty wardrobe at the identity-anchor outfit', () => {
    const emptyState = { 'char-mara': { ...renderState['char-mara'], wardrobeDescription: '' } };
    const desc = compilePanelDescription({ panel: p, renderState: emptyState, manifest, charactersById: byId });
    expect(desc).toContain('Wardrobe: as shown in Reference image 1 (identity anchor outfit).');
  });

  it('marks unanchored characters explicitly and includes appearance text', () => {
    const desc = compilePanelDescription({ panel: p, renderState, manifest: [], charactersById: byId });
    expect(desc).toContain('Mara (no reference image; identity unanchored).');
    expect(desc).toContain('Appearance: tall, wiry, cropped black hair.');
  });

  it('sequential prompt declares the output contract and numbered images', () => {
    const prompt = compileSequentialPagePrompt({
      panels: [p, p],
      renderStates: [renderState, renderState],
      manifest,
      charactersById: byId,
      stylePreset: 'bold ink comic style',
    });
    expect(prompt).toContain('Generate exactly 2 images as one continuous comic-page sequence.');
    expect(prompt).toContain('Return them in the same order as IMAGE 1 through IMAGE 2.');
    expect(prompt).toContain('REFERENCE MAP');
    expect(prompt).toContain('Reference image 1: identity anchor for char-mara.');
    expect(prompt).toContain('Reference image 2: appearance reference for char-mara:battle-armor.');
    expect(prompt).toContain('Reference image 4: interaction reference');
    expect(prompt).toContain('do not copy reference clothing when they differ');
    expect(prompt).toContain('SHARED CONTINUITY');
    expect(prompt).toContain('bold ink comic style');
    expect(prompt).toContain('IMAGE 1\n');
    expect(prompt).toContain('IMAGE 2\n');
    // Wardrobe repeated verbatim in every image description
    const occurrences = prompt.split('Wardrobe: faded olive coveralls, sleeves rolled to the elbows.').length - 1;
    expect(occurrences).toBe(2);
  });

  it('independent prompt shares the same legend and state semantics', () => {
    const prompt = compileIndependentPanelPrompt({
      panel: p,
      renderState,
      manifest,
      charactersById: byId,
      stylePreset: 'bold ink comic style',
    });
    expect(prompt).toContain('Reference image 1: identity anchor for char-mara.');
    expect(prompt).toContain('Wardrobe: faded olive coveralls, sleeves rolled to the elbows.');
    expect(prompt).not.toContain('IMAGE 1');
  });
});

describe('cast collection', () => {
  it('collects unique cast in selected-character order', () => {
    const page = {
      title: 't',
      choices: [],
      panels: [
        panel({ visual: { characters: [{ characterId: 'char-ellis', action: '', pose: '', expression: '' }] } }),
        panel({
          visual: {
            characters: [
              { characterId: 'char-mara', action: '', pose: '', expression: '' },
              { characterId: 'char-ellis', action: '', pose: '', expression: '' },
            ],
          },
        }),
      ],
    };
    expect(collectPageCast(page, ['char-mara', 'char-ellis'])).toEqual(['char-mara', 'char-ellis']);
  });
});

describe('normalizeStateText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeStateText('  a\n  b\t c ')).toBe('a b c');
    expect(normalizeStateText(null)).toBe('');
  });
});
