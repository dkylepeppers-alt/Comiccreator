import { registerPlugin } from '@capacitor/core';
import { buildClassificationPrompt, extractJsonObject, rosterFrom } from './classifier-prompt.js';
import type { ClassificationInput } from './classifier-prompt.js';
import { safeDiagnosticExcerpt } from './diagnostic-privacy.js';
import { parseReferenceClassificationDraft, validateReferenceClassificationDraft } from './schema.js';
import type { ClassificationOutcome } from './types.js';

export type LocalClassifierStatus = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export type { ClassificationInput };
export { buildClassificationPrompt };

export interface NativeClassifierPlugin {
  getAvailability(): Promise<{ status: LocalClassifierStatus }>;
  download(): Promise<void>;
  classify(options: { dataUrl: string; prompt: string }): Promise<{ text: string; mode?: 'structured' | 'text' }>;
}

export interface LocalReferenceClassifier {
  getAvailability(): Promise<{ status: LocalClassifierStatus }>;
  download(): Promise<void>;
  classify(input: ClassificationInput): Promise<ClassificationOutcome>;
}

function waiting(status: LocalClassifierStatus): ClassificationOutcome {
  return status === 'downloadable' || status === 'downloading'
    ? { kind: 'waiting', reason: 'model-downloading', retryDelayMs: 30_000 }
    : { kind: 'waiting', reason: 'model-unavailable', retryDelayMs: 60_000 };
}

function nativeErrorDetails(error: unknown): {
  code?: string;
  nativeCode?: number;
  retryDelayMs?: number;
  nativeMode?: 'structured' | 'text';
} {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { code?: unknown; data?: unknown };
  const data = candidate.data && typeof candidate.data === 'object' ? (candidate.data as Record<string, unknown>) : {};
  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof data.nativeCode === 'number' && Number.isInteger(data.nativeCode)
      ? { nativeCode: data.nativeCode }
      : {}),
    ...(typeof data.retryDelayMs === 'number' && Number.isFinite(data.retryDelayMs) && data.retryDelayMs >= 0
      ? { retryDelayMs: data.retryDelayMs }
      : {}),
    ...(data.mode === 'structured' || data.mode === 'text' ? { nativeMode: data.mode } : {}),
  };
}

function runtimeWaiting(error: unknown): ClassificationOutcome | null {
  const details = nativeErrorDetails(error);
  if (details.code === 'background-use-blocked' || details.nativeCode === 30) {
    return { kind: 'waiting', reason: 'app-background', retryDelayMs: details.retryDelayMs ?? 15_000 };
  }
  if (
    details.code === 'busy' ||
    details.code === 'quota-exceeded' ||
    details.nativeCode === 9 ||
    details.nativeCode === 27
  ) {
    return { kind: 'waiting', reason: 'quota-busy', retryDelayMs: details.retryDelayMs ?? 30_000 };
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('background')) return { kind: 'waiting', reason: 'app-background', retryDelayMs: 15_000 };
  if (message.includes('quota') || message.includes('busy')) {
    return { kind: 'waiting', reason: 'quota-busy', retryDelayMs: 30_000 };
  }
  return null;
}

export function createLocalReferenceClassifier(plugin: NativeClassifierPlugin): LocalReferenceClassifier {
  return {
    getAvailability: async () => {
      try {
        return await plugin.getAvailability();
      } catch {
        return { status: 'unavailable' };
      }
    },
    download: () => plugin.download(),
    classify: async (input): Promise<ClassificationOutcome> => {
      let status: LocalClassifierStatus;
      try {
        status = (await plugin.getAvailability()).status;
      } catch {
        return {
          kind: 'failure',
          error: {
            stage: 'plugin',
            code: 'plugin-unavailable',
            mode: 'local',
          },
        };
      }
      if (status !== 'available') return waiting(status);
      try {
        const response = await plugin.classify({
          dataUrl: input.asset.dataUrl,
          prompt: buildClassificationPrompt(input),
        });
        if (typeof response.text !== 'string') {
          return { kind: 'failure', error: { stage: 'decode', code: 'decode-failed', mode: 'local' } };
        }
        const nativeMode = response.mode === 'structured' || response.mode === 'text' ? response.mode : undefined;
        const raw = extractJsonObject(response.text);
        if (!raw) {
          const rawOutputExcerpt = safeDiagnosticExcerpt(response.text);
          return {
            kind: 'failure',
            error: {
              stage: 'parse',
              code: 'invalid-json',
              mode: 'local',
              ...(nativeMode ? { nativeMode } : {}),
              ...(rawOutputExcerpt ? { rawOutputExcerpt } : {}),
            },
          };
        }
        const draft = parseReferenceClassificationDraft(raw);
        if (!draft) {
          const rawOutputExcerpt = safeDiagnosticExcerpt(response.text);
          return {
            kind: 'failure',
            error: {
              stage: 'validation',
              code: 'invalid-schema',
              mode: 'local',
              ...(nativeMode ? { nativeMode } : {}),
              ...(rawOutputExcerpt ? { rawOutputExcerpt } : {}),
            },
          };
        }
        const validated = validateReferenceClassificationDraft(draft, rosterFrom(input));
        return {
          kind: 'classified',
          classification: validated.classification,
          state: validated.state,
          validationReason: validated.validationReason,
        };
      } catch (error) {
        const wait = runtimeWaiting(error);
        if (wait) return wait;
        const details = nativeErrorDetails(error);
        return {
          kind: 'failure',
          error: {
            stage: 'inference',
            code: 'inference-failed',
            mode: 'local',
            ...(details.nativeCode !== undefined ? { nativeCode: details.nativeCode } : {}),
            ...(details.nativeMode ? { nativeMode: details.nativeMode } : {}),
          },
        };
      }
    },
  };
}

const nativeClassifier = registerPlugin<NativeClassifierPlugin>('LocalReferenceClassifier');

export const localReferenceClassifier = createLocalReferenceClassifier(nativeClassifier);
