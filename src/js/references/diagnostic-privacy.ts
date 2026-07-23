import type { ClassificationDiagnostic } from './types.js';

const MAX_DIAGNOSTIC_EXCERPT_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export function truncateUtf8(value: string, maxBytes = MAX_DIAGNOSTIC_EXCERPT_BYTES): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return strictDecoder.decode(bytes.slice(0, end));
    } catch {
      // Move back only as far as needed to avoid splitting a UTF-8 code point.
    }
  }
  return '';
}

export function safeDiagnosticExcerpt(value: string | undefined): string | undefined {
  const excerpt = value?.trim();
  if (!excerpt || /data:|\b(?:prompt|roster|world|characters|locations)\b/i.test(excerpt)) return undefined;
  return truncateUtf8(excerpt);
}

/** Build an explicitly requested, local-only diagnostic export using a strict field allowlist. */
export function buildDiagnosticExport(diagnostics: readonly ClassificationDiagnostic[], exportedAt = new Date()) {
  return {
    schemaVersion: 1 as const,
    exportedAt: exportedAt.toISOString(),
    diagnostics: diagnostics.map((diagnostic) => ({
      id: diagnostic.id,
      assetId: diagnostic.assetId,
      worldId: diagnostic.worldId,
      createdAt: diagnostic.createdAt,
      ...(diagnostic.queueState ? { queueState: diagnostic.queueState } : {}),
      error: {
        stage: diagnostic.error.stage,
        code: diagnostic.error.code,
        ...(diagnostic.error.mode ? { mode: diagnostic.error.mode } : {}),
        ...(diagnostic.error.retryDelayMs !== undefined ? { retryDelayMs: diagnostic.error.retryDelayMs } : {}),
        ...(diagnostic.error.nativeCode !== undefined ? { nativeCode: diagnostic.error.nativeCode } : {}),
        ...(diagnostic.error.nativeMode ? { nativeMode: diagnostic.error.nativeMode } : {}),
        ...(diagnostic.error.validationReason ? { validationReason: diagnostic.error.validationReason } : {}),
        ...(diagnostic.error.queueState ? { queueState: diagnostic.error.queueState } : {}),
      },
    })),
  };
}
