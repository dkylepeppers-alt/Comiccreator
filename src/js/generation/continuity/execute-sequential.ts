import { toSafeGenerationFailure } from '../../generation-progress.js';
import type {
  ContinuityAbortError,
  ContinuityExecutionDependencies,
  ContinuityExecutionResult,
  ContinuityPanelExecutionResult,
} from './orchestrator.js';
import type { ContinuityGenerationPlan, SequentialContinuityGenerationPlan } from './types.js';

function sequentialPlan(plan: ContinuityGenerationPlan): SequentialContinuityGenerationPlan {
  if (plan.strategy !== 'sequential-page') throw new Error('Sequential executor requires a sequential-page plan');
  return plan;
}

function attachCancellationResult(error: unknown, result: ContinuityExecutionResult): ContinuityAbortError {
  const abortError = error as ContinuityAbortError;
  Object.defineProperty(abortError, 'continuityExecutionResult', {
    value: { ...result, cancelled: true },
    configurable: true,
  });
  return abortError;
}

export async function executeSequentialPlan(
  inputPlan: ContinuityGenerationPlan,
  dependencies: ContinuityExecutionDependencies,
): Promise<ContinuityExecutionResult> {
  const plan = sequentialPlan(inputPlan);
  const request = plan.requests[0];
  const warnings: string[] = [];
  const panelResults: ContinuityPanelExecutionResult[] = [];
  const compressionCache = new Map<string, Promise<string>>();

  dependencies.setStatus(`Generating ${request.expectedImageCount} panel images in one sequence...`);
  const options = {
    count: request.expectedImageCount,
    model: request.modelId,
    resolution: plan.imageSize,
    exactReferences: true,
    refMaxDimension: 2048,
    signal: dependencies.signal,
    requestId: request.id,
    compressionCache,
    onProgress: dependencies.reportApiProgress,
    ...(request.imageDataUrls.length > 0 ? { imageDataUrls: [...request.imageDataUrls] } : {}),
    ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}),
  };

  try {
    const results = await dependencies.generateImages(request.prompt, options);
    dependencies.enterStage('persisting-images', 'Saving returned images locally…');
    dependencies.updateRequest(request.id, {
      state: 'persisting',
      receivedImageCount: results.length,
    });
    const persisted = await Promise.all(
      results.map(({ value, source }) => dependencies.persistImage(value, source, { signal: dependencies.signal })),
    );

    results.forEach((result, resultIndex) => {
      const saved = persisted[resultIndex];
      if (saved.value && request.panelIndexes.includes(result.index)) {
        panelResults.push({ panelIndex: result.index, imageUrl: saved.value });
      }
      if (saved.warning) warnings.push(saved.warning);
    });

    if (results.length < request.expectedImageCount) {
      warnings.push(
        `Model returned ${results.length} of ${request.expectedImageCount} images — missing panels were left empty`,
      );
      request.panelIndexes.forEach((panelIndex) => {
        panelResults.push({
          panelIndex,
          generationError: 'The page sequence did not return an image for this panel.',
          onlyIfEmpty: true,
        });
      });
      dependencies.toast(`Only ${results.length} of ${request.expectedImageCount} panel images were returned`, 'error');
    }

    dependencies.updateRequest(request.id, {
      state: 'complete',
      receivedImageCount: results.length,
      completedAt: Date.now(),
    });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw attachCancellationResult(error, { panelResults, warnings });
    }
    const failure = toSafeGenerationFailure(error, 'image-request');
    warnings.push(failure.message);
    request.panelIndexes.forEach((panelIndex) => {
      panelResults.push({ panelIndex, generationError: failure.message, onlyIfEmpty: true });
    });
    dependencies.updateRequest(request.id, {
      state: failure.code === 'GENERATION_TIMEOUT' ? 'timed-out' : 'failed',
      failure,
      completedAt: Date.now(),
    });
  }

  return { panelResults, warnings };
}
