import { describe, it, expect } from 'vitest';
import {
  SEQUENTIAL_MODEL_ID,
  normalizeStateText,
  createCharacterVisualState,
  initializeContinuity,
  applyVisualStateChange,
  reducePageStates,
  resolveIdentityAnchorImage,
  resolveLocationAnchor,
  collectPageCast,
  collectLocationKeys,
  allocateReferences,
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
    { id: 'img-b', dataUrl: 'data:image/png;base64,BBB', tag: 'alternate-outfit', referenceKey: 'battle-armor' },
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

const world = {
  id: 'world-1',
  name: 'Rustfield',
  images: [
    { id: 'w-1', dataUrl: 'data:image/png;base64,W1', locationKey: 'machine-shop' },
    { id: 'w-2', dataUrl: 'data:image/png;base64,W2', locationKey: 'main-street' },
    { id: 'w-3', dataUrl: 'data:image/png;base64,W3', locationKey: null },
  ],
  primaryImageIndex: 2,
  defaultAnchorImageId: 'w-3',
};

function panel(overrides = {}) {
  return {
    narration: '',
    dialogue: [],
    visual: {
      locationKey: null,
      environment: '',
      shot: 'medium shot',
      composition: '',
      lighting: '',
      colorMood: '',
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

  it('tracks the last used location key', () => {
    const cont = initializeContinuity([mara]);
    const page = {
      title: 't',
      choices: [],
      panels: [panel({ visual: { locationKey: 'machine-shop' } }), panel({ visual: { locationKey: 'main-street' } })],
    };
    expect(reducePageStates(cont, page, 1).continuityAfter.currentLocationKey).toBe('main-street');
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

  it('resolves location anchors by exact key, then default anchor', () => {
    const exact = resolveLocationAnchor(world, 'machine-shop');
    expect(exact.image.id).toBe('w-1');
    expect(exact.usedFallback).toBe(false);
    const fallback = resolveLocationAnchor(world, 'north-rooftop');
    expect(fallback.image.id).toBe('w-3');
    expect(fallback.usedFallback).toBe(true);
  });
});

describe('reference allocation', () => {
  const byId = { 'char-mara': mara, 'char-ellis': ellis };

  it('orders identity anchors by selected-character order, then locations, one-based', () => {
    const alloc = allocateReferences({
      characterIds: ['char-mara', 'char-ellis'],
      charactersById: byId,
      locationKeys: ['machine-shop'],
      world,
      budget: 10,
    });
    expect(alloc.error).toBeUndefined();
    expect(alloc.manifest.map((m) => [m.index, m.role, m.label])).toEqual([
      [1, 'identity', 'Mara'],
      [2, 'identity', 'Ellis'],
      [3, 'location', 'machine-shop'],
    ]);
    expect(alloc.dataUrls.length).toBe(3);
    expect(alloc.manifest[0].imageId).toBe('img-a');
  });

  it('never uses embeddings — selection is by explicit ID only', () => {
    // A high-similarity embedding on the alternate outfit must not win
    const tempting = {
      ...mara,
      images: [
        { ...mara.images[0], embedding: null },
        { ...mara.images[1], embedding: [1, 1, 1] },
      ],
    };
    const alloc = allocateReferences({
      characterIds: ['char-mara'],
      charactersById: { 'char-mara': tempting },
      locationKeys: [],
      world: null,
      budget: 10,
    });
    expect(alloc.manifest[0].imageId).toBe('img-a');
  });

  it('adds the previous frame only when budget remains', () => {
    const prev = { dataUrl: 'data:image/png;base64,PREV', sourcePageId: 'p1', sourcePanelIndex: 3 };
    const roomy = allocateReferences({
      characterIds: ['char-mara'],
      charactersById: byId,
      locationKeys: [],
      world: null,
      budget: 2,
      previousFrame: prev,
    });
    expect(roomy.manifest.map((m) => m.role)).toEqual(['identity', 'previous-frame']);
    const tight = allocateReferences({
      characterIds: ['char-mara', 'char-ellis'],
      charactersById: byId,
      locationKeys: [],
      world: null,
      budget: 2,
      previousFrame: prev,
    });
    expect(tight.manifest.map((m) => m.role)).toEqual(['identity', 'identity']);
  });

  it('returns an explicit capacity error instead of silently dropping anchors', () => {
    const alloc = allocateReferences({
      characterIds: ['char-mara', 'char-ellis'],
      charactersById: byId,
      locationKeys: ['machine-shop'],
      world,
      budget: 2,
    });
    expect(alloc.error).toBeDefined();
    expect(alloc.error.required).toBe(3);
    expect(alloc.manifest).toEqual([]);
  });

  it("prefers the comic ledger's recorded anchor over the character's current anchor", () => {
    // User changed the character's anchor to img-b after the comic started;
    // the ledger still records img-a as this comic's explicit choice
    const changed = { ...mara, identityAnchorImageId: 'img-b' };
    const alloc = allocateReferences({
      characterIds: ['char-mara'],
      charactersById: { 'char-mara': changed },
      locationKeys: [],
      world: null,
      budget: 5,
      anchorImageIdByCharacter: { 'char-mara': 'img-a' },
    });
    expect(alloc.manifest[0].imageId).toBe('img-a');
  });

  it('falls back to the current anchor when the recorded ledger anchor was deleted', () => {
    const alloc = allocateReferences({
      characterIds: ['char-mara'],
      charactersById: byId,
      locationKeys: [],
      world: null,
      budget: 5,
      anchorImageIdByCharacter: { 'char-mara': 'deleted-image-id' },
    });
    expect(alloc.manifest[0].imageId).toBe('img-a');
    expect(alloc.warnings.some((w) => w.includes('recorded identity anchor no longer exists'))).toBe(true);
  });

  it('marks location fallback references in the manifest', () => {
    const alloc = allocateReferences({
      characterIds: [],
      charactersById: {},
      locationKeys: ['north-rooftop'],
      world,
      budget: 5,
    });
    expect(alloc.manifest[0].role).toBe('location');
    expect(alloc.manifest[0].fallback).toBe(true);
  });

  it('marks characters with no valid image as unanchored, not as errors', () => {
    const bare = { id: 'char-bare', name: 'Bare', images: [] };
    const alloc = allocateReferences({
      characterIds: ['char-bare'],
      charactersById: { 'char-bare': bare },
      locationKeys: [],
      world: null,
      budget: 5,
    });
    expect(alloc.error).toBeUndefined();
    expect(alloc.unanchoredCharacterIds).toEqual(['char-bare']);
    expect(alloc.manifest).toEqual([]);
  });

  it('allocates a requested character variant after its identity anchor', () => {
    const alloc = allocateReferences({
      characterIds: ['char-mara'],
      characterReferences: [{ characterId: 'char-mara', referenceKey: 'battle-armor' }],
      charactersById: byId,
      locationKeys: [],
      budget: 5,
    });
    expect(alloc.manifest.map((item) => [item.role, item.imageId])).toEqual([
      ['identity', 'img-a'],
      ['variant', 'img-b'],
    ]);
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
            locationKey: 'nowhere',
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
      locationKeys: ['machine-shop'],
    });
    expect(sanitized.panels[0].visual.characters.map((c) => c.characterId)).toEqual(['char-mara']);
    expect(sanitized.panels[0].visual.locationKey).toBeNull();
    expect(sanitized.panels[0].visualStateChanges).toEqual([]);
    expect(errors.length).toBe(3);
  });

  it('keeps known reference keys and clears unknown ones', () => {
    const page = {
      title: 't',
      choices: [],
      panels: [
        panel({
          visual: {
            characters: [
              { characterId: 'char-mara', referenceKey: 'battle-armor', action: '', pose: '', expression: '' },
              { characterId: 'char-mara', referenceKey: 'invented-look', action: '', pose: '', expression: '' },
            ],
          },
        }),
      ],
    };
    const { page: sanitized, errors } = validatePlannedPage(page, {
      characterIds: ['char-mara'],
      locationKeys: [],
      referenceKeysByCharacter: { 'char-mara': ['battle-armor'] },
    });
    expect(sanitized.panels[0].visual.characters.map((c) => c.referenceKey)).toEqual(['battle-armor', null]);
    expect(errors[0]).toContain('unknown reference key');
  });
});

describe('prompt compilation', () => {
  const byId = { 'char-mara': mara, 'char-ellis': ellis };
  const manifest = [
    { index: 1, role: 'identity', label: 'Mara', characterId: 'char-mara', imageId: 'img-a' },
    { index: 2, role: 'location', label: 'machine-shop', worldId: 'world-1', imageId: 'w-1' },
  ];
  const renderState = {
    'char-mara': createCharacterVisualState(mara),
  };
  const p = panel({
    visual: {
      locationKey: 'machine-shop',
      environment: 'oil-stained workbenches',
      shot: 'wide shot',
      lighting: 'dusty shafts of light',
      characters: [{ characterId: 'char-mara', action: 'tightening a bolt', pose: 'crouched', expression: 'focused' }],
      keyProps: ['red toolbox'],
    },
  });

  it('reproduces the wardrobe text verbatim and cites reference numbers', () => {
    const desc = compilePanelDescription({ panel: p, renderState, manifest, charactersById: byId });
    expect(desc).toContain('Mara (Reference image 1).');
    expect(desc).toContain('Wardrobe: faded olive coveralls, sleeves rolled to the elbows.');
    expect(desc).toContain('Location: machine-shop (Reference image 2).');
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
    expect(prompt).toContain('Reference image 1: identity anchor for Mara.');
    expect(prompt).toContain('do not copy reference clothing when they differ');
    expect(prompt).toContain('SHARED CONTINUITY');
    expect(prompt).toContain('bold ink comic style');
    expect(prompt).toContain('IMAGE 1\n');
    expect(prompt).toContain('IMAGE 2\n');
    // Wardrobe repeated verbatim in every image description
    const occurrences = prompt.split('Wardrobe: faded olive coveralls, sleeves rolled to the elbows.').length - 1;
    expect(occurrences).toBe(2);
  });

  it('annotates fallback location references honestly in the reference map', () => {
    const fallbackManifest = [
      { index: 1, role: 'location', label: 'north-rooftop', worldId: 'world-1', imageId: 'w-3', fallback: true },
    ];
    const prompt = compileIndependentPanelPrompt({
      panel: p,
      renderState,
      manifest: fallbackManifest,
      charactersById: byId,
    });
    expect(prompt).toContain('standing in for "north-rooftop"');
    expect(prompt).not.toContain('location anchor for north-rooftop.');
  });

  it('independent prompt shares the same legend and state semantics', () => {
    const prompt = compileIndependentPanelPrompt({
      panel: p,
      renderState,
      manifest,
      charactersById: byId,
      stylePreset: 'bold ink comic style',
    });
    expect(prompt).toContain('Reference image 1: identity anchor for Mara.');
    expect(prompt).toContain('Wardrobe: faded olive coveralls, sleeves rolled to the elbows.');
    expect(prompt).not.toContain('IMAGE 1');
  });
});

describe('cast/location collection', () => {
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

  it('collects location keys in first-use order', () => {
    const panels = [
      panel({ visual: { locationKey: 'main-street' } }),
      panel({ visual: { locationKey: 'machine-shop' } }),
      panel({ visual: { locationKey: 'main-street' } }),
    ];
    expect(collectLocationKeys(panels)).toEqual(['main-street', 'machine-shop']);
  });
});

describe('normalizeStateText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeStateText('  a\n  b\t c ')).toBe('a b c');
    expect(normalizeStateText(null)).toBe('');
  });
});
