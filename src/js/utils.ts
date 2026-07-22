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
  id?: string;
  tag?: string;
  description?: string;
  dataUrl?: string;
  placeId?: string | null;
  variantId?: string | null;
}

/** Generate a stable unique ID for gallery images and other records. */
export function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

/**
 * Ensure every image in a gallery has a stable `id`.
 * Returns { images, changed } — `images` is a new array with new objects only
 * where an id had to be assigned; unchanged objects are reused so callers can
 * cheaply detect whether persistence is needed.
 */
export function ensureImageIds(images: ImageRef[] | null | undefined): { images: ImageRef[]; changed: boolean } {
  if (!Array.isArray(images)) return { images: [], changed: false };
  let changed = false;
  const out = images.map((img) => {
    if (!img) return img;
    if (img.id) return img;
    changed = true;
    return Object.assign({}, img, { id: newId() });
  });
  return { images: out, changed };
}

/**
 * Normalize a user-entered location key: trim, lowercase, spaces → dashes,
 * strip characters outside [a-z0-9-]. Returns '' for empty input.
 */
export function slugifyName(key: string | null | undefined): string {
  if (!key) return '';
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
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

/** Compare two dotted version strings. Returns 1, -1, or 0 (missing segments count as 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Prepare comic pages for JSON export: strip panel imageUrl fields (AI-generated
 * images are large and can be regenerated) without mutating the input objects.
 */
export function prepareExportPages(pages: any[]): any[] {
  return pages.map((p) => {
    const copy = Object.assign({}, p);
    if (copy.data && Array.isArray(copy.data.panels)) {
      copy.data = Object.assign({}, copy.data, {
        panels: copy.data.panels.map((panel: any) => {
          const pc = Object.assign({}, panel);
          delete pc.imageUrl;
          return pc;
        }),
      });
    }
    return copy;
  });
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

/** Contract for SPA page modules consumed by the router in app.ts. */
export interface PageModule {
  render(param?: string | null): string | Promise<string>;
  postRender?(param?: string | null): void;
  onMount?(param?: string | null): Promise<void> | void;
  onUnmount?(): void;
}
