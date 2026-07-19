export type GenerationContext = 'new-page' | 'continue' | 'reroll' | 'reimage';

export type GenerationStage =
  | 'checking-settings'
  | 'writing-story'
  | 'parsing-story'
  | 'preparing-references'
  | 'submitting-images'
  | 'waiting-for-images'
  | 'persisting-images'
  | 'saving-page'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type GenerationOutcome = 'active' | 'complete' | 'partial' | 'failed' | 'cancelled';
export type TimeoutPhase = 'model-metadata' | 'image-request' | 'result-download';
export type ImageRequestState =
  | 'queued'
  | 'preparing'
  | 'pending'
  | 'response-received'
  | 'persisting'
  | 'complete'
  | 'failed'
  | 'timed-out'
  | 'cancelled';

export const MODEL_METADATA_TIMEOUT_MS = 20_000;
export const IMAGE_REQUEST_SOFT_STALL_MS = 120_000;
export const IMAGE_REQUEST_TIMEOUT_MS = 600_000;
export const RESULT_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface SafeGenerationFailure {
  code: string;
  message: string;
  retryable: boolean;
  phase?: TimeoutPhase | string;
  status?: number;
  timeoutMs?: number;
  modelId?: string;
  panelIndexes?: number[];
}

export interface ImageRequestProgress {
  id: string;
  panelIndexes: number[];
  modelId: string;
  state: ImageRequestState;
  startedAt?: number;
  lastActivityAt: number;
  completedAt?: number;
  receivedImageCount: number;
  expectedImageCount: number;
  failure?: SafeGenerationFailure;
}

export interface GenerationProgress {
  attemptId: string;
  context: GenerationContext;
  stage: GenerationStage;
  outcome: GenerationOutcome;
  message: string;
  startedAt: number;
  stageStartedAt: number;
  lastActivityAt: number;
  strategy?: 'sequential-page' | 'independent-panels';
  pageModelId?: string;
  effectiveImageModelId?: string;
  resolution?: string;
  expectedImageCount?: number;
  requests: ImageRequestProgress[];
  warnings: string[];
  failure?: SafeGenerationFailure;
}

export class GenerationTimeoutError extends Error {
  readonly code = 'GENERATION_TIMEOUT';
  readonly retryable = true;
  phase: TimeoutPhase;
  timeoutMs: number;
  elapsedMs: number;
  modelId?: string;
  panelIndexes?: number[];

  constructor(
    phase: TimeoutPhase,
    timeoutMs: number,
    details: { modelId?: string; panelIndexes?: number[]; elapsedMs?: number } = {},
  ) {
    super(
      `${phase === 'image-request' ? 'Image request' : phase === 'model-metadata' ? 'Model lookup' : 'Image download'} timed out after ${formatElapsed(timeoutMs)}`,
    );
    this.name = 'GenerationTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = details.elapsedMs ?? timeoutMs;
    this.modelId = details.modelId;
    this.panelIndexes = details.panelIndexes;
  }
}

