// @vitest-environment node
/**
 * Tests for pure functions that can run in Node.js without a browser.
 * Run with: node --test test/
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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

  if (inString) {
    if (escape) s = s.slice(0, -1);
    s += '"';
  }
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
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('should return empty string for empty string', () => {
    expect(escHtml('')).toBe('');
  });

  it('should escape HTML special characters', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should escape ampersands', () => {
    expect(escHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('should escape single quotes', () => {
    expect(escHtml("it's")).toBe('it&#039;s');
  });

  it('should handle numbers by converting to string', () => {
    expect(escHtml(42)).toBe('42');
    expect(escHtml(0)).toBe('0');
  });

  it('should pass through safe strings unchanged', () => {
    expect(escHtml('Hello World')).toBe('Hello World');
  });

  it('should handle strings with all special chars', () => {
    expect(escHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#039;');
  });
});

describe('timeAgo', () => {
  it('should return empty string for falsy input', () => {
    expect(timeAgo(0)).toBe('');
    expect(timeAgo(null)).toBe('');
    expect(timeAgo(undefined)).toBe('');
  });

  it('should return "just now" for recent timestamps', () => {
    expect(timeAgo(Date.now())).toBe('just now');
    expect(timeAgo(Date.now() - 30000)).toBe('just now'); // 30 seconds ago
  });

  it('should return minutes for timestamps under 1 hour', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    expect(timeAgo(fiveMinAgo)).toBe('5m ago');
  });

  it('should return hours for timestamps under 1 day', () => {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    expect(timeAgo(threeHoursAgo)).toBe('3h ago');
  });

  it('should return days for timestamps under 30 days', () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    expect(timeAgo(fiveDaysAgo)).toBe('5d ago');
  });

  it('should return formatted date for timestamps over 30 days', () => {
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const result = timeAgo(sixtyDaysAgo);
    // Should be a locale date string (not relative)
    expect(!result.includes('ago')).toBeTruthy();
    expect(result.length > 0).toBeTruthy();
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
    expect(result).toBeTruthy();
    expect(result.title).toBe('Test Page');
    expect(result.panels.length).toBe(1);
    expect(result.panels[0].narration).toBe('A dark night...');
    expect(result.panels[0].dialogue[0].speaker).toBe('Hero');
    expect(result.choices.length).toBe(1);
    expect(result.choices[0].text).toBe('Go left');
  });

  it('should handle JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"title":"Fenced","panels":[],"choices":[]}\n```';
    const result = parseComicResponse(input);
    expect(result).toBeTruthy();
    expect(result.title).toBe('Fenced');
  });

  it('should handle JSON with surrounding text', () => {
    const input = 'Here is the comic page:\n{"title":"Embedded","panels":[],"choices":[]}\nDone!';
    const result = parseComicResponse(input);
    expect(result).toBeTruthy();
    expect(result.title).toBe('Embedded');
  });

  it('should return null for completely invalid input', () => {
    expect(parseComicResponse('not json at all')).toBe(null);
  });

  it('should provide defaults for missing fields', () => {
    const input = JSON.stringify({});
    const result = parseComicResponse(input);
    expect(result).toBeTruthy();
    expect(result.title).toBe('Untitled Page');
    expect(result.panels).toEqual([]);
    expect(result.choices).toEqual([]);
  });

  it('should handle alternative field names (image_prompt)', () => {
    const input = JSON.stringify({
      title: 'Alt Fields',
      panels: [{ image_prompt: 'A sunset scene', narration: '' }],
      choices: [{ description: 'Alternative text' }],
    });
    const result = parseComicResponse(input);
    expect(result).toBeTruthy();
    expect(result.panels[0].imagePrompt).toBe('A sunset scene');
    expect(result.choices[0].text).toBe('Alternative text');
  });

  it('should handle missing dialogue array', () => {
    const input = JSON.stringify({
      panels: [{ narration: 'No dialogue here' }],
    });
    const result = parseComicResponse(input);
    expect(result).toBeTruthy();
    expect(result.panels[0].dialogue).toEqual([]);
  });

  it('should recover from truncation after a complete panel object (trailing comma)', () => {
    // Simulates LLM output cut off after a completed panel but before the array closes
    const truncated =
      '{"title":"Page 1","panels":[{"narration":"Scene one.","imagePrompt":"A city","dialogue":[]},';
    const result = parseComicResponse(truncated);
    expect(result).toBeTruthy();
    expect(result.title).toBe('Page 1');
    expect(result.panels.length).toBe(1);
    expect(result.panels[0].narration).toBe('Scene one.');
  });

  it('should recover from truncation mid-string inside a panel', () => {
    // Simulates the exact error from the issue: cut off mid narration string
    const truncated =
      '{"title":"Anthony gets Fester","panels":[{"narration":"As Fester waddles off to the bathroom';
    const result = parseComicResponse(truncated);
    expect(result).toBeTruthy();
    expect(result.title).toBe('Anthony gets Fester');
    expect(result.panels.length).toBe(1);
    expect(result.panels[0].narration.startsWith('As Fester waddles off')).toBeTruthy();
  });

  it('should recover from truncation with missing outer closing brace', () => {
    // Outer object is never closed
    const truncated = '{"title":"Test","panels":[],"choices":[]';
    const result = parseComicResponse(truncated);
    expect(result).toBeTruthy();
    expect(result.title).toBe('Test');
  });

  it('should handle truncation ending on a dangling backslash inside a string', () => {
    // If the LLM output is cut right after a backslash inside a value, the trailing
    // backslash must be dropped so the closing quote is not accidentally escaped.
    const truncated = '{"title":"Anthony\\';
    const result = parseComicResponse(truncated);
    expect(result).toBeTruthy();
    expect(result.title).toBe('Anthony');
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
    expect(result.length).toBe(2);
    expect(result[0].data.panels[0].imageUrl).toBe(undefined);
    expect(result[0].data.panels[1].imageUrl).toBe(undefined);
    expect(result[1].data.panels[0].imageUrl).toBe(undefined);
    expect(result[1].data.panels[1].imageUrl).toBe(undefined);
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
    expect(result[0].id).toBe('1');
    expect(result[0].comicId).toBe('c1');
    expect(result[0].pageNum).toBe(1);
    expect(result[0].title).toBe('Page 1');
    expect(result[0].createdAt).toBe('2024-01-01T12:00:00.000Z');
    expect(result[0].data.extraMeta).toBe('meta');
    expect(result[0].data.panels).toEqual([{ narration: 'Test narration' }]);
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
    expect(result[0]).toEqual(pages[0]);
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
    expect(original.data.panels[0].imageUrl).toBe('data:image/png;base64,big');
    expect(result[0].data.panels[0].imageUrl).toBe(undefined);
  });

  it('should not use pretty-printed JSON in settings.ts exportData', () => {
    const settingsPath = new URL('../src/js/pages/settings.ts', import.meta.url);
    const settingsCode = readFileSync(settingsPath, 'utf-8');
    const stringifyCalls = settingsCode.match(/JSON\.stringify\([^)]*\)/g) || [];
    expect(stringifyCalls.length > 0).toBeTruthy();
    const prettyPrintedCalls = stringifyCalls.filter(call =>
      /JSON\.stringify\([^)]*,\s*null\s*,\s*\d+\s*\)/.test(call),
    );
    expect(prettyPrintedCalls.length).toBe(0);
  });
});

describe('version.json', () => {
  it('should have valid version format', () => {
    const versionPath = new URL('../public/version.json', import.meta.url);
    const data = JSON.parse(readFileSync(versionPath, 'utf-8'));
    expect(data.version).toBeTruthy();
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.updated).toBeTruthy();
  });
});
