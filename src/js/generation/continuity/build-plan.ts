import {
  allocateReferences,
  collectLocationKeys,
  collectPageCast,
  collectPanelCast,
  compileIndependentPanelPrompt,
  compilePanelDescription,
  compileSequentialPagePrompt,
  effectiveReferenceBudget,
  resolveImageGenerationPlan,
} from '../../visual-continuity.js';
import type { PlannedPage, ReferenceAllocation, ReferenceManifestItem } from '../../visual-continuity.js';
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
  };
}

function emptyAllocation(): ReferenceAllocation {
  return { manifest: [], dataUrls: [], unanchoredCharacterIds: [], warnings: [] };
}

function orderedPanelCast(input: ContinuityPlanningInput, panelIndex: number): string[] {
  const cast = new Set(collectPanelCast(input.panels[panelIndex]));
  const ordered = input.selectedCharacterIds.filter((id) => cast.has(id));
  const extras = [...cast].filter((id) => !ordered.includes(id)).sort();
  return [...ordered, ...extras];
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
  const plannedPage: PlannedPage = { title: '', choices: [], panels: [...input.panels] };
  const targetPanels = input.targetPanelIndexes === undefined ? null : new Set<number>(input.targetPanelIndexes);

  const pageAllocation = input.useReferenceImages
    ? allocateReferences({
        characterIds: collectPageCast(plannedPage, [...input.selectedCharacterIds]),
        charactersById: input.charactersById,
        locationKeys: collectLocationKeys([...input.panels]),
        world: input.world,
        budget: pageBudget,
        previousFrame: input.previousFrame,
        anchorImageIdByCharacter: input.anchorImageIdByCharacter,
      })
    : emptyAllocation();
  warnings.push(...pageAllocation.warnings);

  const panelAllocations = input.panels.map((_, panelIndex) =>
    input.useReferenceImages
      ? allocateReferences({
          characterIds: orderedPanelCast(input, panelIndex),
          charactersById: input.charactersById,
          locationKeys: input.panels[panelIndex].visual?.locationKey
            ? [input.panels[panelIndex].visual.locationKey]
            : [],
          world: input.world,
          budget: panelBudget,
          previousFrame: input.previousFrame,
          anchorImageIdByCharacter: input.anchorImageIdByCharacter,
        })
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
