// @vitest-environment node
import { describe, it, expect } from 'vitest';

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
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  const buildResult = parsed => ({
    title: parsed.title || 'Untitled Page',
    panels: (parsed.panels || []).map(p => {
      const panel = {
        narration: p.narration || '',
        imagePrompt: p.imagePrompt || p.image_prompt || '',
        dialogue: (p.dialogue || []).map(d => ({
          speaker: d.speaker || 'Unknown',
          text: d.text || '',
        })),
      };
      if (p.imageSize || p.image_size) panel.imageSize = p.imageSize || p.image_size;
      return panel;
    }),
    choices: (parsed.choices || []).map(c => ({
      text: c.text || c.description || '',
      summary: c.summary || '',
    })),
  });
  try {
    return buildResult(JSON.parse(jsonStr));
  } catch {
    try {
      return buildResult(JSON.parse(repairTruncatedJson(jsonStr)));
    } catch {
      return null;
    }
  }
}

function buildSystemPrompt(genre, characters, world, customSystemPrompt, options) {
  const base = customSystemPrompt || `You are a masterful comic book creator specializing in ${genre} stories.`;
  const imageSizes = options?.imageSizes;
  const hasDynamicSizes = Array.isArray(imageSizes) && imageSizes.length > 1;
  const includeAppearance = options?.includeAppearanceText !== false;
  const imageStylePreset = options?.imageStylePreset || '';

  const artStyleDirective = imageStylePreset
    ? imageStylePreset
    : '[art style keywords matching the story genre]';
  const artStyleExamples = imageStylePreset
    ? `art style (use: ${imageStylePreset})`
    : 'art style (comic book illustration, bold ink lines, cel shading, halftone texture, watercolor, photorealistic — pick the style that fits the story)';

  const panelExample = hasDynamicSizes
    ? `{
      "narration": "Scene-setting narration text (optional)",
      "imagePrompt": "${artStyleDirective}, [shot type], [lighting], [composition] — describe the scene, characters, action",
      "imageSize": "one of the supported sizes listed below",
      "dialogue": [
        { "speaker": "Character Name", "text": "What they say" }
      ]
    }`
    : `{
      "narration": "Scene-setting narration text (optional)",
      "imagePrompt": "${artStyleDirective}, [shot type], [lighting], [composition] — describe the scene, characters, action",
      "dialogue": [
        { "speaker": "Character Name", "text": "What they say" }
      ]
    }`;

  let prompt = `${base}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, just raw JSON.

Your response must be a JSON object with this exact structure:
{
  "title": "Page title",
  "panels": [
    ${panelExample}
  ],
  "choices": [
    { "text": "Choice description for the reader", "summary": "Brief consequence summary" }
  ]
}

Generate 3-4 panels per page. Each panel needs:
- A vivid imagePrompt describing the visual scene using technical art direction language. Specify: shot type (wide establishing shot, medium shot, close-up portrait, over-the-shoulder, Dutch angle), lighting (rim lighting, dramatic side-lighting, chiaroscuro, soft diffused light, hard shadows), ${artStyleExamples}, composition (rule of thirds, foreground/midground/background layers, dynamic diagonal composition), and color mood (desaturated, high contrast, warm palette, etc.).${imageStylePreset ? ` IMPORTANT: Every imagePrompt MUST begin with "${imageStylePreset}" as the art style prefix.` : ''}${includeAppearance ? ' Include each character\'s physical appearance details (clothing, hair, build, distinguishing features) so the image generator maintains visual consistency.' : ''}
- Optional narration for scene-setting
- Character dialogue that advances the story

CRITICAL: In each panel's "imagePrompt", you MUST explicitly name every character
who appears in that panel.${includeAppearance
    ? ` Include their full physical appearance description
inline. Do NOT just say "the hero" — say "Nova (tall woman with silver hair,
black armor, glowing blue eyes)". This is essential for visual consistency.`
    : ` Describe their actions, poses, and the scene composition.
Reference images will be provided for visual consistency, so you do not need
to repeat full appearance descriptions — but always use character names.`}
If a panel has NO characters (e.g., establishing shot), say "No characters present."

Provide 2-3 meaningful choices at the end that affect the story direction.`;
  if (hasDynamicSizes) {
    prompt += `\n\nIMAGE SIZES:
