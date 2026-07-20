import { describe, expect, it } from 'vitest';
import { buildContinuityGenerationPlan } from '../src/js/generation/continuity/build-plan.js';
import type { ContinuityPlanningInput } from '../src/js/generation/continuity/types.js';
import {
  SEQUENTIAL_MODEL_ID,
  allocateReferences,
  compileIndependentPanelPrompt,
  compilePanelDescription,
  compileSequentialPagePrompt,
  createCharacterVisualState,
} from '../src/js/visual-continuity.js';

const mara = {
  id: 'char-mara',
  name: 'Mara',
  appearance: 'tall, wiry, cropped black hair',
  images: [{ id: 'img-mara', dataUrl: 'data:image/png;base64,MARA', tag: 'default' }],
  primaryImageIndex: 0,
  identityAnchorImageId: 'img-mara',
  defaultVisualState: {
    wardrobeDescription: 'olive coveralls',
    hairState: 'cropped and dry',
    carriedItems: ['red shop rag'],
  },
};

const ellis = {
  id: 'char-ellis',
  name: 'Ellis',
  images: [{ id: 'img-ellis', dataUrl: 'data:image/png;base64,ELLIS', tag: 'default' }],
  primaryImageIndex: 0,
  identityAnchorImageId: 'img-ellis',
};

const world = {
  id: 'world-rustfield',
  name: 'Rustfield',
  images: [{ id: 'img-shop', dataUrl: 'data:image/png;base64,SHOP', locationKey: 'machine-shop' }],
  primaryImageIndex: 0,
  defaultAnchorImageId: 'img-shop',
};

function panel(index: number, characterIds = ['char-mara']) {
  return {
    narration: '',
    dialogue: [],
    visual: {
      locationKey: 'machine-shop',
      environment: `workbench row ${index + 1}`,
      shot: 'medium shot',
      composition: 'subject centered',
      lighting: 'dusty shafts of light',
      colorMood: 'warm rust',
      characters: characterIds.map((characterId) => ({
        characterId,
        action: `works at station ${index + 1}`,
        pose: 'crouched',
        expression: 'focused',
      })),
      keyProps: ['red toolbox'],
    },
    visualStateChanges: [],
  };
}

function planningInput(overrides: Partial<ContinuityPlanningInput> = {}): ContinuityPlanningInput {
  const panels = [panel(0), panel(1), panel(2), panel(3)];
  const maraState = createCharacterVisualState(mara);
  return {
    pageModelId: SEQUENTIAL_MODEL_ID,
    pageModel: { maxInputImages: 10, maxOutputImages: 15, sizes: ['1920x1920'], provider: 'opaque' },
    companionModelId: 'seedream-v4.5',
    companionModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
    imageSize: '1920x1920',
    sequentialEnabled: true,
    panels,
    renderStates: panels.map(() => ({ 'char-mara': maraState })),
    charactersById: { 'char-mara': mara, 'char-ellis': ellis },
    selectedCharacterIds: ['char-mara', 'char-ellis'],
    world,
    referenceBudget: 'auto',
    useReferenceImages: true,
    anchorImageIdByCharacter: { 'char-mara': 'img-mara', 'char-ellis': 'img-ellis' },
    stylePreset: 'inked dieselpunk comic',
    negativePrompt: 'photorealism',
    warnings: [],
    ...overrides,
  };
}

