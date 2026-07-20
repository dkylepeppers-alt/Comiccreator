import type { GenerateImagesOptions, GeneratedImage, ImageApiProgressEvent } from '../../api.js';
import type { GenerationStage, ImageRequestProgress } from '../../generation-progress.js';
import { buildContinuityGenerationPlan } from './build-plan.js';
import { executeIndependentPlan } from './execute-independent.js';
import { executeSequentialPlan } from './execute-sequential.js';
import { applyContinuityResult } from './apply-results.js';
import type { ContinuityGenerationPlan, ContinuityPlanningInput, ContinuityStrategy } from './types.js';

export interface PersistedContinuityImage {
  readonly value: string;
  readonly persisted: boolean;
  readonly warning?: string;
}

export interface ContinuityPanelExecutionResult {
  readonly panelIndex: number;
  readonly imageUrl?: string;
  readonly generationError?: string;
  readonly clearGenerationError?: boolean;
  readonly onlyIfEmpty?: boolean;
}

export interface ContinuityExecutionResult {
  readonly panelResults: readonly ContinuityPanelExecutionResult[];
  readonly warnings: readonly string[];
  /** Partial journal from an aborted execution; apply panel changes but do not finalize metadata. */
  readonly cancelled?: boolean;
}

export interface ContinuityPagePanel {
  imageUrl?: string;
  imagePrompt?: string;
  generationError?: string;
  readonly [key: string]: unknown;
}

export interface ContinuityPageGeneration {
  schemaVersion: 2;
  strategy: ContinuityStrategy;
  modelId: string;
  singleImageModelId?: string;
  resolution: string;
  promptVersion: string;
  compiledPrompts: readonly string[];
  referenceManifest: ContinuityGenerationPlan['referenceManifest'];
  generatedAt: number;
  outcome: 'complete' | 'partial';
  failures: Array<{ panelIndexes: number[]; message: string }>;
}

export interface ContinuityPageData {
  panels: ContinuityPagePanel[];
  generation?: ContinuityPageGeneration;
  generationWarnings?: string[];
  readonly [key: string]: unknown;
}

export interface ContinuityExecutionDependencies {
  readonly generateImages: (prompt: string, options: GenerateImagesOptions) => Promise<GeneratedImage[]>;
  readonly persistImage: (
    value: string,
    source: GeneratedImage['source'],
    options: { signal?: AbortSignal },
  ) => Promise<PersistedContinuityImage>;
  /** Register route and request snapshots before execution starts. */
  readonly startProgress: (plan: ContinuityGenerationPlan, expectedImageCount: number) => void;
  readonly enterStage: (stage: GenerationStage, message: string) => void;
  readonly updateRequest: (requestId: string, update: Partial<ImageRequestProgress>) => void;
  readonly reportApiProgress: (event: ImageApiProgressEvent) => void;
  readonly setStatus: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly toast: (message: string, type?: string) => void;
  readonly logError: (context: string, error: unknown) => void;
}

export interface RunContinuityGenerationInput {
  readonly planningInput: ContinuityPlanningInput;
  readonly pageData: ContinuityPageData;
}

export type ContinuityExecutor = (
  plan: ContinuityGenerationPlan,
  dependencies: ContinuityExecutionDependencies,
) => Promise<ContinuityExecutionResult>;

export interface ContinuityAbortError extends Error {
  continuityExecutionResult?: ContinuityExecutionResult;
}

const executors: Record<ContinuityStrategy, ContinuityExecutor> = {
  'sequential-page': (plan, dependencies) => executeSequentialPlan(plan, dependencies),
  'independent-panels': (plan, dependencies) => executeIndependentPlan(plan, dependencies),
};

export async function runContinuityGeneration(
  input: RunContinuityGenerationInput,
  dependencies: ContinuityExecutionDependencies,
): Promise<void> {
  const plan = buildContinuityGenerationPlan(input.planningInput);
  const expectedImageCount =
    input.planningInput.targetPanelIndexes === undefined
      ? input.planningInput.panels.length
      : new Set(input.planningInput.targetPanelIndexes).size;
  dependencies.startProgress(plan, expectedImageCount);
  try {
    const result = await executors[plan.strategy](plan, dependencies);
    applyContinuityResult(input.pageData, plan, result, Date.now());
  } catch (error) {
    const abortError = error as ContinuityAbortError;
    if (abortError?.name === 'AbortError' && abortError.continuityExecutionResult) {
      applyContinuityResult(input.pageData, plan, abortError.continuityExecutionResult, Date.now());
    }
    throw error;
  }
}
