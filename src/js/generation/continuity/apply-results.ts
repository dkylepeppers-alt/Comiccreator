import { PROMPT_VERSION } from '../../visual-continuity.js';
import type { ContinuityExecutionResult, ContinuityPageData, ContinuityPagePanel } from './orchestrator.js';
import type { ContinuityGenerationPlan } from './types.js';

function generationOutcome(panels: readonly ContinuityPagePanel[]): 'complete' | 'partial' {
  const imagePanels = panels.filter((panel) => panel.imagePrompt || panel.generationError || panel.imageUrl);
  const complete = imagePanels.filter((panel) => panel.imageUrl).length;
  return complete === imagePanels.length ? 'complete' : 'partial';
}

export function applyContinuityResult(
  pageData: ContinuityPageData,
  plan: ContinuityGenerationPlan,
  result: ContinuityExecutionResult,
  now: number,
): void {
  plan.panelPrompts.forEach((prompt, panelIndex) => {
    if (prompt !== null && pageData.panels[panelIndex]) pageData.panels[panelIndex].imagePrompt = prompt;
  });

  result.panelResults.forEach((panelResult) => {
    const panel = pageData.panels[panelResult.panelIndex];
    if (!panel) return;
    if (panelResult.imageUrl) panel.imageUrl = panelResult.imageUrl;
    if (panelResult.clearGenerationError) delete panel.generationError;
    if (panelResult.generationError && (!panelResult.onlyIfEmpty || !panel.imageUrl)) {
      panel.generationError = panelResult.generationError;
    }
  });

  if (result.cancelled) return;

  const failures = pageData.panels.flatMap((panel, panelIndex) =>
    panel.generationError ? [{ panelIndexes: [panelIndex], message: panel.generationError }] : [],
  );
  pageData.generation = {
    schemaVersion: 2,
    strategy: plan.strategy,
    modelId: plan.pageModelId,
    ...(plan.strategy === 'independent-panels' ? { singleImageModelId: plan.effectiveModelId } : {}),
    resolution: plan.imageSize,
    promptVersion: PROMPT_VERSION,
    compiledPrompts: plan.compiledPrompts,
    referenceManifest: plan.referenceManifest,
    generatedAt: now,
    outcome: generationOutcome(pageData.panels),
    failures,
  };
  pageData.generationWarnings = [...new Set([...plan.warnings, ...result.warnings])];
}
