import type { ClassificationInput } from './classifier-prompt.js';
import type { ClassificationOutcome } from './types.js';

export type ClassifierBackendName = 'cloud' | 'local';
/** `cloud` is the default: it is multimodal and materially more accurate than Gemini Nano. */
export type ClassifierOrder = 'cloud' | 'local' | 'local-then-cloud';

export interface ClassifierBackend {
  getAvailability(): Promise<{ status: string }>;
  classify(input: ClassificationInput): Promise<ClassificationOutcome>;
}

export interface ClassifierRouterDependencies {
  cloud: ClassifierBackend;
  local: ClassifierBackend;
  getOrder(): Promise<ClassifierOrder>;
}

export interface ClassifierRouter {
  classify(input: ClassificationInput): Promise<ClassificationOutcome>;
}

const ORDERS: Record<ClassifierOrder, ClassifierBackendName[]> = {
  cloud: ['cloud', 'local'],
  local: ['local'],
  'local-then-cloud': ['local', 'cloud'],
};

/**
 * A bad answer is a real result: the backend ran and its output failed validation, so
 * surface it for review instead of laundering it through the weaker backend. Only
 * availability and infrastructure problems justify trying the other one.
 */
function isTerminalFailure(outcome: ClassificationOutcome): boolean {
  return outcome.kind === 'failure' && (outcome.error.stage === 'parse' || outcome.error.stage === 'validation');
}

function waitingFor(status: string): ClassificationOutcome {
  return status === 'downloadable' || status === 'downloading'
    ? { kind: 'waiting', reason: 'model-downloading', retryDelayMs: 30_000 }
    : { kind: 'waiting', reason: 'model-unavailable', retryDelayMs: 60_000 };
}

/**
 * Presents the two classifier backends to the queue as one classifier. The queue is
 * unchanged: it still injects a single `classify(asset)` and reads one outcome.
 */
export function createClassifierRouter(dependencies: ClassifierRouterDependencies): ClassifierRouter {
  return {
    classify: async (input): Promise<ClassificationOutcome> => {
      const order = ORDERS[await dependencies.getOrder()] ?? ORDERS.cloud;
      let deferred: ClassificationOutcome | null = null;

      for (const name of order) {
        const backend = name === 'cloud' ? dependencies.cloud : dependencies.local;
        let status: string;
        try {
          status = (await backend.getAvailability()).status;
        } catch {
          status = 'unavailable';
        }
        if (status !== 'available') {
          deferred = deferred ?? waitingFor(status);
          continue;
        }

        const outcome = await backend.classify(input);
        if (outcome.kind === 'classified' || isTerminalFailure(outcome)) return outcome;
        // Availability or infrastructure trouble: remember it, then try the other backend.
        deferred = deferred ?? outcome;
      }

      return deferred ?? { kind: 'waiting', reason: 'model-unavailable', retryDelayMs: 60_000 };
    },
  };
}
