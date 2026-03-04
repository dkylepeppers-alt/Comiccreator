const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// --- Inline the static fallback lookup from api.js (no DB dependency) ---
const KNOWN_IMAGE_SIZES = {
  'gpt-image-1':          ['1024x1024', '1536x1024', '1024x1536', 'auto'],
  'gpt-image-1.5':        ['1024x1024', '1536x1024', '1024x1536', 'auto'],
  'gpt-image-1-mini':     ['1024x1024', 'auto'],
  'flux-2-turbo':         ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-flash':         ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-pro':           ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-max':           ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-dev':           ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'flux-2-flex':          ['1024*1024', '1280*720', '720*1280', '1536*1024', '1024*1536'],
  'seedream-v4':          ['1024x1024', '1536x1024', '1024x1536', '2048x2048'],
  'seedream-v3':          ['1024x1024', '1152x896', '896x1152', '1344x768', '768x1344'],
  'nano-banana':          ['auto'],
  'nano-banana-pro':      ['1k', '2k', '4k'],
  'qwen-image':           ['auto', '1024x1024', '512x512', '768x1024', '1024x768'],
  'hunyuan-image-3':      ['auto', '1024x1024', '768x1024', '1024x768', '1024x1536', '1536x1024', '512x512'],
  // Legacy entries retained for backward compatibility
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
  if (id.startsWith('gemini') || id.startsWith('nano-banana')) return 'Google';
  if (id.startsWith('llama') || id.startsWith('meta-llama')) return 'Meta';
  if (id.startsWith('mistral') || id.startsWith('codestral') || id.startsWith('pixtral')) return 'Mistral';
  if (id.startsWith('deepseek')) return 'DeepSeek';
  if (id.startsWith('grok')) return 'xAI';
  if (id.startsWith('qwen') || id.startsWith('wan-') || id.startsWith('z-image')) return 'Alibaba';
  if (id.startsWith('flux') || id.startsWith('schnell')) return 'Black Forest Labs';
  if (id.startsWith('stable-diffusion') || id.startsWith('sdxl') || id.startsWith('sd3')) return 'Stability AI';
  if (id.startsWith('seedream') || id.startsWith('seedvr')) return 'ByteDance';
  if (id.startsWith('hunyuan')) return 'Tencent';
  if (id.startsWith('cogview') || id.startsWith('glm')) return 'Zhipu';
  if (id.startsWith('kling')) return 'Kling';
  if (id.startsWith('vidu')) return 'Vidu';
  if (id.startsWith('minimax')) return 'MiniMax';
  if (id.startsWith('riverflow')) return 'Sourceful';
  if (id.startsWith('lucid')) return 'Leonardo AI';
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
      if (m.pricing.prompt != null) {
        parts.push(`$${m.pricing.prompt}/1M in`);
      } else if (m.pricing.per_image && typeof m.pricing.per_image === 'object') {
        const prices = Object.values(m.pricing.per_image).filter(v => typeof v === 'number');
        if (prices.length > 0) {
          const minPrice = Math.min(...prices);
          parts.push(`$${minPrice}/img`);
        }
      }
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
    assert.equal(extractProvider({ id: 'nano-banana-pro' }), 'Google');
    assert.equal(extractProvider({ id: 'llama-3' }), 'Meta');
    assert.equal(extractProvider({ id: 'mistral-large' }), 'Mistral');
    assert.equal(extractProvider({ id: 'deepseek-chat' }), 'DeepSeek');
    assert.equal(extractProvider({ id: 'grok-2' }), 'xAI');
    assert.equal(extractProvider({ id: 'qwen-image' }), 'Alibaba');
    assert.equal(extractProvider({ id: 'wan-2.6-image-edit' }), 'Alibaba');
    assert.equal(extractProvider({ id: 'z-image-turbo' }), 'Alibaba');
    assert.equal(extractProvider({ id: 'flux-2-pro' }), 'Black Forest Labs');
    assert.equal(extractProvider({ id: 'stable-diffusion-xl' }), 'Stability AI');
    assert.equal(extractProvider({ id: 'seedream-v4' }), 'ByteDance');
    assert.equal(extractProvider({ id: 'hunyuan-image-3' }), 'Tencent');
    assert.equal(extractProvider({ id: 'cogview-4' }), 'Zhipu');
    assert.equal(extractProvider({ id: 'glm-image' }), 'Zhipu');
    assert.equal(extractProvider({ id: 'kling-image-o1' }), 'Kling');
    assert.equal(extractProvider({ id: 'vidu-q2' }), 'Vidu');
    assert.equal(extractProvider({ id: 'minimax-image-01' }), 'MiniMax');
    assert.equal(extractProvider({ id: 'riverflow-2-fast' }), 'Sourceful');
    assert.equal(extractProvider({ id: 'lucid-origin' }), 'Leonardo AI');
    assert.equal(extractProvider({ id: 'unknown-model' }), 'Other');
  });

  it('buildModelDetails renders context, capability and pricing fields', () => {
    assert.equal(buildModelDetails({}), '');
    // Text model with per-million-tokens pricing
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
    // Image model with per_image pricing
    const imgModel = buildModelDetails({
      supports_edit: true,
      pricing: { per_image: { '1024x1024': 0.04, '1024x1536': 0.06, 'auto': 0.04 }, currency: 'USD' },
    });
    assert.ok(imgModel.includes('edit'));
    assert.ok(imgModel.includes('$0.04/img'));
    assert.ok(!imgModel.includes('/1M'));
    // Free/experimental model with pricing.prompt = 0 should still show pricing
    const freeModel = buildModelDetails({ pricing: { prompt: 0 } });
    assert.ok(freeModel.includes('$0/1M in'), 'pricing.prompt of 0 should still be displayed');
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

    const gpt15 = getModelSizesStatic('gpt-image-1.5');
    assert.ok(gpt15.includes('1024x1024'));
    assert.ok(gpt15.includes('auto'));

    const flux2 = getModelSizesStatic('flux-2-turbo');
    assert.ok(flux2.includes('1024*1024'));
    assert.ok(flux2.includes('1280*720'));

    const seedream = getModelSizesStatic('seedream-v4');
    assert.ok(seedream.includes('1024x1024'));
    assert.ok(seedream.includes('2048x2048'));

    // Legacy entries still work
    const dall3 = getModelSizesStatic('dall-e-3');
    assert.ok(dall3.includes('1024x1024'));
    assert.ok(dall3.includes('1024x1792'));

    const fluxLegacy = getModelSizesStatic('flux-pro');
    assert.ok(fluxLegacy.includes('1024x1024'));
    assert.ok(fluxLegacy.includes('1280x768'));
  });

  it('returns sizes via prefix match for versioned model IDs', () => {
    // "flux-2-turbo-image-to-image" should match the "flux-2-turbo" prefix entry
    const sizes = getModelSizesStatic('flux-2-turbo-image-to-image');
    assert.ok(Array.isArray(sizes));
    assert.deepEqual(sizes, getModelSizesStatic('flux-2-turbo'));

    // "seedream-v4.5" matches "seedream-v4" prefix
    const seedream45 = getModelSizesStatic('seedream-v4.5');
    assert.ok(Array.isArray(seedream45));
    assert.deepEqual(seedream45, getModelSizesStatic('seedream-v4'));

    // Legacy: "stable-diffusion-xl-turbo" matches "stable-diffusion-xl"
    const sdxl = getModelSizesStatic('stable-diffusion-xl-turbo');
    assert.ok(Array.isArray(sdxl));
    assert.deepEqual(sdxl, getModelSizesStatic('stable-diffusion-xl'));
  });

  it('returns null for unknown model IDs', () => {
    assert.equal(getModelSizesStatic('midjourney'), null);
    assert.equal(getModelSizesStatic('some-unknown-model'), null);
  });
});