For each panel, choose the most appropriate image size from these supported values: ${imageSizes.join(', ')}
Set the "imageSize" field in each panel object. Pick sizes that best match the composition:
- Use landscape/wide sizes for panoramic scenes, establishing shots, or action sequences
- Use portrait/tall sizes for character close-ups, vertical compositions, or tall structures
- Use square sizes for balanced scenes, dialogue-focused panels, or group shots
Vary the sizes across panels to create a visually dynamic comic layout.`;
  }
  if (characters && characters.length > 0) {
    prompt += '\n\nCHARACTERS:\n';
    for (const c of characters) {
      prompt += `- ${c.name}: ${c.description}`;
      if (c.role) prompt += ` (Role: ${c.role})`;
      if (c.appearance && includeAppearance) prompt += `\n  APPEARANCE: ${c.appearance}`;
      if (c.powers) prompt += `\n  Abilities: ${c.powers}`;
      prompt += '\n';
    }
    if (includeAppearance) {
      prompt += `\nVISUAL CONSISTENCY RULES:
- EVERY panel's "imagePrompt" must repeat each visible character's full appearance (hair color/style, build, outfit, distinguishing marks). Never abbreviate or omit details between panels.
- Use the exact character name and appearance text from the CHARACTERS list above so the image generator can match reference images.
- Keep each character's outfit, proportions, and features identical across all panels unless the story explicitly calls for a change (e.g., transformation, costume swap).`;
    } else {
      prompt += `\nVISUAL CONSISTENCY RULES:
- In each panel's "imagePrompt", name every visible character and describe their actions, poses, and the scene. Reference images will be provided to the image generator for visual consistency.
- Keep each character's outfit, proportions, and features identical across all panels unless the story explicitly calls for a change (e.g., transformation, costume swap).`;
    }
  }
  if (world) {
    prompt += `\nWORLD SETTING:\nName: ${world.name}\nDescription: ${world.description}\n`;
    if (world.details) prompt += `Details: ${world.details}\n`;
    if (world.atmosphere) prompt += `Atmosphere: ${world.atmosphere}\n`;
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
    expect(parseComicResponse('nope')).toBe(null);
    expect(parseComicResponse('{"title":"x","panels":[],"choices":[]}').title).toBe('x');
    expect(parseComicResponse('```json\n{"title":"fenced","panels":[],"choices":[]}\n```').title).toBe('fenced');
    expect(parseComicResponse('prefix {"title":"embed","panels":[],"choices":[]} suffix').title).toBe('embed');
    expect(parseComicResponse('{}').title).toBe('Untitled Page');
    const alt = parseComicResponse('{"panels":[{"image_prompt":"img"}],"choices":[{"description":"choice"}]}');
    expect(alt.panels[0].imagePrompt).toBe('img');
    expect(alt.choices[0].text).toBe('choice');
    expect(parseComicResponse('{"panels":[{}]}').panels[0].dialogue).toEqual([]);
  });

  it('parseComicResponse extracts imageSize from panels when present', () => {
    const withSize = parseComicResponse('{"panels":[{"imagePrompt":"scene","imageSize":"1024x1536"}],"choices":[]}');
    expect(withSize.panels[0].imageSize).toBe('1024x1536');

    // Also accepts image_size (snake_case alternative)
    const snakeCase = parseComicResponse('{"panels":[{"imagePrompt":"scene","image_size":"1536x1024"}],"choices":[]}');
    expect(snakeCase.panels[0].imageSize).toBe('1536x1024');

    // imageSize is omitted when not present in source
    const noSize = parseComicResponse('{"panels":[{"imagePrompt":"scene"}],"choices":[]}');
    expect(noSize.panels[0].imageSize).toBe(undefined);
  });

  it('buildSystemPrompt includes expected sections', () => {
    const p = buildSystemPrompt('superhero', [], null, '');
    expect(p.includes('superhero')).toBeTruthy();
    expect(p.includes('valid JSON only')).toBeTruthy();
    expect(!p.includes('CHARACTERS:')).toBeTruthy();
    const custom = buildSystemPrompt('x', [], null, 'Custom');
    expect(custom.startsWith('Custom')).toBeTruthy();
    const withAll = buildSystemPrompt('x', [{ name: 'A', description: 'B', role: 'Hero', appearance: 'Cape' }], { name: 'W', description: 'D', details: 'Fog' });
    expect(withAll.includes('CHARACTERS:')).toBeTruthy();
    expect(withAll.includes('WORLD SETTING:')).toBeTruthy();
    expect(withAll.includes('Details: Fog')).toBeTruthy();
  });

  it('buildSystemPrompt includes VISUAL CONSISTENCY RULES when characters have appearance', () => {
    const prompt = buildSystemPrompt('action', [{ name: 'Nova', description: 'A hero', role: 'hero', appearance: 'Silver hair, black armor' }], null);
    expect(prompt.includes('VISUAL CONSISTENCY RULES:')).toBeTruthy();
    expect(prompt.includes('APPEARANCE: Silver hair, black armor')).toBeTruthy();
    expect(prompt.includes('identical across all panels')).toBeTruthy();
  });

  it('buildSystemPrompt includes VISUAL CONSISTENCY RULES even for characters without appearance', () => {
    const prompt = buildSystemPrompt('action', [{ name: 'Bob', description: 'A sidekick' }], null);
    expect(prompt.includes('CHARACTERS:')).toBeTruthy();
    expect(prompt.includes('VISUAL CONSISTENCY RULES:')).toBeTruthy();
    expect(!prompt.includes('APPEARANCE:')).toBeTruthy();
  });

  it('buildSystemPrompt omits VISUAL CONSISTENCY RULES when no characters provided', () => {
    const noChars = buildSystemPrompt('action', [], null);
    expect(!noChars.includes('VISUAL CONSISTENCY RULES:')).toBeTruthy();
    expect(!noChars.includes('CHARACTERS:')).toBeTruthy();
  });

  it('buildSystemPrompt includes world atmosphere when provided', () => {
    const prompt = buildSystemPrompt('action', [], { name: 'Gotham', description: 'A dark city', atmosphere: 'Gritty noir' });
    expect(prompt.includes('Atmosphere: Gritty noir')).toBeTruthy();
  });

  it('buildSystemPrompt includes IMAGE SIZES section when imageSizes option has multiple entries', () => {
    const sizes = ['1024x1024', '1536x1024', '1024x1536'];
    const prompt = buildSystemPrompt('action', [], null, null, { imageSizes: sizes });
    expect(prompt.includes('IMAGE SIZES:')).toBeTruthy();
    expect(prompt.includes('1024x1024')).toBeTruthy();
    expect(prompt.includes('1536x1024')).toBeTruthy();
    expect(prompt.includes('1024x1536')).toBeTruthy();
    expect(prompt.includes('"imageSize"')).toBeTruthy();
    expect(prompt.includes('landscape')).toBeTruthy();
    expect(prompt.includes('portrait')).toBeTruthy();
  });

  it('buildSystemPrompt omits IMAGE SIZES when imageSizes is missing, empty, or single-entry', () => {
    // No options
    const noOpts = buildSystemPrompt('action', [], null, null);
    expect(!noOpts.includes('IMAGE SIZES:')).toBeTruthy();

    // Empty array
    const emptyArr = buildSystemPrompt('action', [], null, null, { imageSizes: [] });
    expect(!emptyArr.includes('IMAGE SIZES:')).toBeTruthy();

    // Single-entry array (no benefit to picking)
    const singleArr = buildSystemPrompt('action', [], null, null, { imageSizes: ['1024x1024'] });
    expect(!singleArr.includes('IMAGE SIZES:')).toBeTruthy();
  });

  it('buildSystemPrompt omits APPEARANCE when includeAppearanceText is false', () => {
    const chars = [{ name: 'Nova', description: 'A hero', role: 'hero', appearance: 'Silver hair, black armor' }];
    const prompt = buildSystemPrompt('action', chars, null, null, { includeAppearanceText: false });
    expect(prompt.includes('CHARACTERS:')).toBeTruthy();
    expect(!prompt.includes('APPEARANCE: Silver hair, black armor')).toBeTruthy();
    expect(prompt.includes('VISUAL CONSISTENCY RULES:')).toBeTruthy();
    expect(prompt.includes('Reference images will be provided')).toBeTruthy();
    expect(!prompt.includes('repeat each visible character')).toBeTruthy();
    expect(prompt.includes('name every visible character')).toBeTruthy();
  });

  it('buildSystemPrompt includes APPEARANCE by default when includeAppearanceText is not specified', () => {
    const chars = [{ name: 'Nova', description: 'A hero', appearance: 'Silver hair' }];
    const prompt = buildSystemPrompt('action', chars, null, null);
    expect(prompt.includes('APPEARANCE: Silver hair')).toBeTruthy();
    expect(prompt.includes('repeat each visible character')).toBeTruthy();
  });

  it('buildSystemPrompt includes APPEARANCE when includeAppearanceText is true', () => {
    const chars = [{ name: 'Nova', description: 'A hero', appearance: 'Silver hair' }];
    const prompt = buildSystemPrompt('action', chars, null, null, { includeAppearanceText: true });
    expect(prompt.includes('APPEARANCE: Silver hair')).toBeTruthy();
  });

  it('buildSystemPrompt uses imageStylePreset in prompt instead of hardcoded comic book illustration', () => {
    const preset = 'watercolor painting, soft edges, gentle color washes, artistic';
    const prompt = buildSystemPrompt('action', [], null, null, { imageStylePreset: preset });
    expect(prompt.includes(preset)).toBeTruthy();
    expect(!prompt.toLowerCase().includes('comic book illustration')).toBeTruthy();
    expect(prompt.includes(`art style (use: ${preset})`)).toBeTruthy();
    expect(prompt.includes(`MUST begin with "${preset}"`)).toBeTruthy();
  });

  it('buildSystemPrompt uses generic art style examples when no imageStylePreset is provided', () => {
    const prompt = buildSystemPrompt('action', [], null, null);
    expect(prompt.includes('pick the style that fits the story')).toBeTruthy();
    expect(prompt.includes('[art style keywords matching the story genre]')).toBeTruthy();
    expect(!prompt.includes('MUST begin with')).toBeTruthy();
  });

  it('buildSystemPrompt imageStylePreset works with dynamic image sizes', () => {
    const preset = 'anime style, manga art, cel shading';
    const sizes = ['1024x1024', '1536x1024'];
    const prompt = buildSystemPrompt('action', [], null, null, { imageStylePreset: preset, imageSizes: sizes });
    expect(prompt.includes(preset)).toBeTruthy();
    expect(prompt.includes('IMAGE SIZES:')).toBeTruthy();
    expect(prompt.includes('"imageSize"')).toBeTruthy();
    expect(!prompt.toLowerCase().includes('comic book illustration')).toBeTruthy();
  });
});

