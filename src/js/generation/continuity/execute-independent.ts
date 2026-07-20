import { toSafeGenerationFailure } from '../../generation-progress.js';
import { recordCancellationResult } from './cancellation-journal.js';
import type {
  ContinuityExecutionDependencies,
  ContinuityExecutionResult,
  ContinuityPanelExecutionResult,
} from './orchestrator.js';
import type { ContinuityGenerationPlan, IndependentContinuityGenerationPlan } from './types.js';

function independentPlan(plan: ContinuityGenerationPlan): IndependentContinuityGenerationPlan {
  if (plan.strategy !== 'independent-panels') {
    throw new Error('Independent executor requires an independent-panels plan');
  }
  return plan;
}

function allocationFailures(plan: IndependentContinuityGenerationPlan): ContinuityPanelExecutionResult[] {
  return plan.allocationFailures.map(({ panelIndex, detail }) => ({ panelIndex, generationError: detail }));
}

export async function executeIndependentPlan(
  inputPlan: ContinuityGenerationPlan,
  dependencies: ContinuityExecutionDependencies,
): Promise<ContinuityExecutionResult> {
  const plan = independentPlan(inputPlan);
  const panelResults: ContinuityPanelExecutionResult[] = allocationFailures(plan);
  const warnings: string[] = [];
  const compressionCache = new Map<string, Promise<string>>();
  let done = 0;

  dependencies.setStatus(`Generating images (0 / ${plan.requests.length})...`);
  const settlements = await Promise.allSettled(
    plan.requests.map(async (request) => {
      const panelIndex = request.panelIndexes[0];
      try {
        const results = await dependencies.generateImages(request.prompt, {
          count: 1,
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
        });
        dependencies.updateRequest(request.id, {
          state: 'persisting',
          receivedImageCount: 1,
        });
        const first = results[0];
        const saved = await dependencies.persistImage(first.value, first.source, { signal: dependencies.signal });
        if (saved.value) {
          panelResults.push({ panelIndex, imageUrl: saved.value, clearGenerationError: true });
        }
        if (saved.warning) warnings.push(`Panel ${panelIndex + 1}: ${saved.warning}`);
        dependencies.updateRequest(request.id, {
          state: 'complete',
          receivedImageCount: 1,
          completedAt: Date.now(),
        });
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') throw error;
        dependencies.logError('Panel image generation (continuity)', error);
        const failure = toSafeGenerationFailure(error, 'image-request');
        panelResults.push({ panelIndex, generationError: failure.message });
        warnings.push(`Panel ${panelIndex + 1}: ${failure.message}`);
        dependencies.updateRequest(request.id, {
          state: failure.code === 'GENERATION_TIMEOUT' ? 'timed-out' : 'failed',
          failure,
          completedAt: Date.now(),
        });
        dependencies.toast(`Panel ${panelIndex + 1} image failed: ${failure.message}`, 'error');
      }
      done++;
      dependencies.setStatus(`Generating images (${done} / ${plan.requests.length})...`);
    }),
  );
  const cancelled = settlements.find(
    (settlement) => settlement.status === 'rejected' && (settlement.reason as { name?: string })?.name === 'AbortError',
  );
  if (cancelled?.status === 'rejected') {
    recordCancellationResult(cancelled.reason, { panelResults, warnings });
    throw cancelled.reason;
  }

  return { panelResults, warnings };
}