describe('buildContinuityGenerationPlan', () => {
  it('builds one stable page-sequence request for an eligible four-panel page', () => {
    const plan = buildContinuityGenerationPlan(planningInput());

    expect(plan.strategy).toBe('sequential-page');
    expect(plan.pageModelId).toBe(SEQUENTIAL_MODEL_ID);
    expect(plan.effectiveModelId).toBe(SEQUENTIAL_MODEL_ID);
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).toMatchObject({
      id: 'page-sequence',
      panelIndexes: [0, 1, 2, 3],
      modelId: SEQUENTIAL_MODEL_ID,
      expectedImageCount: 4,
      negativePrompt: 'photorealism',
    });
    expect(plan.requests[0].prompt).toBe(plan.compiledPrompts[0]);
    expect(plan.requests[0].imageDataUrls).toEqual(['data:image/png;base64,MARA', 'data:image/png;base64,SHOP']);
  });

  it('builds independent requests in panel order with stable one-based ids', () => {
    const input = planningInput({
      pageModelId: 'independent-model',
      pageModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
      companionModelId: 'independent-model',
      companionModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
    });

    const plan = buildContinuityGenerationPlan(input);

    expect(plan.strategy).toBe('independent-panels');
    expect(plan.effectiveModelId).toBe('independent-model');
    expect(
      plan.requests.map(({ id, panelIndexes, expectedImageCount }) => ({ id, panelIndexes, expectedImageCount })),
    ).toEqual([
      { id: 'panel-1', panelIndexes: [0], expectedImageCount: 1 },
      { id: 'panel-2', panelIndexes: [1], expectedImageCount: 1 },
      { id: 'panel-3', panelIndexes: [2], expectedImageCount: 1 },
      { id: 'panel-4', panelIndexes: [3], expectedImageCount: 1 },
    ]);
    expect(plan.requests.every((request) => request.modelId === 'independent-model')).toBe(true);
  });

  it('filters targeted retries in panel order and disables sequential routing', () => {
    const plan = buildContinuityGenerationPlan(planningInput({ targetPanelIndexes: [3, 1] }));

    expect(plan.strategy).toBe('independent-panels');
    expect(plan.requests.map((request) => request.id)).toEqual(['panel-2', 'panel-4']);
    expect(plan.requests.map((request) => request.panelIndexes)).toEqual([[1], [3]]);
    expect(plan.panelPrompts.map((prompt) => prompt !== null)).toEqual([false, true, false, true]);
    expect(plan.warnings).toContain('Sequential page generation is disabled (output-order contract test gate)');
  });

  it('omits allocation-error and blocked panels from independent requests', () => {
    const panels = [panel(0, ['char-mara', 'char-ellis']), panel(1, ['char-mara'])];
    const plan = buildContinuityGenerationPlan(
      planningInput({
        pageModelId: 'capacity-one-model',
        pageModel: { maxInputImages: 1, maxOutputImages: 1, sizes: ['1920x1920'] },
        companionModelId: 'capacity-one-model',
        companionModel: { maxInputImages: 1, maxOutputImages: 1, sizes: ['1920x1920'] },
        panels,
        renderStates: [
          {
            'char-mara': createCharacterVisualState(mara),
            'char-ellis': createCharacterVisualState(ellis),
          },
          { 'char-mara': createCharacterVisualState(mara) },
        ],
        world: null,
        referenceBudget: 1,
      }),
    );

    expect(plan.blockedPanels).toEqual([{ panelIndex: 0, required: 2, capacity: 1 }]);
    expect(plan.requests.map((request) => request.id)).toEqual(['panel-2']);
    expect(plan.panelPrompts[0]).toBeNull();
    expect(plan.warnings).toEqual([
      'Selected model has no verified sequence adapter',
      'Panel 1: This request needs 2 mandatory reference image(s) (2 character identities, 1 location(s)) but only 1 fit.',
    ]);
  });

  it('reuses page capabilities when the same-model companion metadata is null', () => {
    const plan = buildContinuityGenerationPlan(
      planningInput({
        pageModelId: 'independent-model',
        pageModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
        companionModelId: 'independent-model',
        companionModel: null,
      }),
    );

    expect(plan.requests.map((request) => request.id)).toEqual(['panel-1', 'panel-2', 'panel-3', 'panel-4']);
    expect(plan.blockedPanels).toEqual([]);
  });

  it('preserves helper prompt, manifest, and warning ordering contracts', () => {
    const input = planningInput({
      anchorImageIdByCharacter: { 'char-mara': 'deleted-anchor' },
      warnings: ['preflight warning'],
    });
    const plan = buildContinuityGenerationPlan(input);
    const expectedAllocation = allocateReferences({
      characterIds: ['char-mara'],
      charactersById: input.charactersById,
      locationKeys: ['machine-shop'],
      world: input.world,
      budget: 10,
      previousFrame: input.previousFrame,
      anchorImageIdByCharacter: input.anchorImageIdByCharacter,
    });

    expect(plan.referenceManifest).toEqual(expectedAllocation.manifest);
    expect(plan.panelPrompts).toEqual(
      input.panels.map((plannedPanel, index) =>
        compilePanelDescription({
          panel: plannedPanel,
          renderState: input.renderStates[index] || {},
          manifest: expectedAllocation.manifest,
          charactersById: input.charactersById,
        }),
      ),
    );
    expect(plan.compiledPrompts).toEqual([
      compileSequentialPagePrompt({
        panels: input.panels,
        renderStates: input.renderStates,
        manifest: expectedAllocation.manifest,
        charactersById: input.charactersById,
        stylePreset: input.stylePreset,
      }),
    ]);
    expect(plan.warnings).toEqual(['preflight warning', ...expectedAllocation.warnings]);
  });

  it('uses the existing independent prompt compiler for each request', () => {
    const input = planningInput({
      pageModelId: 'independent-model',
      pageModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
      companionModelId: 'independent-model',
      companionModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
    });
    const plan = buildContinuityGenerationPlan(input);

    plan.requests.forEach((request, requestIndex) => {
      const panelIndex = request.panelIndexes[0];
      const expectedAllocation = allocateReferences({
        characterIds: ['char-mara'],
        charactersById: input.charactersById,
        locationKeys: ['machine-shop'],
        world: input.world,
        budget: 10,
        previousFrame: input.previousFrame,
        anchorImageIdByCharacter: input.anchorImageIdByCharacter,
      });
      expect(request.prompt).toBe(
        compileIndependentPanelPrompt({
          panel: input.panels[panelIndex],
          renderState: input.renderStates[panelIndex] || {},
          manifest: expectedAllocation.manifest,
          charactersById: input.charactersById,
          stylePreset: input.stylePreset,
        }),
      );
      expect(request.prompt).toBe(plan.compiledPrompts[requestIndex]);
    });
  });
});