describe('settings pure helpers', () => {
  it('compareVersions handles semantic comparisons', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.4.1', '1.4.0')).toBe(1);
  });

  it('extractProvider applies priority and prefix mapping', () => {
    expect(extractProvider({ id: 'x', owned_by: 'Owned' })).toBe('Owned');
    expect(extractProvider({ id: 'openai/gpt-4o' })).toBe('openai');
    expect(extractProvider({ id: 'gpt-4o' })).toBe('OpenAI');
    expect(extractProvider({ id: 'claude-3' })).toBe('Anthropic');
    expect(extractProvider({ id: 'gemini-2.0' })).toBe('Google');
    expect(extractProvider({ id: 'nano-banana-pro' })).toBe('Google');
    expect(extractProvider({ id: 'llama-3' })).toBe('Meta');
    expect(extractProvider({ id: 'mistral-large' })).toBe('Mistral');
    expect(extractProvider({ id: 'deepseek-chat' })).toBe('DeepSeek');
    expect(extractProvider({ id: 'grok-2' })).toBe('xAI');
    expect(extractProvider({ id: 'qwen-image' })).toBe('Alibaba');
    expect(extractProvider({ id: 'wan-2.6-image-edit' })).toBe('Alibaba');
    expect(extractProvider({ id: 'z-image-turbo' })).toBe('Alibaba');
    expect(extractProvider({ id: 'flux-2-pro' })).toBe('Black Forest Labs');
    expect(extractProvider({ id: 'stable-diffusion-xl' })).toBe('Stability AI');
    expect(extractProvider({ id: 'seedream-v4' })).toBe('ByteDance');
    expect(extractProvider({ id: 'hunyuan-image-3' })).toBe('Tencent');
    expect(extractProvider({ id: 'cogview-4' })).toBe('Zhipu');
    expect(extractProvider({ id: 'glm-image' })).toBe('Zhipu');
    expect(extractProvider({ id: 'kling-image-o1' })).toBe('Kling');
    expect(extractProvider({ id: 'vidu-q2' })).toBe('Vidu');
    expect(extractProvider({ id: 'minimax-image-01' })).toBe('MiniMax');
    expect(extractProvider({ id: 'riverflow-2-fast' })).toBe('Sourceful');
    expect(extractProvider({ id: 'lucid-origin' })).toBe('Leonardo AI');
    expect(extractProvider({ id: 'unknown-model' })).toBe('Other');
  });

  it('buildModelDetails renders context, capability and pricing fields', () => {
    expect(buildModelDetails({})).toBe('');
    // Text model with per-million-tokens pricing
    const rich = buildModelDetails({
      context_length: 128000,
      supports_vision: true,
      supports_tools: true,
      supports_edit: true,
      pricing: { prompt: '0.01' },
    });
    expect(rich.includes('128K ctx')).toBeTruthy();
    expect(rich.includes('vision')).toBeTruthy();
    expect(rich.includes('tools')).toBeTruthy();
    expect(rich.includes('edit')).toBeTruthy();
    expect(rich.includes('$0.01/1M in')).toBeTruthy();
    expect(buildModelDetails({ pricing: '$0.05 flat' })).toBe('$0.05 flat');
    // Image model with per_image pricing
    const imgModel = buildModelDetails({
      supports_edit: true,
      pricing: { per_image: { '1024x1024': 0.04, '1024x1536': 0.06, 'auto': 0.04 }, currency: 'USD' },
    });
    expect(imgModel.includes('edit')).toBeTruthy();
    expect(imgModel.includes('$0.04/img')).toBeTruthy();
    expect(!imgModel.includes('/1M')).toBeTruthy();
    // Free/experimental model with pricing.prompt = 0 should still show pricing
    const freeModel = buildModelDetails({ pricing: { prompt: 0 } });
    expect(freeModel.includes('$0/1M in')).toBeTruthy();
  });
});

