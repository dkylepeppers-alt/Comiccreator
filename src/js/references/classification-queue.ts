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
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
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
}: ClassificationQueueDependencies): ClassificationQueue {
  let paused = false;
  let activeRun: Promise<void> | null = null;

  async function startIfUnpaused(): Promise<void> {
    if (!paused) await run();
  }

  async function enqueue(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    const updatedAsset: ReferenceAsset = {
      ...asset,
      classificationState: 'pending',
      acceptedAsIs: false,
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
      lastError: error.message || error.code,
      updatedAt: now(),
    };
    await repository.putAssetAndJob(
      {
        ...asset,
        classificationState: error.code === 'manual-metadata' ? 'needs-review' : 'could-not-classify',
        acceptedAsIs: false,
        updatedAt: now(),
      },
      failed,
    );
    await repository.recordDiagnostic(diagnostic(asset, { ...error, queueState: 'failed' }, now()));
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
    await repository.putAssetAndJob(
      { ...asset, classificationState: 'pending', updatedAt: now() },
      { ...job, status: 'pending', retryAt, lastError: undefined, updatedAt: now() },
    );
    await repository.recordDiagnostic(diagnostic(asset, error, now()));
  }

  async function processJob(job: ClassificationJob): Promise<void> {
    const running: ClassificationJob = {
      ...job,
      status: 'running',
      retryAt: undefined,
      attemptCount: job.attemptCount + 1,
      lastError: undefined,
      updatedAt: now(),
    };
    await repository.putJob(running);
    const asset = await repository.getAsset(job.assetId);
    if (!asset) {
      await repository.putJob({
        ...running,
        status: 'failed',
        lastError: `Reference asset "${job.assetId}" no longer exists`,
        updatedAt: now(),
      });
      return;
    }
    if (asset.provenance.metadata === 'manual') {
      await failJob(asset, running, { stage: 'validation', code: 'manual-metadata', mode: 'local' });
      return;
    }

    let outcome: ClassificationOutcome;
    try {
      outcome = await classifier.classify(asset);
    } catch (error) {
      outcome = {
        kind: 'failure',
        error: {
          stage: 'inference',
          code: 'inference-failed',
          mode: 'local',
          message: error instanceof Error ? error.message : undefined,
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
    await repository.putAssetAndJob(
      {
        ...asset,
        ...outcome.classification,
        provenance: { ...asset.provenance, metadata: 'local' },
        classificationState: needsReview ? 'needs-review' : 'ready',
        acceptedAsIs: false,
        updatedAt: now(),
      },
      { ...running, status: 'complete', lastError: undefined, updatedAt: now() },
    );
    if (outcome.validationReason) {
      await repository.recordDiagnostic(
        diagnostic(
          asset,
          {
            stage: 'validation',
            code: outcome.validationReason === 'unmatched-entity-links' ? 'unmatched-entity-links' : 'low-confidence',
            mode: 'local',
            validationReason: outcome.validationReason,
            queueState: 'complete',
          },
          now(),
        ),
      );
    }
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
      if (!next) return;
      await processJob(next);
    }
  }

  function run(): Promise<void> {
    if (activeRun) return activeRun;
    paused = false;
    activeRun = processPendingJobs().finally(() => {
      activeRun = null;
    });
    return activeRun;
  }

  function pause(): void {
    paused = true;
  }

  async function resume(): Promise<void> {
    paused = false;
    await startIfUnpaused();
  }

  async function retry(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    const updatedAsset: ReferenceAsset = {
      ...asset,
      classificationState: 'pending',
      acceptedAsIs: false,
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
    for (const job of failed) {
      const asset = await repository.getAsset(job.assetId);
      if (!asset) continue;
      await repository.putAssetAndJob(
        { ...asset, classificationState: 'pending', acceptedAsIs: false, updatedAt: now() },
        pendingJob(asset, now(), job),
      );
    }
    if (failed.length) await startIfUnpaused();
    return failed.length;
  }

  async function acceptAsIs(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    await repository.putAsset({
      ...asset,
      acceptedAsIs: true,
      autoUse: true,
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

  queueMicrotask(() => void run().catch(() => undefined));
  return { enqueue, run, pause, resume, retry, retryAllFailed, acceptAsIs, reclassify, getProgress };
}
