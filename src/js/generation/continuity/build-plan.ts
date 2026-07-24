import {
  collectPanelCast,
  compileIndependentPanelPrompt,
  compilePanelDescription,
  compileSequentialPagePrompt,
  effectiveReferenceBudget,
  resolveImageGenerationPlan,
} from '../../visual-continuity.js';
import { resolvePanelReferences } from '../../references/resolver.js';
import type { ReferenceResolution } from '../../references/resolver.js';
import type { PanelReferenceRequest, ReferenceManifestItem } from '../../references/types.js';
import type {
  BlockedContinuityPanel,
  ContinuityAllocationFailure,
  ContinuityGenerationPlan,
  ContinuityPlanningInput,
  PanelContinuityRequest,
  SequentialContinuityRequest,
} from './types.js';

interface NarrowedModelCapability {
  readonly maxInputImages?: number | null;
  readonly maxOutputImages?: number | null;
  readonly sizes?: readonly unknown[] | null;
  readonly supportsEdit?: boolean;
  readonly inputModalities?: readonly unknown[] | null;
}

function readOptionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' ? value : undefined;
}

function readOptionalSizes(value: unknown): readonly unknown[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  return [...value];
}

function narrowModelCapability(value: unknown): NarrowedModelCapability | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  return {
    maxInputImages: readOptionalNumber(metadata.maxInputImages),
    maxOutputImages: readOptionalNumber(metadata.maxOutputImages),
    sizes: readOptionalSizes(metadata.sizes),
    ...(typeof metadata.supports_edit === 'boolean' ? { supportsEdit: metadata.supports_edit } : {}),
    inputModalities: readOptionalSizes(metadata.inputModalities),
  };
}

/**
 * Whether the model can accept reference (input) images. Unknown metadata
 * (null capability) is treated as capable so imprecise catalogs never
 * silently drop references — only explicit "no image input" metadata does.
 */
function supportsImageInput(capability: NarrowedModelCapability | null): boolean {
  if (!capability) return true;
  if (capability.supportsEdit === true) return true;
  if (typeof capability.maxInputImages === 'number' && capability.maxInputImages > 0) return true;
  if (Array.isArray(capability.inputModalities)) return capability.inputModalities.includes('image');
  return capability.supportsEdit === undefined;
}

function emptyAllocation(): ReferenceResolution {
  return { manifest: [], dataUrls: [], missing: [], warnings: [] };
}

function orderedPanelCast(input: ContinuityPlanningInput, panelIndex: number): string[] {
  const cast = new Set(collectPanelCast(input.panels[panelIndex]));
  const ordered = input.selectedCharacterIds.filter((id) => cast.has(id));
  const extras = [...cast].filter((id) => !ordered.includes(id)).sort();
  return [...ordered, ...extras];
}

function panelReferenceRequest(input: ContinuityPlanningInput, panelIndex: number): PanelReferenceRequest {
  const visual = input.panels[panelIndex].visual;
  return {
    worldId: input.worldId || input.world?.id || '',
    characterIds: orderedPanelCast(input, panelIndex),
    locationId: visual.locationId,
    characterStates: Object.fromEntries(
      visual.characters.flatMap((character) =>
        character.appearanceState ? [[character.characterId, character.appearanceState]] : [],
      ),
    ),
    interaction: visual.interaction || null,
    facets: {
      ...(visual.framing ? { framing: visual.framing as PanelReferenceRequest['facets']['framing'] } : {}),
      ...(visual.cameraElevation
        ? { cameraElevation: visual.cameraElevation as PanelReferenceRequest['facets']['cameraElevation'] }
        : {}),
      ...(visual.lighting ? { lighting: visual.lighting } : {}),
    },
    propNames: [...visual.keyProps],
  };
}

function resolveForPanel(input: ContinuityPlanningInput, panelIndex: number, budget: number): ReferenceResolution {
  return resolvePanelReferences({
    request: panelReferenceRequest(input, panelIndex),
    assets: [...(input.referenceAssets || [])],
    budget,
    preferredReferenceIds: { ...(input.preferredReferenceIds || {}) },
    pinnedReferenceIds: { ...(input.pinnedReferenceIds || {}) },
    manualReferenceIds: [...(input.manualReferenceIdsByPanel?.[panelIndex] || [])],
    previousFrame: input.previousFrame,
  });
}

