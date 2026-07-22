import { describe, expect, it, vi } from 'vitest';
import { applyContinuityResult } from '../src/js/generation/continuity/apply-results.js';
import { buildContinuityGenerationPlan } from '../src/js/generation/continuity/build-plan.js';
import { executeIndependentPlan } from '../src/js/generation/continuity/execute-independent.js';
import { executeSequentialPlan } from '../src/js/generation/continuity/execute-sequential.js';
import {
  runContinuityGeneration,
  type ContinuityExecutionDependencies,
  type ContinuityPageData,
} from '../src/js/generation/continuity/orchestrator.js';
import type { ContinuityPlanningInput } from '../src/js/generation/continuity/types.js';
import type { ReferenceAsset } from '../src/js/references/types.js';
import { resolvePanelReferences } from '../src/js/references/resolver.js';
import {
  SEQUENTIAL_MODEL_ID,
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
};

function referenceAsset(overrides: Partial<ReferenceAsset> & Pick<ReferenceAsset, 'id' | 'dataUrl'>): ReferenceAsset {
  return {
    worldId: world.id,
    subjectType: 'character',
    use: 'identity',
    characterIds: [],
    locationId: null,
    facets: {},
    description: '',
    confidence: {},
    provenance: { source: 'generated', metadata: 'accepted' },
    classificationState: 'ready',
    acceptedAsIs: true,
    autoUse: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const referenceAssets: ReferenceAsset[] = [
  referenceAsset({ id: 'img-mara', dataUrl: 'data:image/png;base64,MARA', characterIds: ['char-mara'] }),
  referenceAsset({ id: 'img-ellis', dataUrl: 'data:image/png;base64,ELLIS', characterIds: ['char-ellis'] }),
  referenceAsset({
    id: 'img-mara-armor',
    dataUrl: 'data:image/png;base64,ARMOR',
    use: 'appearance',
    characterIds: ['char-mara'],
    facets: { appearanceState: 'red-coat' },
  }),
  referenceAsset({
    id: 'img-shop',
    dataUrl: 'data:image/png;base64,SHOP',
    subjectType: 'location',
    use: 'spatial',
    locationId: 'machine-shop',
  }),
  referenceAsset({
    id: 'img-conversation',
    dataUrl: 'data:image/png;base64,TALK',
    subjectType: 'interaction',
    use: 'relationship',
    characterIds: ['char-mara', 'char-ellis'],
    facets: { interactionType: 'conversation' },
  }),
];

function panel(index: number, characterIds = ['char-mara']) {
  return {
    narration: '',
    dialogue: [],
    visual: {
      locationId: 'machine-shop',
      environment: `workbench row ${index + 1}`,
      framing: 'medium',
      cameraElevation: 'eye-level',
      lighting: 'dusty shafts of light',
      characters: characterIds.map((characterId) => ({
        characterId,
        ...(characterId === 'char-mara' ? { appearanceState: 'red-coat' } : {}),
        action: `works at station ${index + 1}`,
        pose: 'crouched',
        expression: 'focused',
      })),
      interaction: characterIds.includes('char-ellis')
        ? { participantIds: ['char-mara', 'char-ellis'], type: 'conversation' }
        : null,
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
    worldId: world.id,
    referenceAssets,
    referenceBudget: 'auto',
    useReferenceImages: true,
    stylePreset: 'inked dieselpunk comic',
    negativePrompt: 'photorealism',
    warnings: [],
    ...overrides,
  };
}

function pageFixture(panelCount: number): ContinuityPageData {
  return {
    panels: Array.from({ length: panelCount }, () => ({})),
  };
}

function executionDependencies(
  overrides: Partial<ContinuityExecutionDependencies> = {},
): ContinuityExecutionDependencies {
  return {
    generateImages: vi.fn(async (_prompt, options) =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        value: `image-${index}`,
        source: 'b64_json' as const,
      })),
    ),
    persistImage: vi.fn(async (value) => ({ value: `data:${value}`, persisted: true })),
    startProgress: vi.fn(),
    enterStage: vi.fn(),
    updateRequest: vi.fn(),
    reportApiProgress: vi.fn(),
    setStatus: vi.fn(),
    signal: undefined,
    toast: vi.fn(),
    logError: vi.fn(),
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
    expect(plan.requests[0].imageDataUrls).toEqual([
      'data:image/png;base64,MARA',
      'data:image/png;base64,ARMOR',
      'data:image/png;base64,SHOP',
    ]);
    expect(plan.referenceManifest.map((item) => item.role)).toEqual(['identity', 'appearance', 'location']);
    expect(plan.referenceManifest.some((item) => 'referenceKey' in item)).toBe(false);
  });

  it('includes an exact interaction reference for a structured panel request', () => {
    const panels = [panel(0, ['char-mara', 'char-ellis']), panel(1)];
    const plan = buildContinuityGenerationPlan(
      planningInput({
        panels,
        renderStates: [
          { 'char-mara': createCharacterVisualState(mara), 'char-ellis': createCharacterVisualState(ellis) },
          { 'char-mara': createCharacterVisualState(mara) },
        ],
      }),
    );

    expect(plan.referenceManifest.map((item) => item.role)).toContain('interaction');
    expect(plan.referenceManifest.some((item) => 'referenceKey' in item)).toBe(false);
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

  it('conservatively rejects malformed non-empty provider size lists', () => {
    const plan = buildContinuityGenerationPlan(
      planningInput({
        pageModel: { maxInputImages: 10, maxOutputImages: 15, sizes: [42] },
      }),
    );

    expect(plan.strategy).toBe('independent-panels');
    expect(plan.warnings[0]).toBe(
      `Size 1920x1920 is not in ${SEQUENTIAL_MODEL_ID}'s supported resolution list — sequential batching skipped`,
    );
  });

  it('omits allocation-error and blocked panels from independent requests', () => {
    const panels = [panel(0, ['char-mara', 'char-ellis']), panel(1, ['char-mara'])];
    const plan = buildContinuityGenerationPlan(
      planningInput({
        pageModelId: 'capacity-three-model',
        pageModel: { maxInputImages: 3, maxOutputImages: 1, sizes: ['1920x1920'] },
        companionModelId: 'capacity-three-model',
        companionModel: { maxInputImages: 3, maxOutputImages: 1, sizes: ['1920x1920'] },
        panels,
        renderStates: [
          {
            'char-mara': createCharacterVisualState(mara),
            'char-ellis': createCharacterVisualState(ellis),
          },
          { 'char-mara': createCharacterVisualState(mara) },
        ],
        referenceBudget: 3,
      }),
    );

    expect(plan.blockedPanels).toEqual([{ panelIndex: 0, required: 5, capacity: 3 }]);
    expect(plan.requests.map((request) => request.id)).toEqual(['panel-2']);
    expect(plan.panelPrompts[0]).toBeNull();
    expect(plan.warnings).toEqual([
      'Selected model has no verified sequence adapter',
      'Panel 1: This panel needs 5 mandatory reference image(s), but only 3 fit.',
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
      warnings: ['preflight warning'],
    });
    const plan = buildContinuityGenerationPlan(input);
    const expectedAllocation = resolvePanelReferences({
      request: {
        worldId: world.id,
        characterIds: ['char-mara'],
        locationId: 'machine-shop',
        characterStates: { 'char-mara': 'red-coat' },
        interaction: null,
        facets: { framing: 'medium', cameraElevation: 'eye-level', lighting: 'dusty shafts of light' },
        propNames: ['red toolbox'],
      },
      assets: referenceAssets,
      budget: 10,
      previousFrame: input.previousFrame,
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
      const expectedAllocation = resolvePanelReferences({
        request: {
          worldId: world.id,
          characterIds: ['char-mara'],
          locationId: 'machine-shop',
          characterStates: { 'char-mara': 'red-coat' },
          interaction: null,
          facets: { framing: 'medium', cameraElevation: 'eye-level', lighting: 'dusty shafts of light' },
          propNames: ['red toolbox'],
        },
        assets: referenceAssets,
        budget: 10,
        previousFrame: input.previousFrame,
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

describe('executeSequentialPlan', () => {
  it('maps persisted images by provider result index without mutating page data', async () => {
    const input = planningInput({
      panels: [panel(0), panel(1)],
      renderStates: planningInput().renderStates.slice(0, 2),
    });
    const plan = buildContinuityGenerationPlan(input);
    expect(plan.strategy).toBe('sequential-page');
    const pageData = pageFixture(2);
    const before = structuredClone(pageData);
    const dependencies = executionDependencies({
      generateImages: vi.fn(async () => [
        { index: 1, value: 'second', source: 'url' },
        { index: 0, value: 'first', source: 'b64_json' },
      ]),
      persistImage: vi.fn(async (value) => ({ value: `saved:${value}`, persisted: true })),
    });

    const result = await executeSequentialPlan(plan, dependencies);

    expect(pageData).toEqual(before);
    expect(result.panelResults).toEqual([
      { panelIndex: 1, imageUrl: 'saved:second' },
      { panelIndex: 0, imageUrl: 'saved:first' },
    ]);
    expect(dependencies.generateImages).toHaveBeenCalledWith(
      plan.requests[0].prompt,
      expect.objectContaining({
        count: 2,
        model: plan.pageModelId,
        resolution: plan.imageSize,
        exactReferences: true,
        refMaxDimension: 2048,
        requestId: 'page-sequence',
        negativePrompt: 'photorealism',
      }),
    );

    applyContinuityResult(pageData, plan, result, 1234);
    expect(pageData.panels.map(({ imageUrl }) => imageUrl)).toEqual(['saved:first', 'saved:second']);
    expect(pageData.generation?.generatedAt).toBe(1234);
  });

  it('reports a short response and marks only still-empty panels after application', async () => {
    const input = planningInput({
      panels: [panel(0), panel(1), panel(2)],
      renderStates: planningInput().renderStates.slice(0, 3),
    });
    const plan = buildContinuityGenerationPlan(input);
    const pageData = pageFixture(3);
    pageData.panels[2].imageUrl = 'existing-third';
    const dependencies = executionDependencies({
      generateImages: vi.fn(async () => [{ index: 0, value: 'first', source: 'b64_json' }]),
    });

    const result = await executeSequentialPlan(plan, dependencies);
    applyContinuityResult(pageData, plan, result, 2000);

    expect(result.warnings).toContain('Model returned 1 of 3 images — missing panels were left empty');
    expect(pageData.panels[1].generationError).toBe('The page sequence did not return an image for this panel.');
    expect(pageData.panels[2].generationError).toBeUndefined();
    expect(dependencies.toast).toHaveBeenCalledWith('Only 1 of 3 panel images were returned', 'error');
  });

  it('returns persistence warnings for result application', async () => {
    const input = planningInput({
      panels: [panel(0), panel(1)],
      renderStates: planningInput().renderStates.slice(0, 2),
    });
    const plan = buildContinuityGenerationPlan(input);
    const dependencies = executionDependencies({
      persistImage: vi.fn(async (value) => ({
        value,
        persisted: false,
        warning: 'A returned image could not be saved locally; its temporary URL may expire.',
      })),
    });

    const result = await executeSequentialPlan(plan, dependencies);

    expect(result.warnings).toEqual([
      'A returned image could not be saved locally; its temporary URL may expire.',
      'A returned image could not be saved locally; its temporary URL may expire.',
    ]);
  });

  it('converts non-abort request failures into safe panel failures', async () => {
    const input = planningInput({
      panels: [panel(0), panel(1)],
      renderStates: planningInput().renderStates.slice(0, 2),
    });
    const plan = buildContinuityGenerationPlan(input);
    const dependencies = executionDependencies({
      generateImages: vi.fn(async () => {
        const error = new Error('provider details');
        Object.assign(error, { safeMessage: 'Provider is unavailable', status: 503 });
        throw error;
      }),
    });

    const result = await executeSequentialPlan(plan, dependencies);

    expect(result.panelResults).toEqual([
      { panelIndex: 0, generationError: 'Provider is unavailable', onlyIfEmpty: true },
      { panelIndex: 1, generationError: 'Provider is unavailable', onlyIfEmpty: true },
    ]);
    expect(result.warnings).toEqual(['Provider is unavailable']);
    expect(dependencies.updateRequest).toHaveBeenCalledWith(
      'page-sequence',
      expect.objectContaining({ state: 'failed', failure: expect.objectContaining({ status: 503 }) }),
    );
  });

  it('propagates AbortError without converting it to a safe failure', async () => {
    const plan = buildContinuityGenerationPlan(planningInput());
    const abortError = Object.preventExtensions(new DOMException('Aborted', 'AbortError'));
    const dependencies = executionDependencies({
      generateImages: vi.fn(async () => {
        throw abortError;
      }),
    });

    await expect(executeSequentialPlan(plan, dependencies)).rejects.toBe(abortError);
    expect(dependencies.updateRequest).not.toHaveBeenCalledWith(
      'page-sequence',
      expect.objectContaining({ state: 'failed' }),
    );
  });
});

describe('executeIndependentPlan', () => {
  function independentPlan(overrides: Partial<ContinuityPlanningInput> = {}) {
    return buildContinuityGenerationPlan(
      planningInput({
        pageModelId: 'independent-model',
        pageModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
        companionModelId: 'independent-model',
        companionModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
        ...overrides,
      }),
    );
  }

  it('settles panel requests independently and returns successes and safe failures', async () => {
    const plan = independentPlan({
      panels: [panel(0), panel(1), panel(2)],
      renderStates: planningInput().renderStates.slice(0, 3),
    });
    const pageData = pageFixture(3);
    const before = structuredClone(pageData);
    const dispatchOrder: string[] = [];
    const dependencies = executionDependencies({
      generateImages: vi.fn(async (_prompt, options) => {
        dispatchOrder.push(options.requestId || '');
        if (options.requestId === 'panel-2') throw new Error('second failed');
        return [{ index: 0, value: options.requestId || '', source: 'b64_json' }];
      }),
    });

    const result = await executeIndependentPlan(plan, dependencies);

    expect(dispatchOrder).toEqual(['panel-1', 'panel-2', 'panel-3']);
    expect(pageData).toEqual(before);
    applyContinuityResult(pageData, plan, result, 3000);
    expect(pageData.panels[0].imageUrl).toBe('data:panel-1');
    expect(pageData.panels[1].generationError).toBe('second failed');
    expect(pageData.panels[2].imageUrl).toBe('data:panel-3');
    expect(dependencies.logError).toHaveBeenCalledWith('Panel image generation (continuity)', expect.any(Error));
    expect(dependencies.toast).toHaveBeenCalledWith('Panel 2 image failed: second failed', 'error');
  });

  it('converts an empty provider response into a safe panel failure', async () => {
    const plan = independentPlan({
      panels: [panel(0)],
      renderStates: planningInput().renderStates.slice(0, 1),
    });
    const dependencies = executionDependencies({
      generateImages: vi.fn(async () => []),
    });

    const result = await executeIndependentPlan(plan, dependencies);

    expect(result.panelResults).toEqual([
      {
        panelIndex: 0,
        generationError: 'The image provider returned no image for this panel.',
      },
    ]);
    expect(dependencies.persistImage).not.toHaveBeenCalled();
    expect(dependencies.updateRequest).toHaveBeenCalledWith(
      'panel-1',
      expect.objectContaining({
        state: 'failed',
        failure: expect.objectContaining({
          message: 'The image provider returned no image for this panel.',
        }),
      }),
    );
    expect(dependencies.toast).toHaveBeenCalledWith(
      'Panel 1 image failed: The image provider returned no image for this panel.',
      'error',
    );
  });

  it('preserves allocation failures while executing the remaining requests', async () => {
    const panels = [panel(0, ['char-mara', 'char-ellis']), panel(1, ['char-mara'])];
    const plan = independentPlan({
      pageModelId: 'capacity-three-model',
      pageModel: { maxInputImages: 3, maxOutputImages: 1, sizes: ['1920x1920'] },
      companionModelId: 'capacity-three-model',
      companionModel: { maxInputImages: 3, maxOutputImages: 1, sizes: ['1920x1920'] },
      panels,
      renderStates: [
        { 'char-mara': createCharacterVisualState(mara), 'char-ellis': createCharacterVisualState(ellis) },
        { 'char-mara': createCharacterVisualState(mara) },
      ],
      world: null,
      referenceBudget: 3,
      warnings: ['Panel 1: unrelated preflight warning'],
    });
    const pageData = pageFixture(2);
    const dependencies = executionDependencies();

    const result = await executeIndependentPlan(plan, dependencies);
    applyContinuityResult(pageData, plan, result, 4000);

    expect(plan.allocationFailures).toEqual([
      {
        panelIndex: 0,
        detail: 'This panel needs 5 mandatory reference image(s), but only 3 fit.',
      },
    ]);
    expect(dependencies.generateImages).toHaveBeenCalledTimes(1);
    expect(pageData.panels[0].generationError).toBe('This panel needs 5 mandatory reference image(s), but only 3 fit.');
    expect(pageData.panels[1].imageUrl).toBe('data:image-0');
  });

  it('updates only requested panels during a targeted retry', async () => {
    const plan = buildContinuityGenerationPlan(planningInput({ targetPanelIndexes: [3, 1] }));
    const pageData = pageFixture(4);
    pageData.panels.forEach((pagePanel, index) => {
      pagePanel.imageUrl = `old-${index}`;
      pagePanel.generationError = `old-error-${index}`;
    });
    const dependencies = executionDependencies({
      generateImages: vi.fn(async (_prompt, options) => [
        { index: 0, value: `new-${options.requestId}`, source: 'b64_json' },
      ]),
    });

    const result = await executeIndependentPlan(plan, dependencies);
    applyContinuityResult(pageData, plan, result, 5000);

    expect(pageData.panels.map(({ imageUrl }) => imageUrl)).toEqual([
      'old-0',
      'data:new-panel-2',
      'old-2',
      'data:new-panel-4',
    ]);
    expect(pageData.panels.map(({ generationError }) => generationError)).toEqual([
      'old-error-0',
      undefined,
      'old-error-2',
      undefined,
    ]);
    expect(dependencies.setStatus).toHaveBeenCalledWith('Generating images (0 / 2)...');
  });

  it('waits for concurrent settlements and then propagates AbortError', async () => {
    const plan = independentPlan({
      panels: [panel(0), panel(1)],
      renderStates: planningInput().renderStates.slice(0, 2),
    });
    const abortError = Object.preventExtensions(new DOMException('Aborted', 'AbortError'));
    const dependencies = executionDependencies({
      generateImages: vi.fn(async (_prompt, options) => {
        if (options.requestId === 'panel-1') throw abortError;
        return [{ index: 0, value: 'second', source: 'b64_json' }];
      }),
    });

    await expect(executeIndependentPlan(plan, dependencies)).rejects.toBe(abortError);
    expect(dependencies.generateImages).toHaveBeenCalledTimes(2);
  });
});

describe('runContinuityGeneration', () => {
  it('registers the planned route and applies execution output through the orchestrator', async () => {
    const input = planningInput({
      panels: [panel(0), panel(1)],
      renderStates: planningInput().renderStates.slice(0, 2),
    });
    const pageData = pageFixture(2);
    const dependencies = executionDependencies();
    const now = vi.spyOn(Date, 'now').mockReturnValue(6000);

    await runContinuityGeneration({ planningInput: input, pageData }, dependencies);

    expect(dependencies.startProgress).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'sequential-page' }),
      2,
    );
    expect(pageData.generation).toMatchObject({
      strategy: 'sequential-page',
      modelId: SEQUENTIAL_MODEL_ID,
      generatedAt: 6000,
      outcome: 'complete',
    });
    now.mockRestore();
  });

  it('applies settled independent results before propagating a sibling AbortError', async () => {
    const input = planningInput({
      pageModelId: 'independent-model',
      pageModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
      companionModelId: 'independent-model',
      companionModel: { maxInputImages: 10, maxOutputImages: 1, sizes: ['1920x1920'] },
      panels: [panel(0), panel(1)],
      renderStates: planningInput().renderStates.slice(0, 2),
    });
    const pageData = pageFixture(2);
    const abortError = Object.freeze(new DOMException('Aborted', 'AbortError'));
    const dependencies = executionDependencies({
      generateImages: vi.fn(async (_prompt, options) => {
        if (options.requestId === 'panel-1') throw abortError;
        return [{ index: 0, value: 'settled-second', source: 'b64_json' }];
      }),
    });

    const pending = runContinuityGeneration({ planningInput: input, pageData }, dependencies);
    expect(pageData).toEqual(pageFixture(2));
    await expect(pending).rejects.toBe(abortError);

    expect(pageData.panels[0].imagePrompt).toBeTruthy();
    expect(pageData.panels[0].imageUrl).toBeUndefined();
    expect(pageData.panels[1].imageUrl).toBe('data:settled-second');
    expect(pageData.generation).toBeUndefined();
    expect(pageData.generationWarnings).toBeUndefined();
  });

  it('applies sequential panel prompts before propagating AbortError', async () => {
    const input = planningInput({
      panels: [panel(0), panel(1)],
      renderStates: planningInput().renderStates.slice(0, 2),
    });
    const pageData = pageFixture(2);
    const abortError = Object.preventExtensions(new DOMException('Aborted', 'AbortError'));
    const dependencies = executionDependencies({
      generateImages: vi.fn(async () => {
        throw abortError;
      }),
    });

    await expect(runContinuityGeneration({ planningInput: input, pageData }, dependencies)).rejects.toBe(abortError);

    expect(pageData.panels.every(({ imagePrompt }) => Boolean(imagePrompt))).toBe(true);
    expect(pageData.generation).toBeUndefined();
    expect(pageData.generationWarnings).toBeUndefined();
  });
});
