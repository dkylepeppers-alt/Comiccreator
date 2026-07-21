import { Capacitor } from '@capacitor/core';
import { ForegroundService } from '@capawesome-team/capacitor-android-foreground-service';

/**
 * Android keep-alive for in-flight page generation.
 *
 * On the Capacitor Android build, a foreground service (with a persistent
 * "Generating page…" notification) keeps the WebView process alive while a
 * generation request is running, so backgrounding the app does not kill the
 * fetch. On the web build every call is a no-op. Failures here must never
 * break generation itself, so both entry points swallow errors after logging.
 *
 * The service's foregroundServiceType is declared as dataSync in
 * android/app/src/main/AndroidManifest.xml; startForegroundService() without
 * an explicit serviceType uses the manifest-declared type on Android 14+.
 *
 * start/stop are serialized through a single operation queue so a stop that
 * arrives while a start is still mid-flight (e.g. awaiting a permission
 * prompt) waits for that start to actually finish instead of racing it —
 * otherwise the stop can no-op against a service that hasn't started yet,
 * and the subsequent start then leaves the foreground service/notification
 * running with nothing left to ever stop it.
 */

const NOTIFICATION_ID = 4821;
let started = false;
let opQueue: Promise<void> = Promise.resolve();

function logKeepAliveError(err: unknown): void {
  const g = globalThis as any;
  if (typeof g.App !== 'undefined' && typeof g.App.logError === 'function') {
    g.App.logError('generation-keepalive', err);
  }
}

async function doStart(): Promise<void> {
  if (started) return;
  try {
    // Best effort on Android 13+: the notification only shows with permission,
    // but the service keeps the process alive either way.
    try {
      const status = await ForegroundService.checkPermissions();
      if (status.display !== 'granted') await ForegroundService.requestPermissions();
    } catch (_) {
      /* permission probing must not block the keep-alive */
    }
    await ForegroundService.startForegroundService({
      id: NOTIFICATION_ID,
      title: 'AI Comic Creator',
      body: 'Generating page…',
      smallIcon: 'ic_stat_generation',
    });
    started = true;
  } catch (err) {
    logKeepAliveError(err);
  }
}

async function doStop(): Promise<void> {
  if (!started) return;
  started = false;
  try {
    await ForegroundService.stopForegroundService();
  } catch (err) {
    logKeepAliveError(err);
  }
}

export function startGenerationKeepAlive(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve();
  opQueue = opQueue.then(doStart);
  return opQueue;
}

export function stopGenerationKeepAlive(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve();
  opQueue = opQueue.then(doStop);
  return opQueue;
}
