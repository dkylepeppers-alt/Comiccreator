/**
 * Tests for pure functions that can run in Node.js without a browser.
 * Run with: node --test test/
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// --- Load pure functions by extracting them from source files ---

// escHtml — copied from home.js (the string-based version doesn't need DOM)
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// timeAgo — copied from home.js
function timeAgo(ts) {
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

// repairTruncatedJson + parseComicResponse — extracted from api.js
function repairTruncatedJson(str) {
  let s = str.trimEnd();
  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }

  if (inString) s += '"';
  s = s.replace(/,\s*$/, '');
  while (stack.length > 0) s += stack.pop();
  return s;
}

function parseComicResponse(text) {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  const buildResult = parsed => ({
    title: parsed.title || 'Untitled Page',
    panels: (parsed.panels || []).map(p => ({
      narration: p.narration || '',
      imagePrompt: p.imagePrompt || p.image_prompt || '',
      dialogue: (p.dialogue || []).map(d => ({
        speaker: d.speaker || 'Unknown',
        text: d.text || '',
      })),
    })),
    choices: (parsed.choices || []).map(c => ({
      text: c.text || c.description || '',
      summary: c.summary || '',
    })),
  });

  try {
    return buildResult(JSON.parse(jsonStr));
  } catch (e) {
    try {
      return buildResult(JSON.parse(repairTruncatedJson(jsonStr)));
    } catch (_e2) {
      return null;
    }
  }
}

// --- Tests ---

describe('escHtml', () => {
  it('should return empty string for null/undefined', () => {
    assert.equal(escHtml(null), '');
    assert.equal(escHtml(undefined), '');
  });

  it('should return empty string for empty string', () => {
    assert.equal(escHtml(''), '');
  });

  it('should escape HTML special characters', () => {
    assert.equal(escHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should escape ampersands', () => {
    assert.equal(escHtml('foo & bar'), 'foo &amp; bar');
  });

  it('should escape single quotes', () => {
    assert.equal(escHtml("it's"), 'it&#039;s');
  });

  it('should handle numbers by converting to string', () => {
    assert.equal(escHtml(42), '42');
    assert.equal(escHtml(0), '0');
  });

  it('should pass through safe strings unchanged', () => {
    assert.equal(escHtml('Hello World'), 'Hello World');
  });

  it('should handle strings with all special chars', () => {
    assert.equal(escHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#039;');
  });
});

describe('timeAgo', () => {
  it('should return empty string for falsy input', () => {
    assert.equal(timeAgo(0), '');
    assert.equal(timeAgo(null), '');
    assert.equal(timeAgo(undefined), '');
  });

  it('should return "just now" for recent timestamps', () => {
    assert.equal(timeAgo(Date.now()), 'just now');
    assert.equal(timeAgo(Date.now() - 30000), 'just now'); // 30 seconds ago
  });

  it('should return minutes for timestamps under 1 hour', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    assert.equal(timeAgo(fiveMinAgo), '5m ago');
  });

  it('should return hours for timestamps under 1 day', () => {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    assert.equal(timeAgo(threeHoursAgo), '3h ago');
  });

  it('should return days for timestamps under 30 days', () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    assert.equal(timeAgo(fiveDaysAgo), '5d ago');
  });

  it('should return formatted date for timestamps over 30 days', () => {
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const result = timeAgo(sixtyDaysAgo);
    // Should be a locale date string (not relative)
    assert.ok(!result.includes('ago'), `Expected date string, got: ${result}`);
    assert.ok(result.length > 0);
  });
});

describe('parseComicResponse', () => {
  it('should parse valid JSON response', () => {
    const input = JSON.stringify({
      title: 'Test Page',
      panels: [
        {
          narration: 'A dark night...',
          imagePrompt: 'A city at night',
          dialogue: [{ speaker: 'Hero', text: 'I must go.' }],
        },
      ],
      choices: [{ text: 'Go left', summary: 'A dangerous path' }],
    });

    const result = parseComicResponse(input);
    assert.ok(result);
    assert.equal(result.title, 'Test Page');
    assert.equal(result.panels.length, 1);
    assert.equal(result.panels[0].narration, 'A dark night...');
    assert.equal(result.panels[0].dialogue[0].speaker, 'Hero');
    assert.equal(result.choices.length, 1);
    assert.equal(result.choices[0].text, 'Go left');
  });

  it('should handle JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"title":"Fenced","panels":[],"choices":[]}\n```';
    const result = parseComicResponse(input);
    assert.ok(result);
    assert.equal(result.title, 'Fenced');
  });

  it('should handle JSON with surrounding text', () => {
    const input = 'Here is the comic page:\n{"title":"Embedded","panels":[],"choices":[]}\nDone!';
    const result = parseComicResponse(input);
    assert.ok(result);
    assert.equal(result.title, 'Embedded');
  });

  it('should return null for completely invalid input', () => {
    assert.equal(parseComicResponse('not json at all'), null);
  });

  it('should provide defaults for missing fields', () => {
    const input = JSON.stringify({});
    const result = parseComicResponse(input);
    assert.ok(result);
    assert.equal(result.title, 'Untitled Page');
    assert.deepEqual(result.panels, []);
    assert.deepEqual(result.choices, []);
  });

  it('should handle alternative field names (image_prompt)', () => {
    const input = JSON.stringify({
      title: 'Alt Fields',
      panels: [{ image_prompt: 'A sunset scene', narration: '' }],
      choices: [{ description: 'Alternative text' }],
    });
    const result = parseComicResponse(input);
    assert.ok(result);
    assert.equal(result.panels[0].imagePrompt, 'A sunset scene');
    assert.equal(result.choices[0].text, 'Alternative text');
  });

  it('should handle missing dialogue array', () => {
    const input = JSON.stringify({
      panels: [{ narration: 'No dialogue here' }],
    });
    const result = parseComicResponse(input);
    assert.ok(result);
    assert.deepEqual(result.panels[0].dialogue, []);
  });

  it('should recover from truncation after a complete panel object (trailing comma)', () => {
    // Simulates LLM output cut off after a completed panel but before the array closes
    const truncated =
      '{"title":"Page 1","panels":[{"narration":"Scene one.","imagePrompt":"A city","dialogue":[]},';
    const result = parseComicResponse(truncated);
    assert.ok(result, 'should recover truncated JSON');
    assert.equal(result.title, 'Page 1');
    assert.equal(result.panels.length, 1);
    assert.equal(result.panels[0].narration, 'Scene one.');
  });

  it('should recover from truncation mid-string inside a panel', () => {
    // Simulates the exact error from the issue: cut off mid narration string
    const truncated =
      '{"title":"Anthony gets Fester","panels":[{"narration":"As Fester waddles off to the bathroom';
    const result = parseComicResponse(truncated);
    assert.ok(result, 'should recover truncated JSON mid-string');
    assert.equal(result.title, 'Anthony gets Fester');
    assert.equal(result.panels.length, 1);
    assert.ok(result.panels[0].narration.startsWith('As Fester waddles off'));
  });

  it('should recover from truncation with missing outer closing brace', () => {
    // Outer object is never closed
    const truncated = '{"title":"Test","panels":[],"choices":[]';
    const result = parseComicResponse(truncated);
    assert.ok(result, 'should recover missing outer brace');
    assert.equal(result.title, 'Test');
  });
});

// prepareExportPages — extracted from exportData() in settings.js
function prepareExportPages(pages) {
  return pages.map(p => {
    const copy = Object.assign({}, p);
    if (copy.data && Array.isArray(copy.data.panels)) {
      copy.data = Object.assign({}, copy.data, {
        panels: copy.data.panels.map(panel => {
          const panelCopy = Object.assign({}, panel);
          if ('imageUrl' in panelCopy) {
            delete panelCopy.imageUrl;
          }
          return panelCopy;
        }),
      });
    }
    return copy;
  });
}

describe('exportData page preparation', () => {
  it('should strip imageUrl from each panel in each page', () => {
    const pages = [
      {
        id: '1',
        comicId: 'c1',
        pageNum: 1,
        data: {
          panels: [
            { narration: 'Panel 1', imageUrl: 'data:image/png;base64,abc123' },
            { narration: 'Panel 2', imageUrl: 'data:image/png;base64,xyz789' },
          ],
        },
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: '2',
        comicId: 'c1',
        pageNum: 2,
        data: {
          panels: [
            { narration: 'Panel A', imageUrl: 'data:image/png;base64,def456' },
            { narration: 'Panel B' },
          ],
        },
        createdAt: '2024-01-02T00:00:00.000Z',
      },
    ];
    const result = prepareExportPages(pages);
    assert.equal(result.length, 2);
    assert.equal(result[0].data.panels[0].imageUrl, undefined);
    assert.equal(result[0].data.panels[1].imageUrl, undefined);
    assert.equal(result[1].data.panels[0].imageUrl, undefined);
    assert.equal(result[1].data.panels[1].imageUrl, undefined);
  });

  it('should retain all other page fields', () => {
    const pages = [
      {
        id: '1',
        comicId: 'c1',
        pageNum: 1,
        title: 'Page 1',
        data: {
          panels: [
            { narration: 'Test narration', imageUrl: 'data:image/png;base64,abc' },
          ],
          extraMeta: 'meta',
        },
        createdAt: '2024-01-01T12:00:00.000Z',
      },
    ];
    const result = prepareExportPages(pages);
    assert.equal(result[0].id, '1');
    assert.equal(result[0].comicId, 'c1');
    assert.equal(result[0].pageNum, 1);
    assert.equal(result[0].title, 'Page 1');
    assert.equal(result[0].createdAt, '2024-01-01T12:00:00.000Z');
    assert.equal(result[0].data.extraMeta, 'meta');
    assert.deepEqual(result[0].data.panels, [{ narration: 'Test narration' }]);
  });

  it('should not modify pages when panels have no imageUrl', () => {
    const pages = [
      {
        id: '1',
        comicId: 'c1',
        pageNum: 1,
        title: 'Text-only page',
        data: {
          panels: [{ narration: 'Only text' }],
        },
        createdAt: '2024-01-03T00:00:00.000Z',
      },
    ];
    const result = prepareExportPages(pages);
    assert.deepEqual(result[0], pages[0]);
  });

  it('should not mutate the original page objects', () => {
    const original = {
      id: '1',
      comicId: 'c1',
      pageNum: 1,
      data: {
        panels: [
          { narration: 'Panel 1', imageUrl: 'data:image/png;base64,big' },
        ],
      },
      createdAt: '2024-01-04T00:00:00.000Z',
    };
    const pages = [original];
    const result = prepareExportPages(pages);
    assert.equal(original.data.panels[0].imageUrl, 'data:image/png;base64,big');
    assert.equal(result[0].data.panels[0].imageUrl, undefined);
  });

  it('should not use pretty-printed JSON in settings.js exportData', () => {
    const settingsPath = path.join(__dirname, '..', 'js', 'pages', 'settings.js');
    const settingsCode = fs.readFileSync(settingsPath, 'utf-8');
    const stringifyCalls = settingsCode.match(/JSON\.stringify\([^)]*\)/g) || [];
    assert.ok(stringifyCalls.length > 0, 'settings.js must contain at least one JSON.stringify call');
    const prettyPrintedCalls = stringifyCalls.filter(call =>
      /JSON\.stringify\([^)]*,\s*null\s*,\s*\d+\s*\)/.test(call),
    );
    assert.equal(
      prettyPrintedCalls.length,
      0,
      'settings.js must not call JSON.stringify with an indentation argument',
    );
  });
});

describe('version.json', () => {
  it('should have valid version format', () => {
    const versionPath = path.join(__dirname, '..', 'version.json');
    const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    assert.ok(data.version, 'version field must exist');
    assert.match(data.version, /^\d+\.\d+\.\d+$/, 'version must be semver');
    assert.ok(data.updated, 'updated field must exist');
  });

  it('should match APP_VERSION in settings.js', () => {
    const versionPath = path.join(__dirname, '..', 'version.json');
    const { version } = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    const settingsPath = path.join(__dirname, '..', 'js', 'pages', 'settings.js');
    const settingsCode = fs.readFileSync(settingsPath, 'utf-8');
    const match = settingsCode.match(/const APP_VERSION = '([^']+)'/);
    assert.ok(match, 'APP_VERSION must be defined in settings.js');
    assert.equal(match[1], version, 'APP_VERSION must match version.json');
  });

  it('should match CACHE_NAME in sw.js', () => {
    const versionPath = path.join(__dirname, '..', 'version.json');
    const { version } = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
    const swPath = path.join(__dirname, '..', 'sw.js');
    const swCode = fs.readFileSync(swPath, 'utf-8');
    const match = swCode.match(/const CACHE_NAME = '([^']+)'/);
    assert.ok(match, 'CACHE_NAME must be defined in sw.js');
    assert.equal(match[1], `comic-creator-v${version}`, 'CACHE_NAME must match version.json');
  });
});
