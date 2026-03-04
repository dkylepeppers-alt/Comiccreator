const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { escHtml, timeAgo, getGenreEmoji, GENRES, dedupeByNameLatest, cosineSimilarity, sanitizeImagePrompt } = require('../js/utils');

describe('utils escHtml', () => {
  it('handles nullish and empty', () => {
    assert.equal(escHtml(null), '');
    assert.equal(escHtml(undefined), '');
    assert.equal(escHtml(''), '');
  });

  it('escapes risky input and symbols', () => {
    assert.equal(escHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.equal(escHtml('foo & bar'), 'foo &amp; bar');
    assert.equal(escHtml("it's"), 'it&#039;s');
    assert.equal(escHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#039;');
  });

  it('handles numbers and already escaped text', () => {
    assert.equal(escHtml(123), '123');
    assert.equal(escHtml('&lt;tag&gt;'), '&amp;lt;tag&amp;gt;');
  });
});

describe('utils timeAgo', () => {
  it('returns empty for falsy timestamp', () => {
    assert.equal(timeAgo(0), '');
    assert.equal(timeAgo(null), '');
  });

  it('formats relative and date buckets', () => {
    assert.equal(timeAgo(Date.now() - 1_000), 'just now');
    assert.equal(timeAgo(Date.now() - 5 * 60_000), '5m ago');
    assert.equal(timeAgo(Date.now() - 2 * 60 * 60_000), '2h ago');
    assert.equal(timeAgo(Date.now() - 7 * 24 * 60 * 60_000), '7d ago');
    assert.ok(!timeAgo(Date.now() - 40 * 24 * 60 * 60_000).includes('ago'));
  });
});

describe('utils genres', () => {
  it('returns emoji by genre and default fallback', () => {
    assert.equal(getGenreEmoji('superhero'), '&#129464;');
    assert.equal(getGenreEmoji('unknown'), '&#128214;');
    assert.equal(getGenreEmoji(null), '&#128214;');
  });

  it('has stable genre metadata', () => {
    assert.equal(GENRES.length, 9);
    assert.equal(GENRES[GENRES.length - 1].id, 'custom');
    assert.equal(new Set(GENRES.map(g => g.id)).size, GENRES.length);
    for (const genre of GENRES) {
      assert.ok(genre.id);
      assert.ok(genre.name);
      assert.ok(genre.emoji);
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
    assert.equal(result.length, 2);
    assert.equal(result[0].id, '2');
    assert.equal(result[1].id, '3');
  });

  it('falls back to id when name is missing', () => {
    const items = [
      { id: 'x', name: '', createdAt: 1 },
      { id: 'y', createdAt: 2 },
    ];
    const result = dedupeByNameLatest(items);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'y');
    assert.equal(result[1].id, 'x');
  });
});

describe('utils cosineSimilarity', () => {
  it('returns 0 for null, empty, or mismatched inputs', () => {
    assert.equal(cosineSimilarity(null, [1, 2]), 0);
    assert.equal(cosineSimilarity([1, 2], null), 0);
    assert.equal(cosineSimilarity([], [1]), 0);
    assert.equal(cosineSimilarity([1], []), 0);
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
  });

  it('returns -1 for opposite vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1)) < 1e-9);
  });

  it('returns 0 for orthogonal vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  });

  it('returns 0 for zero-magnitude vectors', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
    assert.equal(cosineSimilarity([1, 2], [0, 0]), 0);
  });
});

describe('utils sanitizeImagePrompt', () => {
  it('returns falsy input as-is', () => {
    assert.equal(sanitizeImagePrompt(null), null);
    assert.equal(sanitizeImagePrompt(''), '');
    assert.equal(sanitizeImagePrompt(undefined), undefined);
  });

  it('strips quoted dialogue', () => {
    const result = sanitizeImagePrompt('A hero says "I will save you!" in a dark alley.');
    assert.ok(!result.includes('"I will save you!"'));
    assert.ok(result.includes('dark alley'));
  });

  it('strips narrative lead-ins', () => {
    const result = sanitizeImagePrompt('Meanwhile the city crumbles. A hero stands tall.');
    assert.ok(!result.toLowerCase().includes('meanwhile'));
    assert.ok(result.includes('A hero stands tall'));
  });

  it('strips internal states', () => {
    const result = sanitizeImagePrompt('Feeling conflicted about his past. He clenches his fist.');
    assert.ok(!result.toLowerCase().includes('feeling conflicted'));
    assert.ok(result.includes('He clenches his fist'));
  });

  it('strips meta-references', () => {
    const result = sanitizeImagePrompt('The reader sees a vast landscape with mountains.');
    assert.ok(!result.toLowerCase().includes('the reader sees'));
  });

  it('preserves visual descriptors', () => {
    const input = 'A tall warrior in blue armor standing under dramatic lighting.';
    assert.equal(sanitizeImagePrompt(input), input);
  });

  it('falls back to original when sanitization removes everything', () => {
    const input = '"Hello there" "How are you?"';
    const result = sanitizeImagePrompt(input);
    assert.equal(result, input);
  });
});
