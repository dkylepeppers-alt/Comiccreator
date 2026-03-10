export interface Genre {
  id: string;
  name: string;
  emoji: string;
}

export interface Timestamped {
  id?: string;
  name?: string;
  updatedAt?: number;
  createdAt?: number;
}

export interface ImageRef {
  tag?: string;
  description?: string;
  dataUrl?: string;
  embedding?: number[] | null;
}

export const GENRES: Genre[] = [
  { id: 'classic-horror', name: 'Classic Horror', emoji: '&#128123;' },
  { id: 'superhero', name: 'Superhero Action', emoji: '&#129464;' },
  { id: 'dark-scifi', name: 'Dark Sci-Fi', emoji: '&#128125;' },
  { id: 'high-fantasy', name: 'High Fantasy', emoji: '&#128050;' },
  { id: 'neon-noir', name: 'Neon Noir', emoji: '&#128373;' },
  { id: 'wasteland', name: 'Wasteland', emoji: '&#9762;' },
  { id: 'comedy', name: 'Comedy', emoji: '&#128514;' },
  { id: 'teen-drama', name: 'Teen Drama', emoji: '&#127915;' },
  { id: 'custom', name: 'Custom', emoji: '&#9999;' },
];

export function escHtml(str: unknown): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function getGenreEmoji(genre: string | null | undefined): string {
  const g = GENRES.find((x) => x.id === genre);
  return g ? g.emoji : '&#128214;';
}

export function dedupeByNameLatest(list: Timestamped[]): Timestamped[] {
  if (!Array.isArray(list)) return [];
  const sorted = [...list].sort((a, b) => (b?.updatedAt ?? b?.createdAt ?? 0) - (a?.updatedAt ?? a?.createdAt ?? 0));
  const seen = new Set<string>();
  const unique: Timestamped[] = [];
  for (const item of sorted) {
    const key = (item?.name || '').trim().toLowerCase() || item?.id || '';
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

/**
 * Compute cosine similarity between two numeric arrays.
 * Returns 0 if inputs are null, empty, or mismatched in length.
 */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

/**
 * Strip narrative/story noise from an image prompt so that only
 * visual descriptors (poses, lighting, composition, appearance) remain.
 */
export function sanitizeImagePrompt(rawPrompt: string | null | undefined): string | null | undefined {
  if (!rawPrompt) return rawPrompt;
  let cleaned = rawPrompt;

  // Remove quoted dialogue that leaked in (200 char limit targets dialogue, not visual descriptions)
  cleaned = cleaned.replace(/"[^"]{0,200}"/g, '');
  cleaned = cleaned.replace(/'[^']{0,200}'/g, '');

  // Remove narrative lead-ins and internal states
  const narrativePatterns = [
    /\b(meanwhile|little did (they|he|she|it) know|unbeknownst to|as the story continues|hours? later|the next (morning|day|evening)|moments? (later|before))\b[^.]*\.\s*/gi,
    /\b(thinking about|wondering if|remembering when|feeling (conflicted|torn|uncertain|determined)|pondering|reflecting on)\b[^.]*\.\s*/gi,
    /\b(in this panel|the reader sees|cut to|we see|the scene shifts to)\b[^,.]*/gi,
  ];
  for (const regex of narrativePatterns) {
    cleaned = cleaned.replace(regex, '');
  }

  // Collapse extra whitespace and orphaned punctuation
  cleaned = cleaned
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[,;]\s*/, '')
    .trim();

  if (!cleaned) {
    if (typeof (globalThis as any).App !== 'undefined')
      (globalThis as any).App.logError(
        'sanitizeImagePrompt',
        new Error('Sanitization fallback'),
        `Sanitization removed all content, falling back to original prompt: "${rawPrompt.slice(0, 100)}..."`,
      );
    return rawPrompt;
  }
  return cleaned;
}

/**
 * Build an enriched text string for generating an image's semantic embedding.
 * Prepends the image tag and the owning character/world name to the user-supplied
 * description so the resulting vector is more aligned with panel prompts that
 * reference names and visual contexts.
 *
 * Examples:
 *   buildImageEmbeddingText({tag:'action-pose', description:'Fist raised'}, 'Iron Man')
 *     → "action-pose Iron Man: Fist raised"
 *   buildImageEmbeddingText({tag:'default', description:'Red cape'}, 'Superman')
 *     → "Superman: Red cape"
 *   buildImageEmbeddingText({tag:'interior', description:'Dimly lit lab'}, 'Gotham')
 *     → "interior Gotham: Dimly lit lab"
 */
/** Contract for SPA page modules consumed by the router in app.ts. */
export interface PageModule {
  render(param?: string | null): string | Promise<string>;
  postRender?(param?: string | null): void;
  onMount?(param?: string | null): Promise<void> | void;
  onUnmount?(): void;
}

export function buildImageEmbeddingText(img: ImageRef | null | undefined, contextName: string): string {
  const parts: string[] = [];
  const tag = img?.tag;
  if (tag && tag !== 'default' && tag !== 'establishing' && tag !== 'custom') {
    parts.push(tag);
  }
  const name = (contextName || '').trim();
  if (name) parts.push(name);
  const desc = (img?.description || '').trim();
  if (parts.length > 0 && desc) {
    return `${parts.join(' ')}: ${desc}`;
  }
  return [...parts, desc].filter(Boolean).join(' ') || desc;
}
