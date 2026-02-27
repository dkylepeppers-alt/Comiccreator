const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

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

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
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
      if (m.pricing.prompt) parts.push(`$${m.pricing.prompt}/1K in`);
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

describe('dataUrlToBlob', () => {
  it('creates blobs with proper mime type', () => {
    const png = dataUrlToBlob('data:image/png;base64,aGVsbG8=');
    assert.equal(png.type, 'image/png');
    const jpg = dataUrlToBlob('data:image/jpeg;base64,aGVsbG8=');
    assert.equal(jpg.type, 'image/jpeg');
    const fallback = dataUrlToBlob('data:;base64,aGVsbG8=');
    assert.equal(fallback.type, 'application/octet-stream');
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
    assert.ok(rich.includes('$0.01/1K in'));
    assert.equal(buildModelDetails({ pricing: '$0.05 flat' }), '$0.05 flat');
  });
});
