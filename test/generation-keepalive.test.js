import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  startForegroundService: vi.fn(),
  stopForegroundService: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: nativeMocks.isNativePlatform },
}));

vi.mock('@capawesome-team/capacitor-android-foreground-service', () => ({
  ForegroundService: {
    checkPermissions: nativeMocks.checkPermissions,
    requestPermissions: nativeMocks.requestPermissions,
    startForegroundService: nativeMocks.startForegroundService,
    stopForegroundService: nativeMocks.stopForegroundService,
  },
}));

const { startGenerationKeepAlive, stopGenerationKeepAlive } = await import('../src/js/generation-keepalive.js');

describe('generation-keepalive', () => {
  beforeEach(() => {
    Object.values(nativeMocks).forEach((mock) => mock.mockReset());
    nativeMocks.isNativePlatform.mockReturnValue(true);
    nativeMocks.checkPermissions.mockResolvedValue({ display: 'granted' });
    nativeMocks.requestPermissions.mockResolvedValue({ display: 'granted' });
    nativeMocks.startForegroundService.mockResolvedValue(undefined);
    nativeMocks.stopForegroundService.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Drain the internal op queue so state doesn't leak between tests.
    await stopGenerationKeepAlive();
  });

  it('is a no-op on the web build', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(false);
    await startGenerationKeepAlive();
    await stopGenerationKeepAlive();
    expect(nativeMocks.startForegroundService).not.toHaveBeenCalled();
    expect(nativeMocks.stopForegroundService).not.toHaveBeenCalled();
  });

  it('starts and stops the foreground service on native', async () => {
    await startGenerationKeepAlive();
    expect(nativeMocks.startForegroundService).toHaveBeenCalledTimes(1);
    await stopGenerationKeepAlive();
    expect(nativeMocks.stopForegroundService).toHaveBeenCalledTimes(1);
  });

  it('serializes a stop that arrives while start is still awaiting permissions', async () => {
    const calls = [];
    nativeMocks.startForegroundService.mockImplementation(async () => {
      calls.push('start');
    });
    nativeMocks.stopForegroundService.mockImplementation(async () => {
      calls.push('stop');
    });
    let resolvePermissions;
    nativeMocks.checkPermissions.mockReturnValue(
      new Promise((resolve) => {
        resolvePermissions = resolve;
      }),
    );

    const startPromise = startGenerationKeepAlive();
    const stopPromise = stopGenerationKeepAlive();
    resolvePermissions({ display: 'granted' });
    await Promise.all([startPromise, stopPromise]);

    // The stop must wait for the in-flight start to actually start the
    // service before stopping it — otherwise the service is left running
    // with no later call able to stop it (active gets desynced from reality).
    expect(calls).toEqual(['start', 'stop']);
    expect(nativeMocks.startForegroundService).toHaveBeenCalledTimes(1);
    expect(nativeMocks.stopForegroundService).toHaveBeenCalledTimes(1);
  });

  it('a later stop still stops the service after a serialized start/stop pair', async () => {
    let resolvePermissions;
    nativeMocks.checkPermissions.mockReturnValue(
      new Promise((resolve) => {
        resolvePermissions = resolve;
      }),
    );
    const startPromise = startGenerationKeepAlive();
    const stopPromise = stopGenerationKeepAlive();
    resolvePermissions({ display: 'granted' });
    await Promise.all([startPromise, stopPromise]);

    // Start a fresh generation and confirm start/stop still function normally.
    nativeMocks.checkPermissions.mockResolvedValue({ display: 'granted' });
    await startGenerationKeepAlive();
    await stopGenerationKeepAlive();
    expect(nativeMocks.startForegroundService).toHaveBeenCalledTimes(2);
    expect(nativeMocks.stopForegroundService).toHaveBeenCalledTimes(2);
  });
});
