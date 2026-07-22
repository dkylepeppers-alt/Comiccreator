import { describe, it, expect } from 'vitest';
import * as Utils from '../src/js/utils.js';
import {
  escHtml,
  timeAgo,
  getGenreEmoji,
  GENRES,
  dedupeByNameLatest,
  cosineSimilarity,
  sanitizeImagePrompt,
} from '../src/js/utils.js';

describe('utils escHtml', () => {
  it('handles nullish and empty', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
    expect(escHtml('')).toBe('');
  });

  it('escapes risky input and symbols', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escHtml('foo & bar')).toBe('foo &amp; bar');
    expect(escHtml("it's")).toBe('it&#039;s');
    expect(escHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#039;');
  });

  it('handles numbers and already escaped text', () => {
    expect(escHtml(123)).toBe('123');
    expect(escHtml('&lt;tag&gt;')).toBe('&amp;lt;tag&amp;gt;');
  });
});

describe('utils timeAgo', () => {
  it('returns empty for falsy timestamp', () => {
    expect(timeAgo(0)).toBe('');
    expect(timeAgo(null)).toBe('');
  });

  it('formats relative and date buckets', () => {
    expect(timeAgo(Date.now() - 1_000)).toBe('just now');
    expect(timeAgo(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(Date.now() - 2 * 60 * 60_000)).toBe('2h ago');
    expect(timeAgo(Date.now() - 7 * 24 * 60 * 60_000)).toBe('7d ago');
    expect(timeAgo(Date.now() - 40 * 24 * 60 * 60_000).includes('ago')).toBeFalsy();
  });
});

describe('utils genres', () => {
  it('returns emoji by genre and default fallback', () => {
    expect(getGenreEmoji('superhero')).toBe('&#129464;');
    expect(getGenreEmoji('unknown')).toBe('&#128214;');
    expect(getGenreEmoji(null)).toBe('&#128214;');
  });

  it('has stable genre metadata', () => {
    expect(GENRES.length).toBe(9);
    expect(GENRES[GENRES.length - 1].id).toBe('custom');
    expect(new Set(GENRES.map((g) => g.id)).size).toBe(GENRES.length);
    for (const genre of GENRES) {
      expect(genre.id).toBeTruthy();
      expect(genre.name).toBeTruthy();
      expect(genre.emoji).toBeTruthy();
    }
  });
});

describe('utils dedupeByNameLatest', () => {
  it('removes duplicate names and keeps the most recent entry', () => {
    const items = [
      { id: '1', name: 'Alpha', createdAt: 1 },
      { id: '2', name: 'alpha', updatedAt: 10 },
      { id: '3', name: 'Beta', createdAt: 5 },
    ];
    const result = dedupeByNameLatest(items);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe('2');
    expect(result[1].id).toBe('3');
  });

  it('falls back to id when name is missing', () => {
    const items = [
      { id: 'x', name: '', createdAt: 1 },
      { id: 'y', createdAt: 2 },
    ];
    const result = dedupeByNameLatest(items);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe('y');
    expect(result[1].id).toBe('x');
  });
});

describe('utils cosineSimilarity', () => {
  it('returns 0 for null, empty, or mismatched inputs', () => {
    expect(cosineSimilarity(null, [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], null)).toBe(0);
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(cosineSimilarity([1], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9).toBeTruthy();
  });

  it('returns -1 for opposite vectors', () => {
    expect(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9).toBeTruthy();
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9).toBeTruthy();
  });

  it('returns 0 for zero-magnitude vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });
});

describe('utils sanitizeImagePrompt', () => {
  it('returns falsy input as-is', () => {
    expect(sanitizeImagePrompt(null)).toBe(null);
    expect(sanitizeImagePrompt('')).toBe('');
    expect(sanitizeImagePrompt(undefined)).toBe(undefined);
  });

  it('strips quoted dialogue', () => {
    const result = sanitizeImagePrompt('A hero says "I will save you!" in a dark alley.');
    expect(!result.includes('"I will save you!"')).toBeTruthy();
    expect(result.includes('dark alley')).toBeTruthy();
  });

  it('strips narrative lead-ins', () => {
    const result = sanitizeImagePrompt('Meanwhile the city crumbles. A hero stands tall.');
    expect(!result.toLowerCase().includes('meanwhile')).toBeTruthy();
    expect(result.includes('A hero stands tall')).toBeTruthy();
  });

  it('strips internal states', () => {
    const result = sanitizeImagePrompt('Feeling conflicted about his past. He clenches his fist.');
    expect(!result.toLowerCase().includes('feeling conflicted')).toBeTruthy();
    expect(result.includes('He clenches his fist')).toBeTruthy();
  });

  it('strips meta-references', () => {
    const result = sanitizeImagePrompt('The reader sees a vast landscape with mountains.');
    expect(!result.toLowerCase().includes('the reader sees')).toBeTruthy();
  });

  it('preserves visual descriptors', () => {
    const input = 'A tall warrior in blue armor standing under dramatic lighting.';
    expect(sanitizeImagePrompt(input)).toBe(input);
  });

  it('falls back to original when sanitization removes everything', () => {
    const input = '"Hello there" "How are you?"';
    const result = sanitizeImagePrompt(input);
    expect(result).toBe(input);
  });
});

describe('removed embedding helpers', () => {
  it('exports no image embedding text helper', () => {
    expect(Utils.buildImageEmbeddingText).toBeUndefined();
  });
});
