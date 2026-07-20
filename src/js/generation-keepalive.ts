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
 */

const NOTIFICATION_ID = 4821;
let active = false;

function logKeepAliveError(err: unknown): void {
  const g = globalThis as any;
  if (typeof g.App !== 'undefined' && typeof g.App.logError === 'function') {
    g.App.logError('generation-keepalive', err);
  }
}

export async function startGenerationKeepAlive(): Promise<void> {
  if (!Capacitor.isNativePlatform() || active) return;
  active = true;
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
  } catch (err) {
    active = false;
    logKeepAliveError(err);
  }
}

export async function stopGenerationKeepAlive(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !active) return;
  active = false;
  try {
    await ForegroundService.stopForegroundService();
  } catch (err) {
    logKeepAliveError(err);
  }
}