function attemptId(): string {
  return globalThis.crypto?.randomUUID?.() || `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function startAttempt(context: GenerationContext, now = Date.now(), id = attemptId()): GenerationProgress {
  return {
    attemptId: id,
    context,
    stage: 'checking-settings',
    outcome: 'active',
    message: 'Checking image model and settings…',
    startedAt: now,
    stageStartedAt: now,
    lastActivityAt: now,
    requests: [],
    warnings: [],
  };
}

export function enterStage(
  progress: GenerationProgress,
  stage: GenerationStage,
  message: string,
  now = Date.now(),
): GenerationProgress {
  return { ...progress, stage, message, stageStartedAt: now, lastActivityAt: now };
}

export function setRoute(
  progress: GenerationProgress,
  route: Pick<
    GenerationProgress,
    'strategy' | 'pageModelId' | 'effectiveImageModelId' | 'resolution' | 'expectedImageCount'
  >,
  now = Date.now(),
): GenerationProgress {
  return { ...progress, ...route, lastActivityAt: now };
}

export function registerRequests(
  progress: GenerationProgress,
  requests: Array<Pick<ImageRequestProgress, 'id' | 'panelIndexes' | 'modelId' | 'expectedImageCount'>>,
  now = Date.now(),
): GenerationProgress {
  return {
    ...progress,
    lastActivityAt: now,
    requests: requests.map((request) => ({
      ...request,
      state: 'queued',
      lastActivityAt: now,
      receivedImageCount: 0,
    })),
  };
}

export function updateRequest(
  progress: GenerationProgress,
  requestId: string,
  update: Partial<ImageRequestProgress>,
  now = Date.now(),
): GenerationProgress {
  return {
    ...progress,
    lastActivityAt: now,
    requests: progress.requests.map((request) =>
      request.id === requestId ? { ...request, ...update, lastActivityAt: now } : request,
    ),
  };
}

export function addWarning(progress: GenerationProgress, warning: string, now = Date.now()): GenerationProgress {
  return {
    ...progress,
    lastActivityAt: now,
    warnings: progress.warnings.includes(warning) ? progress.warnings : [...progress.warnings, warning],
  };
}

export function finishAttempt(
  progress: GenerationProgress,
  outcome: GenerationOutcome,
  now = Date.now(),
  failure?: SafeGenerationFailure,
): GenerationProgress {
  const stage = outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'complete';
  const message =
    outcome === 'cancelled'
      ? 'Generation cancelled'
      : outcome === 'failed'
        ? 'Generation stopped'
        : outcome === 'partial'
          ? 'Page saved with missing images'
          : 'Page ready';
  return { ...progress, outcome, stage, message, failure, stageStartedAt: now, lastActivityAt: now };
}

export function getGenerationCounts(progress: GenerationProgress) {
  const terminal = new Set<ImageRequestState>(['complete', 'failed', 'timed-out', 'cancelled']);
  return {
    completedRequests: progress.requests.filter((request) => terminal.has(request.state)).length,
    totalRequests: progress.requests.length,
    receivedImages: progress.requests.reduce((sum, request) => sum + request.receivedImageCount, 0),
    expectedImages:
      progress.expectedImageCount ?? progress.requests.reduce((sum, request) => sum + request.expectedImageCount, 0),
  };
}

export function getSoftStalledRequests(
  progress: GenerationProgress,
  now = Date.now(),
  thresholdMs = IMAGE_REQUEST_SOFT_STALL_MS,
): ImageRequestProgress[] {
  return progress.requests.filter(
    (request) =>
      ['pending', 'response-received', 'persisting'].includes(request.state) &&
      now - request.lastActivityAt >= thresholdMs,
  );
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function toSafeGenerationFailure(error: any, fallbackPhase?: string): SafeGenerationFailure {
  if (error instanceof GenerationTimeoutError || error?.code === 'GENERATION_TIMEOUT') {
    return {
      code: 'GENERATION_TIMEOUT',
      message: error.message,
      retryable: true,
      phase: error.phase,
      timeoutMs: error.timeoutMs,
      modelId: error.modelId,
      panelIndexes: error.panelIndexes,
    };
  }
  return {
    code: error?.code || (error?.status ? 'PROVIDER_ERROR' : 'GENERATION_ERROR'),
    message: String(error?.safeMessage || error?.message || 'Generation failed').slice(0, 500),
    retryable: error?.retryable !== false,
    phase: error?.phase || fallbackPhase,
    status: typeof error?.status === 'number' ? error.status : undefined,
    modelId: error?.model,
  };
}

export function toSafeDiagnostics(progress: GenerationProgress): string {
  const counts = getGenerationCounts(progress);
  return JSON.stringify(
    {
      attemptId: progress.attemptId,
      context: progress.context,
      stage: progress.stage,
      outcome: progress.outcome,
      elapsedMs: Math.max(0, progress.lastActivityAt - progress.startedAt),
      strategy: progress.strategy,
      pageModelId: progress.pageModelId,
      effectiveImageModelId: progress.effectiveImageModelId,
      resolution: progress.resolution,
      ...counts,
      requests: progress.requests.map(
        ({ id, panelIndexes, modelId, state, receivedImageCount, expectedImageCount, failure }) => ({
          id,
          panelIndexes,
          modelId,
          state,
          receivedImageCount,
          expectedImageCount,
          failure,
        }),
      ),
      warnings: progress.warnings,
      failure: progress.failure,
    },
    null,
    2,
  );
}

export async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    phase: TimeoutPhase;
    modelId?: string;
    panelIndexes?: number[];
  },
): Promise<T> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const startedAt = Date.now();
  let rejectBoundary: (reason: unknown) => void = () => {};
  const boundary = new Promise<never>((_, reject) => {
    rejectBoundary = reject;
  });
  const onAbort = () => {
    controller.abort();
    rejectBoundary(new DOMException('Aborted', 'AbortError'));
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    rejectBoundary(
      new GenerationTimeoutError(options.phase, options.timeoutMs, {
        modelId: options.modelId,
        panelIndexes: options.panelIndexes,
        elapsedMs: Date.now() - startedAt,
      }),
    );
  }, options.timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), boundary]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
