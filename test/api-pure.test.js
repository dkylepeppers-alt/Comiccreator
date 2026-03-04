const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// --- Inline the static fallback lookup from api.js (no DB dependency) ---
const KNOWN_IMAGE_SIZES = {
  'gpt-image-1':          ['1024x1024', '1536x1024', '1024x1536', 'auto'],
  'dall-e-3':             ['1024x1024', '1024x1792', '1792x1024'],
  'dall-e-2':             ['256x256', '512x512', '1024x1024'],
  'gpt-4o-image':         ['1024x1024', '1024x1792', '1792x1024'],
  'flux-pro':             ['1024x1024', '1024x768', '768x1024', '1280x768', '768x1280'],
  'flux-schnell':         ['1024x1024', '1024x768', '768x1024'],
  'flux-kontext':         ['1024x1024', '1024x768', '768x1024'],
  'stable-diffusion-xl':  ['1024x1024', '1024x768', '768x1024'],
  'stable-diffusion-3':   ['1024x1024', '1024x768', '768x1024'],
};

/**
 * Pure, synchronous version of getModelSizes() — only the static fallback path.
 * Used to test the KNOWN_IMAGE_SIZES map and prefix-matching without needing IndexedDB.
 */
function getModelSizesStatic(modelId) {
  if (!modelId) return null;
  if (KNOWN_IMAGE_SIZES[modelId]) return KNOWN_IMAGE_SIZES[modelId];
  for (const [prefix, sizes] of Object.entries(KNOWN_IMAGE_SIZES)) {
    if (modelId.startsWith(prefix)) return sizes;
  }
  return null;
}

function parseComicResponse(text) {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    return {
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
    };
  } catch {
    return null;
  }
}

function buildSystemPrompt(genre, characters, world, customSystemPrompt) {
  const base = customSystemPrompt || `You are a masterful comic book creator specializing in ${genre} stories.`;
  let prompt = `${base}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, just raw JSON.

Your response must be a JSON object with this exact structure:`;
  if (characters && characters.length > 0) {
    prompt += '\n\nCHARACTERS:\n';
    for (const c of characters) {
      prompt += `- ${c.name}: ${c.description}`;
      if (c.role) prompt += ` (Role: ${c.role})`;
      if (c.appearance) prompt += ` | Appearance: ${c.appearance}`;
      prompt += '\n';
    }
  }
  if (world) {
    prompt += `\nWORLD SETTING:\nName: ${world.name}\nDescription: ${world.description}\n`;
    if (world.details) prompt += `Details: ${world.details}\n`;
  }
  return prompt;
}