function resolveForPage(input: ContinuityPlanningInput, budget: number): ReferenceResolution {
  const resolutions = input.panels.map((_, panelIndex) =>
    resolvePanelReferences({
      request: panelReferenceRequest(input, panelIndex),
      assets: [...(input.referenceAssets || [])],
      budget: Number.MAX_SAFE_INTEGER,
      preferredReferenceIds: { ...(input.preferredReferenceIds || {}) },
      pinnedReferenceIds: { ...(input.pinnedReferenceIds || {}) },
      manualReferenceIds: [...(input.manualReferenceIdsByPanel?.[panelIndex] || [])],
    }),
  );
  const entries: Array<{ item: ReferenceManifestItem; dataUrl: string; order: number }> = [];
  const seen = new Set<string>();
  let order = 0;
  for (const resolution of resolutions) {
    resolution.manifest.forEach((item, index) => {
      const key = item.imageId || `${item.role}:${item.label}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ item, dataUrl: resolution.dataUrls[index], order: order++ });
    });
  }
  const roleOrder: ReferenceManifestItem['role'][] = [
    'identity',
    'appearance',
    'location',
    'interaction',
    'prop',
    'style',
    'previous-frame',
  ];
  entries.sort(
    (left, right) => roleOrder.indexOf(left.item.role) - roleOrder.indexOf(right.item.role) || left.order - right.order,
  );
  if (entries.length > budget) {
    return {
      manifest: [],
      dataUrls: [],
      missing: resolutions.flatMap(({ missing }) => missing),
      warnings: resolutions.flatMap(({ warnings }) => warnings),
      error: {
        type: 'capacity',
        required: entries.length,
        budget,
        detail: `This page needs ${entries.length} mandatory reference image(s), but only ${budget} fit.`,
      },
    };
  }
  const manifest = entries.map(({ item }, index) => ({ ...item, index: index + 1 }));
  const dataUrls = entries.map(({ dataUrl }) => dataUrl);
  if (input.previousFrame?.dataUrl && manifest.length < budget) {
    manifest.push({
      index: manifest.length + 1,
      role: 'previous-frame',
      label: 'previous page final panel',
      sourcePageId: input.previousFrame.sourcePageId,
      sourcePanelIndex: input.previousFrame.sourcePanelIndex,
    });
    dataUrls.push(input.previousFrame.dataUrl);
  }
  return {
    manifest,
    dataUrls,
    missing: resolutions.flatMap(({ missing }) => missing),
    warnings: resolutions.flatMap(({ warnings }) => warnings),
  };
}

function supportsSize(capability: NarrowedModelCapability | null, imageSize: string): boolean {
  return !Array.isArray(capability?.sizes) || capability.sizes.length === 0 || capability.sizes.includes(imageSize);
}

function freezeManifest(items: readonly ReferenceManifestItem[]): readonly ReferenceManifestItem[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function freezeBlockedPanels(items: readonly BlockedContinuityPanel[]): readonly BlockedContinuityPanel[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function freezeAllocationFailures(
  items: readonly ContinuityAllocationFailure[],
): readonly ContinuityAllocationFailure[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function uniqueWarnings(warnings: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(warnings)]);
}

export function buildContinuityGenerationPlan(input: ContinuityPlanningInput): ContinuityGenerationPlan {
  const pageModel = narrowModelCapability(input.pageModel);
  const panelModelId = input.companionModelId || input.pageModelId;
  const panelModel =
    input.companionModel == null && panelModelId === input.pageModelId
      ? pageModel
      : narrowModelCapability(input.companionModel);
  const pageBudget = effectiveReferenceBudget(input.referenceBudget, pageModel?.maxInputImages);
  const panelBudget = effectiveReferenceBudget(input.referenceBudget, panelModel?.maxInputImages);
  const warnings = [...(input.warnings || [])];
  const targetPanels = input.targetPanelIndexes === undefined ? null : new Set<number>(input.targetPanelIndexes);

  const pageAcceptsReferences = supportsImageInput(pageModel);
  const panelAcceptsReferences = supportsImageInput(panelModel);
  if (input.useReferenceImages && !pageAcceptsReferences) {
    warnings.push(`${input.pageModelId} does not accept reference images — generating without them`);
  }
  if (input.useReferenceImages && !panelAcceptsReferences && panelModelId !== input.pageModelId) {
    warnings.push(`${panelModelId} does not accept reference images — panel requests will omit them`);
  }

  const pageAllocation =
    input.useReferenceImages && pageAcceptsReferences ? resolveForPage(input, pageBudget) : emptyAllocation();
  warnings.push(...pageAllocation.warnings);

  const panelAllocations = input.panels.map((_, panelIndex) =>
    input.useReferenceImages && panelAcceptsReferences
      ? resolveForPanel(input, panelIndex, panelBudget)
      : emptyAllocation(),
  );
  const allocationFailures = freezeAllocationFailures(
    panelAllocations.flatMap((allocation, panelIndex) =>
      allocation.error ? [{ panelIndex, detail: allocation.error.detail }] : [],
    ),
  );

  const pageSizeValid = supportsSize(pageModel, input.imageSize);
  if (!pageSizeValid) {
    warnings.push(
      `Size ${input.imageSize} is not in ${input.pageModelId}'s supported resolution list — sequential batching skipped`,
    );
  }
  const panelSizeValid = supportsSize(panelModel, input.imageSize);
  if (!panelSizeValid) {
    warnings.push(
      `Size ${input.imageSize} is not in ${panelModelId}'s supported resolution list — panel requests may be rejected`,
    );
  }

  const route = resolveImageGenerationPlan({
    modelId: input.pageModelId,
    modelMeta: pageModel
      ? {
          maxInputImages: pageBudget,
          maxOutputImages: pageModel.maxOutputImages,
        }
      : null,
    imagePanelCount: input.panels.length,
    pageReferenceCount: pageAllocation.error ? pageAllocation.error.required : pageAllocation.manifest.length,
    panelReferenceCounts: panelAllocations.map((allocation) =>
      allocation.error ? allocation.error.required : allocation.manifest.length,
    ),
    requestedSizes: [input.imageSize],
    sequentialEnabled: input.sequentialEnabled && pageSizeValid && targetPanels === null,
    panelCapacity: panelBudget,
  });
  warnings.push(...route.reasons.filter((reason) => reason !== 'Sequential page request'));

  const blockedPanels = freezeBlockedPanels(route.blockedPanels);

  if (route.strategy === 'sequential-page' && !pageAllocation.error) {
    const prompt = compileSequentialPagePrompt({
      panels: [...input.panels],
      renderStates: [...input.renderStates],
      manifest: pageAllocation.manifest,
      charactersById: input.charactersById,
      stylePreset: input.stylePreset,
    });
    const panelPrompts = input.panels.map((panel, panelIndex) =>
      compilePanelDescription({
        panel,
        renderState: input.renderStates[panelIndex] || {},
        manifest: pageAllocation.manifest,
        charactersById: input.charactersById,
      }),
    );
    const request: SequentialContinuityRequest = Object.freeze({
      id: 'page-sequence',
      panelIndexes: Object.freeze(input.panels.map((_, panelIndex) => panelIndex)),
      modelId: input.pageModelId,
      expectedImageCount: input.panels.length,
      prompt,
      imageDataUrls: Object.freeze([...pageAllocation.dataUrls]),
      ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    });

    return Object.freeze({
      strategy: 'sequential-page',
      pageModelId: input.pageModelId,
      effectiveModelId: input.pageModelId,
      imageSize: input.imageSize,
      requests: Object.freeze([request]),
      compiledPrompts: Object.freeze([prompt]),
      panelPrompts: Object.freeze(panelPrompts),
      referenceManifest: freezeManifest(pageAllocation.manifest),
      warnings: uniqueWarnings(warnings),
      blockedPanels,
      allocationFailures,
    });
  }

  const blockedIndexes = new Set(blockedPanels.map(({ panelIndex }) => panelIndex));
  const requests: PanelContinuityRequest[] = [];
  const panelPrompts: Array<string | null> = input.panels.map(() => null);

  input.panels.forEach((panel, panelIndex) => {
    const allocation = panelAllocations[panelIndex];
    if (targetPanels && !targetPanels.has(panelIndex)) return;
    if (allocation.error || blockedIndexes.has(panelIndex)) return;

    const prompt = compileIndependentPanelPrompt({
      panel,
      renderState: input.renderStates[panelIndex] || {},
      manifest: allocation.manifest,
      charactersById: input.charactersById,
      stylePreset: input.stylePreset,
    });
    panelPrompts[panelIndex] = compilePanelDescription({
      panel,
      renderState: input.renderStates[panelIndex] || {},
      manifest: allocation.manifest,
      charactersById: input.charactersById,
    });
    requests.push(
      Object.freeze({
        id: `panel-${panelIndex + 1}`,
        panelIndexes: Object.freeze([panelIndex]) as readonly [number],
        modelId: panelModelId,
        expectedImageCount: 1,
        prompt,
        imageDataUrls: Object.freeze([...allocation.dataUrls]),
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
      }),
    );
  });

  panelAllocations.forEach((allocation, panelIndex) => {
    if (allocation.error) warnings.push(`Panel ${panelIndex + 1}: ${allocation.error.detail}`);
  });

  return Object.freeze({
    strategy: 'independent-panels',
    pageModelId: input.pageModelId,
    effectiveModelId: panelModelId,
    imageSize: input.imageSize,
    requests: Object.freeze(requests),
    compiledPrompts: Object.freeze(requests.map(({ prompt }) => prompt)),
    panelPrompts: Object.freeze(panelPrompts),
    referenceManifest: freezeManifest(panelAllocations.flatMap(({ manifest }) => manifest)),
    warnings: uniqueWarnings(warnings),
    blockedPanels,
    allocationFailures,
  });
}
