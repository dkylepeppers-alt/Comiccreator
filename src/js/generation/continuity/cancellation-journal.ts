import type { ContinuityExecutionResult } from './orchestrator.js';

const cancellationResults = new WeakMap<object, ContinuityExecutionResult>();

function errorKey(error: unknown): object | null {
  return (typeof error === 'object' && error !== null) || typeof error === 'function' ? (error as object) : null;
}

export function recordCancellationResult(error: unknown, result: ContinuityExecutionResult): void {
  const key = errorKey(error);
  if (key) cancellationResults.set(key, { ...result, cancelled: true });
}

export function takeCancellationResult(error: unknown): ContinuityExecutionResult | undefined {
  const key = errorKey(error);
  if (!key) return undefined;
  const result = cancellationResults.get(key);
  cancellationResults.delete(key);
  return result;
}
