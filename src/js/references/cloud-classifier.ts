import { buildClassificationPrompt, extractJsonObject, rosterFrom } from './classifier-prompt.js';
import type { ClassificationInput } from './classifier-prompt.js';
import { safeDiagnosticExcerpt } from './diagnostic-privacy.js';
import { parseReferenceClassificationDraft, validateReferenceClassificationDraft } from './schema.js';
import type { ClassificationOutcome } from './types.js';

export interface CloudClassifierDependencies {
  /** Sends the image plus prompt to a vision-capable model and returns raw text. */
  classifyImage(dataUrl: string, prompt: string): Promise<string | null>;
  /** True when an API key is set and the resolved model is not known to lack vision. */
  isConfigured(): Promise<boolean>;
}

export interface CloudReferenceClassifier {
  getAvailability(): Promise<{ status: 'available' | 'unavailable' }>;
  classify(input: ClassificationInput): Promise<ClassificationOutcome>;
}

/**
 * Recognise transient upstream conditions that deserve a retry rather than a failed job.
 * Rate limits and gateway errors are expected on a shared API and must not burn a retry
 * attempt or push an otherwise-good asset into needs-review.
 */
function transientWait(error: unknown): ClassificationOutcome | null {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|quota/.test(message)) {
    return { kind: 'waiting', reason: 'quota-busy', retryDelayMs: 30_000 };
  }
  if (/\b50[0234]\b|timeout|timed out|network|fetch failed/.test(message)) {
    return { kind: 'waiting', reason: 'quota-busy', retryDelayMs: 15_000 };
  }
  return null;
}

/**
 * The default classifier on both the PWA and Android. It runs entirely in the browser
 * against the configured NanoGPT vision model, so it behaves identically on both
 * platforms and needs no native code.
 */
export function createCloudReferenceClassifier(dependencies: CloudClassifierDependencies): CloudReferenceClassifier {
  const getAvailability = async (): Promise<{ status: 'available' | 'unavailable' }> => {
    try {
      return { status: (await dependencies.isConfigured()) ? 'available' : 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  };

  return {
    getAvailability,
    classify: async (input): Promise<ClassificationOutcome> => {
      if ((await getAvailability()).status !== 'available') {
        return { kind: 'waiting', reason: 'model-unavailable', retryDelayMs: 60_000 };
      }
      let text: string | null;
      try {
        text = await dependencies.classifyImage(input.asset.dataUrl, buildClassificationPrompt(input));
      } catch (error) {
        const wait = transientWait(error);
        if (wait) return wait;
        return { kind: 'failure', error: { stage: 'inference', code: 'inference-failed', mode: 'cloud' } };
      }
      // A null body means the caller declined the request (no key, or a non-vision model),
      // which is a configuration state rather than a bad classification.
      if (text === null) return { kind: 'waiting', reason: 'model-unavailable', retryDelayMs: 60_000 };
      if (typeof text !== 'string') {
        return { kind: 'failure', error: { stage: 'decode', code: 'decode-failed', mode: 'cloud' } };
      }

      const raw = extractJsonObject(text);
      if (!raw) {
        const rawOutputExcerpt = safeDiagnosticExcerpt(text);
        return {
          kind: 'failure',
          error: {
            stage: 'parse',
            code: 'invalid-json',
            mode: 'cloud',
            ...(rawOutputExcerpt ? { rawOutputExcerpt } : {}),
          },
        };
      }
      const draft = parseReferenceClassificationDraft(raw);
      if (!draft) {
        const rawOutputExcerpt = safeDiagnosticExcerpt(text);
        return {
          kind: 'failure',
          error: {
            stage: 'validation',
            code: 'invalid-schema',
            mode: 'cloud',
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
    },
  };
}
