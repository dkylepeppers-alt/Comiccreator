import type {
  ClassificationDiagnostic,
  ClassificationErrorDetails,
  ClassificationJob,
  ClassificationOutcome,
  ReferenceAsset,
} from './types.js';
import type { ReferenceRepository } from './repository.js';

export interface ClassificationProgress {
  total: number;
  pending: number;
  running: number;
  complete: number;
  failed: number;
  paused: boolean;
}

export interface ClassificationQueue {
  enqueue(assetId: string): Promise<void>;
  run(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  resumeAfterLocalModelDownload(): Promise<void>;
  retry(assetId: string): Promise<void>;
  retryAllFailed(): Promise<number>;
  acceptAsIs(assetId: string): Promise<void>;
  reclassify(assetId: string): Promise<void>;
  getProgress(): Promise<ClassificationProgress>;
}

export interface ClassificationQueueDependencies {
  repository: ReferenceRepository;
  classifier: { classify(asset: ReferenceAsset): Promise<ClassificationOutcome> };
  now: () => number;
  timer?: {
    setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export function isAutomaticallyEligible(asset: ReferenceAsset): boolean {
  return asset.autoUse && (asset.classificationState === 'ready' || asset.acceptedAsIs);
}

function pendingJob(asset: ReferenceAsset, now: number, existing?: ClassificationJob): ClassificationJob {
  return {
    id: existing?.id || `classification-${asset.id}`,
    assetId: asset.id,
    worldId: asset.worldId,
    status: 'pending',
    attemptCount: existing?.attemptCount || 0,
    assetVersion: asset.classificationVersion,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function nextClassificationVersion(asset: ReferenceAsset): number {
  return (asset.classificationVersion || 0) + 1;
}

function diagnostic(asset: ReferenceAsset, error: ClassificationErrorDetails, now: number): ClassificationDiagnostic {
  return {
    id: `diagnostic-${asset.id}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    assetId: asset.id,
    worldId: asset.worldId,
    createdAt: now,
    queueState: error.queueState,
    error,
  };
}

export function createClassificationQueue({
  repository,
  classifier,
  now,
  timer = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  },
}: ClassificationQueueDependencies): ClassificationQueue {
  let paused = false;
  let activeRun: Promise<void> | null = null;
  let retryTimer: unknown | null = null;

  function scheduleRetry(retryAt: number): void {
    if (paused) return;
    if (retryTimer !== null) timer.clearTimeout(retryTimer);
    retryTimer = timer.setTimeout(
      () => {
        retryTimer = null;
        return run().catch(() => undefined);
      },
      Math.max(0, retryAt - now()),
    );
  }

  async function startIfUnpaused(): Promise<void> {
    if (paused) return;
    if (activeRun) await activeRun;
    if (!paused) await run();
  }

  async function enqueue(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    const updatedAsset: ReferenceAsset = {
      ...asset,
      classificationState: 'pending',
      acceptedAsIs: false,
      classificationVersion: nextClassificationVersion(asset),
      updatedAt: now(),
    };
    await repository.putAssetAndJob(
      updatedAsset,
      pendingJob(updatedAsset, now(), await repository.getJobByAsset(assetId)),
    );
    await startIfUnpaused();
  }

  async function failJob(
    asset: ReferenceAsset,
    job: ClassificationJob,
    error: ClassificationErrorDetails,
  ): Promise<void> {
    const failed: ClassificationJob = {
      ...job,
      status: 'failed',
      retryAt: undefined,
      lastError: error.code,
      updatedAt: now(),
    };
    await repository.finalizeAssetAndJobIfCurrent(
      asset,
      {
        ...asset,
        classificationState: error.code === 'manual-metadata' ? 'needs-review' : 'could-not-classify',
        acceptedAsIs: false,
        updatedAt: now(),
      },
      failed,
      diagnostic(asset, { ...error, queueState: 'failed' }, now()),
    );
  }

  async function waitJob(
    asset: ReferenceAsset,
    job: ClassificationJob,
    outcome: Extract<ClassificationOutcome, { kind: 'waiting' }>,
  ) {
    const retryAt = now() + outcome.retryDelayMs;
    const error: ClassificationErrorDetails = {
      stage: 'inference',
      code: outcome.reason === 'quota-busy' ? 'busy' : 'plugin-unavailable',
      mode: 'local',
      retryDelayMs: outcome.retryDelayMs,
      queueState: 'pending',
    };
    const finalized = await repository.finalizeAssetAndJobIfCurrent(
      asset,
      { ...asset, classificationState: 'pending', updatedAt: now() },
      { ...job, status: 'pending', retryAt, waitingReason: outcome.reason, lastError: undefined, updatedAt: now() },
      diagnostic(asset, error, now()),
    );
    if (finalized) scheduleRetry(retryAt);
  }

  async function processJob(job: ClassificationJob): Promise<void> {
    const running: ClassificationJob = {
      ...job,
      status: 'running',
      retryAt: undefined,
      waitingReason: undefined,
      attemptCount: job.attemptCount + 1,
      lastError: undefined,
      updatedAt: now(),
    };
    const asset = await repository.claimPendingJobIfCurrent(job, running);
    if (!asset) return;

    let outcome: ClassificationOutcome;
    try {
      outcome = await classifier.classify(asset);
    } catch {
      outcome = {
        kind: 'failure',
        error: {
          stage: 'inference',
          code: 'inference-failed',
          mode: 'local',
        },
      };
    }
    if (outcome.kind === 'waiting') {
      await waitJob(asset, running, outcome);
      return;
    }
    if (outcome.kind === 'failure') {
      await failJob(asset, running, outcome.error);
      return;
    }

    const needsReview = outcome.state === 'needs-review';
    const validationDiagnostic = outcome.validationReason
      ? diagnostic(
          asset,
          {
            stage: 'validation',
            code: outcome.validationReason === 'unmatched-entity-links' ? 'unmatched-entity-links' : 'low-confidence',
            mode: 'local',
            validationReason: outcome.validationReason,
            queueState: 'complete',
          },
          now(),
        )
      : undefined;
    await repository.finalizeAssetAndJobIfCurrent(
      asset,
      {
        ...asset,
        ...outcome.classification,
        provenance: { ...asset.provenance, metadata: 'local' },
        classificationState: needsReview ? 'needs-review' : 'ready',
        acceptedAsIs: false,
        updatedAt: now(),
      },
      { ...running, status: 'complete', lastError: undefined, updatedAt: now() },
      validationDiagnostic,
    );
  }

  async function processPendingJobs(): Promise<void> {
    const jobs = await repository.listJobs();
    for (const job of jobs.filter((candidate) => candidate.status === 'running')) {
      await repository.putJob({ ...job, status: 'pending', retryAt: undefined, updatedAt: now() });
    }
    while (!paused) {
      const next = (await repository.listJobs()).find(
        (job) => job.status === 'pending' && (job.retryAt === undefined || job.retryAt <= now()),
      );
      if (!next) {
        const retryAt = (await repository.listJobs())
          .filter((job) => job.status === 'pending' && job.retryAt !== undefined)
          .map((job) => job.retryAt!)
          .sort((left, right) => left - right)[0];
        if (retryAt !== undefined) scheduleRetry(retryAt);
        return;
      }
      await processJob(next);
    }
  }

  function run(): Promise<void> {
    if (activeRun) return activeRun;
    activeRun = processPendingJobs().finally(() => {
      activeRun = null;
    });
    return activeRun;
  }

  function pause(): void {
    paused = true;
    if (retryTimer !== null) timer.clearTimeout(retryTimer);
    retryTimer = null;
  }

  async function resume(): Promise<void> {
    paused = false;
    await startIfUnpaused();
  }

  async function resumeAfterLocalModelDownload(): Promise<void> {
    const waitingForDownload = (await repository.listJobs()).filter(
      (job) => job.status === 'pending' && job.waitingReason === 'model-downloading',
    );
    for (const job of waitingForDownload) {
      await repository.putJob({ ...job, retryAt: undefined, waitingReason: undefined, updatedAt: now() });
    }
    await startIfUnpaused();
  }

  async function retry(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    if (asset.provenance.metadata === 'manual' || asset.provenance.metadata === 'accepted') {
      throw new Error('Manual or accepted reference metadata can only be replaced through Reclassify.');
    }
    const updatedAsset: ReferenceAsset = {
      ...asset,
      classificationState: 'pending',
      acceptedAsIs: false,
      classificationVersion: nextClassificationVersion(asset),
      updatedAt: now(),
    };
    await repository.putAssetAndJob(
      updatedAsset,
      pendingJob(updatedAsset, now(), await repository.getJobByAsset(assetId)),
    );
    await startIfUnpaused();
  }

  async function retryAllFailed(): Promise<number> {
    const failed = (await repository.listJobs()).filter((job) => job.status === 'failed');
    let retried = 0;
    for (const job of failed) {
      const asset = await repository.getAsset(job.assetId);
      if (!asset || asset.provenance.metadata === 'manual' || asset.provenance.metadata === 'accepted') continue;
      const updatedAsset: ReferenceAsset = {
        ...asset,
        classificationState: 'pending',
        acceptedAsIs: false,
        classificationVersion: nextClassificationVersion(asset),
        updatedAt: now(),
      };
      await repository.putAssetAndJob(updatedAsset, pendingJob(updatedAsset, now(), job));
      retried += 1;
    }
    if (retried) await startIfUnpaused();
    return retried;
  }

  async function acceptAsIs(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    await repository.putAsset({
      ...asset,
      acceptedAsIs: true,
      autoUse: true,
      classificationVersion: nextClassificationVersion(asset),
      provenance: { ...asset.provenance, metadata: 'accepted' },
      updatedAt: now(),
    });
  }

  async function reclassify(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    const updatedAsset: ReferenceAsset = {
      ...asset,
      classificationState: 'pending',
      acceptedAsIs: false,
      provenance: { ...asset.provenance, metadata: 'local' },
      classificationVersion: nextClassificationVersion(asset),
      updatedAt: now(),
    };
    await repository.putAssetAndJob(
      updatedAsset,
      pendingJob(updatedAsset, now(), await repository.getJobByAsset(assetId)),
    );
    await startIfUnpaused();
  }

  async function getProgress(): Promise<ClassificationProgress> {
    const jobs = await repository.listJobs();
    return {
      total: jobs.length,
      pending: jobs.filter((job) => job.status === 'pending').length,
      running: jobs.filter((job) => job.status === 'running').length,
      complete: jobs.filter((job) => job.status === 'complete').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
      paused,
    };
  }

  return {
    enqueue,
    run,
    pause,
    resume,
    resumeAfterLocalModelDownload,
    retry,
    retryAllFailed,
    acceptAsIs,
    reclassify,
    getProgress,
  };
}
