import { describe, it, expect } from 'vitest';
import {
  KNOWN_IMAGE_SIZES,
  getModelSizesStatic,
  extractProvider,
  buildModelDetails,
} from '../src/js/model-catalog.js';
import { parseComicResponse } from '../src/js/api-parsing.js';
import { buildSystemPrompt } from '../src/js/prompt-building.js';
import { compareVersions } from '../src/js/utils.js';

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

  it('buildSystemPrompt includes WORLD VISUAL RULES grounding panels in the world', () => {
    const prompt = buildSystemPrompt('action', [], { name: 'Gotham', description: 'A dark city' });
    expect(prompt.includes('WORLD VISUAL RULES:')).toBeTruthy();
    expect(prompt.includes('ground the scene in Gotham')).toBeTruthy();
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
    expect(extractProvider({ id: 'command-r-plus' })).toBe('Cohere');
    expect(extractProvider({ id: 'flux-2-pro' })).toBe('Black Forest Labs');
    expect(extractProvider({ id: 'stable-diffusion-xl' })).toBe('Stability AI');
    expect(extractProvider({ id: 'seedream-v4' })).toBe('ByteDance');
    expect(extractProvider({ id: 'hunyuan-image-3' })).toBe('Tencent');
    expect(extractProvider({ id: 'cogview-4' })).toBe('Zhipu');
    expect(extractProvider({ id: 'glm-image' })).toBe('Zhipu');
    expect(extractProvider({ id: 'kling-image-o1' })).toBe('Kling');
    expect(extractProvider({ id: 'vidu-q2' })).toBe('Vidu');
    expect(extractProvider({ id: 'minimax-image-01' })).toBe('MiniMax');
    expect(extractProvider({ id: 'yi-large' })).toBe('01.AI');
    expect(extractProvider({ id: 'phi-4' })).toBe('Microsoft');
    expect(extractProvider({ id: 'nova-pro' })).toBe('Amazon');
    expect(extractProvider({ id: 'kimi-k2' })).toBe('Moonshot');
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

  it('KNOWN_IMAGE_SIZES entries are all non-empty arrays of size strings', () => {
    for (const [modelId, sizes] of Object.entries(KNOWN_IMAGE_SIZES)) {
      expect(Array.isArray(sizes), `${modelId} should map to an array`).toBeTruthy();
      expect(sizes.length > 0, `${modelId} should have at least one size`).toBeTruthy();
    }
  });
});