describe('api getModelSizes static fallback', () => {
  it('returns null for null/undefined/empty model ID', () => {
    expect(getModelSizesStatic(null)).toBe(null);
    expect(getModelSizesStatic(undefined)).toBe(null);
    expect(getModelSizesStatic('')).toBe(null);
  });

  it('returns correct sizes for exact known model IDs', () => {
    const sizes = getModelSizesStatic('gpt-image-1');
    expect(Array.isArray(sizes)).toBeTruthy();
    expect(sizes.includes('1024x1024')).toBeTruthy();
    expect(sizes.includes('1536x1024')).toBeTruthy();

    const gpt15 = getModelSizesStatic('gpt-image-1.5');
    expect(gpt15.includes('1024x1024')).toBeTruthy();
    expect(gpt15.includes('auto')).toBeTruthy();

    const flux2 = getModelSizesStatic('flux-2-turbo');
    expect(flux2.includes('1024*1024')).toBeTruthy();
    expect(flux2.includes('1280*720')).toBeTruthy();

    const seedream = getModelSizesStatic('seedream-v4');
    expect(seedream.includes('1024x1024')).toBeTruthy();
    expect(seedream.includes('2048x2048')).toBeTruthy();

    // Legacy entries still work
    const dall3 = getModelSizesStatic('dall-e-3');
    expect(dall3.includes('1024x1024')).toBeTruthy();
    expect(dall3.includes('1024x1792')).toBeTruthy();

    const fluxLegacy = getModelSizesStatic('flux-pro');
    expect(fluxLegacy.includes('1024x1024')).toBeTruthy();
    expect(fluxLegacy.includes('1280x768')).toBeTruthy();
  });

  it('returns sizes via prefix match for versioned model IDs', () => {
    // "flux-2-turbo-image-to-image" should match the "flux-2-turbo" prefix entry
    const sizes = getModelSizesStatic('flux-2-turbo-image-to-image');
    expect(Array.isArray(sizes)).toBeTruthy();
    expect(sizes).toEqual(getModelSizesStatic('flux-2-turbo'));

    // "seedream-v4.5" matches "seedream-v4" prefix
    const seedream45 = getModelSizesStatic('seedream-v4.5');
    expect(Array.isArray(seedream45)).toBeTruthy();
    expect(seedream45).toEqual(getModelSizesStatic('seedream-v4'));

    // Legacy: "stable-diffusion-xl-turbo" matches "stable-diffusion-xl"
    const sdxl = getModelSizesStatic('stable-diffusion-xl-turbo');
    expect(Array.isArray(sdxl)).toBeTruthy();
    expect(sdxl).toEqual(getModelSizesStatic('stable-diffusion-xl'));
  });

  it('returns null for unknown model IDs', () => {
    expect(getModelSizesStatic('midjourney')).toBe(null);
    expect(getModelSizesStatic('some-unknown-model')).toBe(null);
  });
});
