const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { escHtml, timeAgo, getGenreEmoji, GENRES, dedupeByNameLatest, renderComicPanels } = require('../js/utils');

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

describe('utils renderComicPanels', () => {
  it('returns empty-page message for missing or empty panels', () => {
    assert.ok(renderComicPanels(null).includes('Empty page'));
    assert.ok(renderComicPanels({}).includes('Empty page'));
    assert.ok(renderComicPanels({ panels: null }).includes('Empty page'));
  });

  it('renders an image tag when imageUrl is present', () => {
    const pageData = { panels: [{ imageUrl: 'http://example.com/img.png', narration: '', dialogue: [] }] };
    const html = renderComicPanels(pageData);
    assert.ok(html.includes('<img'));
    assert.ok(html.includes('http://example.com/img.png'));
  });

  it('renders a placeholder div when only imagePrompt is present', () => {
    const pageData = { panels: [{ imagePrompt: 'A dark city', narration: '', dialogue: [] }] };
    const html = renderComicPanels(pageData);
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('A dark city'));
  });

  it('renders narration and dialogue', () => {
    const pageData = {
      panels: [{
        imageUrl: null,
        narration: 'The night falls.',
        dialogue: [{ speaker: 'Hero', text: 'I must act.' }],
      }],
    };
    const html = renderComicPanels(pageData);
    assert.ok(html.includes('The night falls.'));
    assert.ok(html.includes('Hero'));
    assert.ok(html.includes('I must act.'));
  });

  it('escapes HTML in user content', () => {
    const pageData = {
      panels: [{
        narration: '<script>bad</script>',
        dialogue: [{ speaker: '<b>Villain</b>', text: '"Evil"' }],
      }],
    };
    const html = renderComicPanels(pageData);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<b>'));
  });
});