function compareVersions(a, b) {
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

function extractProvider(model) {
  if (model.owned_by) return model.owned_by;
  const slashIdx = model.id.indexOf('/');
  if (slashIdx > 0) return model.id.substring(0, slashIdx);
  const id = model.id.toLowerCase();
  if (id.startsWith('gpt-') || id.startsWith('chatgpt') || id.startsWith('dall-e') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'OpenAI';
  if (id.startsWith('claude')) return 'Anthropic';
  if (id.startsWith('gemini')) return 'Google';
  if (id.startsWith('llama') || id.startsWith('meta-llama')) return 'Meta';
  if (id.startsWith('mistral') || id.startsWith('codestral') || id.startsWith('pixtral')) return 'Mistral';
  if (id.startsWith('deepseek')) return 'DeepSeek';
  if (id.startsWith('grok')) return 'xAI';
  if (id.startsWith('flux') || id.startsWith('schnell')) return 'Black Forest Labs';
  if (id.startsWith('stable-diffusion') || id.startsWith('sdxl') || id.startsWith('sd3')) return 'Stability AI';
  return 'Other';
}

function buildModelDetails(m) {
  const parts = [];
  if (m.context_length) parts.push(`${(m.context_length / 1000).toFixed(0)}K ctx`);
  if (m.supports_vision) parts.push('vision');
  if (m.supports_tools) parts.push('tools');
  if (m.supports_edit) parts.push('edit');
  if (m.pricing) {
    if (typeof m.pricing === 'object') {
      if (m.pricing.prompt) parts.push(`$${m.pricing.prompt}/1M in`);
    } else if (typeof m.pricing === 'string') {
      parts.push(m.pricing);
    }
  }
  return parts.length > 0 ? parts.join(' &middot; ') : '';
}

describe('api pure parsing and prompt helpers', () => {
  it('parseComicResponse handles valid, fenced, embedded, invalid and defaults', () => {
    assert.equal(parseComicResponse('nope'), null);
    assert.equal(parseComicResponse('{"title":"x","panels":[],"choices":[]}').title, 'x');
    assert.equal(parseComicResponse('```json\n{"title":"fenced","panels":[],"choices":[]}\n```').title, 'fenced');
    assert.equal(parseComicResponse('prefix {"title":"embed","panels":[],"choices":[]} suffix').title, 'embed');
    assert.equal(parseComicResponse('{}').title, 'Untitled Page');
    const alt = parseComicResponse('{"panels":[{"image_prompt":"img"}],"choices":[{"description":"choice"}]}');
    assert.equal(alt.panels[0].imagePrompt, 'img');
    assert.equal(alt.choices[0].text, 'choice');
    assert.deepEqual(parseComicResponse('{"panels":[{}]}').panels[0].dialogue, []);
  });

  it('buildSystemPrompt includes expected sections', () => {
    const p = buildSystemPrompt('superhero', [], null, '');
    assert.ok(p.includes('superhero'));
    assert.ok(p.includes('valid JSON only'));
    assert.ok(!p.includes('CHARACTERS:'));
    const custom = buildSystemPrompt('x', [], null, 'Custom');
    assert.ok(custom.startsWith('Custom'));
    const withAll = buildSystemPrompt('x', [{ name: 'A', description: 'B', role: 'Hero', appearance: 'Cape' }], { name: 'W', description: 'D', details: 'Fog' });
    assert.ok(withAll.includes('CHARACTERS:'));
    assert.ok(withAll.includes('WORLD SETTING:'));
    assert.ok(withAll.includes('Details: Fog'));
  });
});

describe('settings pure helpers', () => {
  it('compareVersions handles semantic comparisons', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
    assert.equal(compareVersions('1.0', '1.0.1'), -1);
    assert.equal(compareVersions('1.4.1', '1.4.0'), 1);
  });

  it('extractProvider applies priority and prefix mapping', () => {
    assert.equal(extractProvider({ id: 'x', owned_by: 'Owned' }), 'Owned');
    assert.equal(extractProvider({ id: 'openai/gpt-4o' }), 'openai');
    assert.equal(extractProvider({ id: 'gpt-4o' }), 'OpenAI');
    assert.equal(extractProvider({ id: 'claude-3' }), 'Anthropic');
    assert.equal(extractProvider({ id: 'gemini-2.0' }), 'Google');
    assert.equal(extractProvider({ id: 'llama-3' }), 'Meta');
    assert.equal(extractProvider({ id: 'mistral-large' }), 'Mistral');
    assert.equal(extractProvider({ id: 'deepseek-chat' }), 'DeepSeek');
    assert.equal(extractProvider({ id: 'grok-2' }), 'xAI');
    assert.equal(extractProvider({ id: 'flux-pro' }), 'Black Forest Labs');
    assert.equal(extractProvider({ id: 'stable-diffusion-xl' }), 'Stability AI');
    assert.equal(extractProvider({ id: 'unknown-model' }), 'Other');
  });

  it('buildModelDetails renders context, capability and pricing fields', () => {
    assert.equal(buildModelDetails({}), '');
    const rich = buildModelDetails({
      context_length: 128000,
      supports_vision: true,
      supports_tools: true,
      supports_edit: true,
      pricing: { prompt: '0.01' },
    });
    assert.ok(rich.includes('128K ctx'));
    assert.ok(rich.includes('vision'));
    assert.ok(rich.includes('tools'));
    assert.ok(rich.includes('edit'));
    assert.ok(rich.includes('$0.01/1M in'));
    assert.equal(buildModelDetails({ pricing: '$0.05 flat' }), '$0.05 flat');
  });
});

describe('api getModelSizes static fallback', () => {
  it('returns null for null/undefined/empty model ID', () => {
    assert.equal(getModelSizesStatic(null), null);
    assert.equal(getModelSizesStatic(undefined), null);
    assert.equal(getModelSizesStatic(''), null);
  });

  it('returns correct sizes for exact known model IDs', () => {
    const sizes = getModelSizesStatic('gpt-image-1');
    assert.ok(Array.isArray(sizes));
    assert.ok(sizes.includes('1024x1024'));
    assert.ok(sizes.includes('1536x1024'));

    const dall3 = getModelSizesStatic('dall-e-3');
    assert.ok(dall3.includes('1024x1024'));
    assert.ok(dall3.includes('1024x1792'));

    const flux = getModelSizesStatic('flux-pro');
    assert.ok(flux.includes('1024x1024'));
    assert.ok(flux.includes('1280x768'));
  });

  it('returns sizes via prefix match for versioned model IDs', () => {
    // "flux-schnell-v2" should match the "flux-schnell" prefix entry
    const sizes = getModelSizesStatic('flux-schnell-v2');
    assert.ok(Array.isArray(sizes));
    assert.deepEqual(sizes, getModelSizesStatic('flux-schnell'));

    // "stable-diffusion-xl-turbo" matches "stable-diffusion-xl"
    const sdxl = getModelSizesStatic('stable-diffusion-xl-turbo');
    assert.ok(Array.isArray(sdxl));
    assert.deepEqual(sdxl, getModelSizesStatic('stable-diffusion-xl'));
  });

  it('returns null for unknown model IDs', () => {
    assert.equal(getModelSizesStatic('midjourney'), null);
    assert.equal(getModelSizesStatic('hidream-i1-full'), null);
    assert.equal(getModelSizesStatic('some-unknown-model'), null);
  });
});
