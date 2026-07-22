import type { ReferenceRepository } from './repository.js';
import type { ClassificationJob, ReferenceAsset, ReferenceClassification } from './types.js';

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
  retry(assetId: string): Promise<void>;
  acceptAsIs(assetId: string): Promise<void>;
  reclassify(assetId: string): Promise<void>;
  getProgress(): Promise<ClassificationProgress>;
}

export interface ClassificationQueueDependencies {
  repository: ReferenceRepository;
  classifier: { classify(asset: ReferenceAsset): Promise<ReferenceClassification | null> };
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

export function createClassificationQueue({
  repository,
  classifier,
  now,
}: ClassificationQueueDependencies): ClassificationQueue {
  let paused = false;
  let activeRun: Promise<void> | null = null;

  async function enqueue(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    const existing = await repository.getJobByAsset(assetId);
    const updatedAsset: ReferenceAsset = {
      ...asset,
      classificationState: 'pending',
      acceptedAsIs: false,
      updatedAt: now(),
    };
    await repository.putAssetAndJob(updatedAsset, pendingJob(updatedAsset, now(), existing));
  }

  async function failJob(asset: ReferenceAsset, job: ClassificationJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Local classification did not return valid metadata';
    await repository.putAssetAndJob(
      {
        ...asset,
        classificationState: 'needs-review',
        acceptedAsIs: false,
        updatedAt: now(),
      },
      {
        ...job,
        status: 'failed',
        lastError: message,
        updatedAt: now(),
      },
    );
  }

  async function processJob(job: ClassificationJob): Promise<void> {
    const running: ClassificationJob = {
      ...job,
      status: 'running',
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
      await failJob(asset, running, new Error('Manual reference metadata requires explicit reclassification'));
      return;
    }

    try {
      const classification = await classifier.classify(asset);
      if (!classification) {
        await failJob(asset, running, new Error('Local classification did not return valid metadata'));
        return;
      }
      await repository.putAssetAndJob(
        {
          ...asset,
          ...classification,
          provenance: { ...asset.provenance, metadata: 'local' },
          classificationState: 'ready',
          acceptedAsIs: false,
          updatedAt: now(),
        },
        {
          ...running,
          status: 'complete',
          lastError: undefined,
          updatedAt: now(),
        },
      );
    } catch (error) {
      await failJob(asset, running, error);
    }
  }

  async function processPendingJobs(): Promise<void> {
    const interrupted = (await repository.listJobs()).filter((job) => job.status === 'running');
    for (const job of interrupted) {
      await repository.putJob({ ...job, status: 'pending', updatedAt: now() });
    }

    while (!paused) {
      const next = (await repository.listJobs()).find((job) => job.status === 'pending');
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

  async function retry(assetId: string): Promise<void> {
    const asset = await repository.getAsset(assetId);
    if (!asset) throw new Error(`Unknown reference asset "${assetId}"`);
    const existing = await repository.getJobByAsset(assetId);
    const updatedAsset: ReferenceAsset = {
      ...asset,
      ...(asset.provenance.metadata === 'manual'
        ? {}
        : { classificationState: 'pending' as const, acceptedAsIs: false }),
      updatedAt: now(),
    };
    await repository.putAssetAndJob(updatedAsset, pendingJob(updatedAsset, now(), existing));
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
    const existing = await repository.getJobByAsset(assetId);
    const updatedAsset: ReferenceAsset = {
      ...asset,
      classificationState: 'pending',
      acceptedAsIs: false,
      provenance: { ...asset.provenance, metadata: 'local' },
      updatedAt: now(),
    };
    await repository.putAssetAndJob(updatedAsset, pendingJob(updatedAsset, now(), existing));
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

  return { enqueue, run, pause, retry, acceptAsIs, reclassify, getProgress };
}
