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
