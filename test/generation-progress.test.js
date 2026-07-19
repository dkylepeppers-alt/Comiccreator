import {
  GenerationTimeoutError,
  addWarning,
  enterStage,
  formatElapsed,
  getGenerationCounts,
  getSoftStalledRequests,
  registerRequests,
  runWithTimeout,
  startAttempt,
  toSafeDiagnostics,
  updateRequest,
} from '../src/js/generation-progress.ts';

describe('generation progress', () => {
  it('tracks stable request and image counts', () => {
    let progress = startAttempt('new-page', 1000, 'attempt-1');
    progress = enterStage(progress, 'waiting-for-images', 'Waiting', 2000);
    progress = registerRequests(
      progress,
      [
        { id: 'panel-1', panelIndexes: [0], modelId: 'seedream-v4.5', expectedImageCount: 1 },
        { id: 'panel-2', panelIndexes: [1], modelId: 'seedream-v4.5', expectedImageCount: 1 },
      ],
      3000,
    );
    progress = updateRequest(progress, 'panel-1', { state: 'complete', receivedImageCount: 1 }, 4000);
    expect(getGenerationCounts(progress)).toEqual({
      completedRequests: 1,
      totalRequests: 2,
      receivedImages: 1,
      expectedImages: 2,
    });
  });

  it('only marks active requests as soft-stalled', () => {
    let progress = startAttempt('reimage', 0, 'attempt-2');
    progress = registerRequests(
      progress,
      [
        { id: 'slow', panelIndexes: [0], modelId: 'm', expectedImageCount: 1 },
        { id: 'done', panelIndexes: [1], modelId: 'm', expectedImageCount: 1 },
      ],
      100,
    );
    progress = updateRequest(progress, 'slow', { state: 'pending', startedAt: 100 }, 100);
    progress = updateRequest(progress, 'done', { state: 'complete', receivedImageCount: 1 }, 100);
    expect(getSoftStalledRequests(progress, 120_100)).toHaveLength(1);
    expect(getSoftStalledRequests(progress, 120_100)[0].id).toBe('slow');
  });

  it('formats elapsed time and emits redacted diagnostics', () => {
    expect(formatElapsed(128_000)).toBe('02:08');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
    let progress = startAttempt('continue', 0, 'safe-id');
    progress = addWarning(progress, 'safe warning', 100);
    const diagnostics = toSafeDiagnostics(progress);
    expect(diagnostics).toContain('safe warning');
    expect(diagnostics).not.toContain('prompt');
  });

  it('distinguishes timeout from caller cancellation', async () => {
    await expect(
      runWithTimeout(() => new Promise(() => {}), { timeoutMs: 5, phase: 'image-request', modelId: 'm' }),
    ).rejects.toBeInstanceOf(GenerationTimeoutError);

    const controller = new AbortController();
    const operation = runWithTimeout(() => new Promise(() => {}), {
      signal: controller.signal,
      timeoutMs: 1000,
      phase: 'image-request',
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  });
});
