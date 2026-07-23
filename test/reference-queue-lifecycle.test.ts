import { describe, expect, it, vi } from 'vitest';
import { installReferenceQueueLifecycle } from '../src/js/reference-workspace-runtime.js';

describe('reference queue app lifecycle', () => {
  it('starts after app initialization, pauses while hidden, and resumes when visible', async () => {
    const documentTarget = new EventTarget() as EventTarget & { visibilityState: 'visible' | 'hidden' };
    documentTarget.visibilityState = 'visible';
    const queue = {
      run: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
    };

    const cleanup = installReferenceQueueLifecycle(queue, documentTarget);
    await Promise.resolve();
    expect(queue.run).toHaveBeenCalledOnce();

    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(queue.pause).toHaveBeenCalledOnce();

    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(queue.resume).toHaveBeenCalledOnce();

    cleanup();
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(queue.pause).toHaveBeenCalledOnce();
  });

  it('does not start inference when the app initializes while hidden', async () => {
    const documentTarget = new EventTarget() as EventTarget & { visibilityState: 'visible' | 'hidden' };
    documentTarget.visibilityState = 'hidden';
    const queue = {
      run: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
    };

    installReferenceQueueLifecycle(queue, documentTarget);
    await Promise.resolve();

    expect(queue.pause).toHaveBeenCalledOnce();
    expect(queue.run).not.toHaveBeenCalled();

    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(queue.resume).toHaveBeenCalledOnce();
  });
});
