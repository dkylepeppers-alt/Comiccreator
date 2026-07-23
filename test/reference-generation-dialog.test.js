// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  defaultSelectedReferenceIds,
  readGenerateReferenceDialog,
  renderGenerateReferenceDialog,
} from '../src/js/reference-generation-dialog.ts';

function makeAsset(overrides = {}) {
  return {
    id: 'ref-1',
    worldId: 'world-1',
    dataUrl: 'data:image/png;base64,AAA',
    subjectType: null,
    use: null,
    characterIds: [],
    locationId: null,
    facets: {},
    description: '',
    confidence: {},
    provenance: { source: 'uploaded', metadata: 'local' },
    classificationState: 'pending',
    acceptedAsIs: false,
    autoUse: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('defaultSelectedReferenceIds', () => {
  it('returns nothing when no character is selected', () => {
    expect(defaultSelectedReferenceIds([makeAsset()], null)).toEqual([]);
  });

  it('prefers auto-use identity references for the character', () => {
    const identity = makeAsset({
      id: 'identity-1',
      subjectType: 'character',
      use: 'identity',
      characterIds: ['char-1'],
    });
    const pose = makeAsset({ id: 'pose-1', subjectType: 'character', use: 'pose', characterIds: ['char-1'] });
    expect(defaultSelectedReferenceIds([pose, identity], 'char-1')).toEqual(['identity-1']);
  });

  it('falls back to any auto-use reference linked to the character (e.g. pending classification)', () => {
    const pending = makeAsset({ id: 'pending-1', characterIds: ['char-1'] });
    const otherCharacter = makeAsset({ id: 'other-1', characterIds: ['char-2'] });
    const manualOff = makeAsset({ id: 'off-1', characterIds: ['char-1'], autoUse: false });
    expect(defaultSelectedReferenceIds([pending, otherCharacter, manualOff], 'char-1')).toEqual(['pending-1']);
  });

  it('caps the default selection at three references', () => {
    const assets = ['a', 'b', 'c', 'd'].map((id) =>
      makeAsset({ id, subjectType: 'character', use: 'identity', characterIds: ['char-1'] }),
    );
    expect(defaultSelectedReferenceIds(assets, 'char-1')).toEqual(['a', 'b', 'c']);
  });
});

describe('renderGenerateReferenceDialog', () => {
  const data = {
    worldName: 'Aether & Co',
    characters: [
      { id: 'char-1', name: 'Mira <Star>' },
      { id: 'char-2', name: 'Bolt' },
    ],
    references: [
      makeAsset({
        id: 'identity-1',
        subjectType: 'character',
        use: 'identity',
        characterIds: ['char-1'],
        description: 'Mira portrait',
      }),
      makeAsset({ id: 'loose-1' }),
    ],
    defaultCharacterId: 'char-1',
  };

  it('renders a character selector with the default character selected and a world option', () => {
    const container = document.createElement('div');
    container.innerHTML = renderGenerateReferenceDialog(data);
    const select = container.querySelector('#generate-ref-character');
    const options = [...select.querySelectorAll('option')];
    expect(options.map((option) => option.value)).toEqual(['', 'char-1', 'char-2']);
    expect(select.value).toBe('char-1');
    expect(options[0].textContent).toContain('Aether & Co');
    expect(options[1].textContent).toBe('Mira <Star>');
  });

  it('renders selectable existing references with defaults pre-checked', () => {
    const container = document.createElement('div');
    container.innerHTML = renderGenerateReferenceDialog(data);
    const boxes = [...container.querySelectorAll('[data-generate-ref-source]')];
    expect(boxes.map((box) => box.value)).toEqual(['identity-1', 'loose-1']);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(container.textContent).toContain('Mira portrait');
  });

  it('mentions prompt-only generation when the world has no references', () => {
    const container = document.createElement('div');
    container.innerHTML = renderGenerateReferenceDialog({ ...data, references: [] });
    expect(container.textContent).toContain('generated from the prompt alone');
  });
});

describe('readGenerateReferenceDialog', () => {
  it('reads the prompt, character, and checked reference ids', () => {
    const container = document.createElement('div');
    container.innerHTML = renderGenerateReferenceDialog({
      worldName: 'World',
      characters: [{ id: 'char-1', name: 'Mira' }],
      references: [makeAsset({ id: 'a', characterIds: ['char-1'] }), makeAsset({ id: 'b' })],
      defaultCharacterId: 'char-1',
    });
    container.querySelector('#generate-ref-prompt').value = '  a heroic pose  ';
    container.querySelector('[data-generate-ref-source][value="b"]').checked = true;
    expect(readGenerateReferenceDialog(container)).toEqual({
      prompt: 'a heroic pose',
      characterId: 'char-1',
      referenceIds: ['a', 'b'],
    });
  });

  it('reports no character when the world option is selected', () => {
    const container = document.createElement('div');
    container.innerHTML = renderGenerateReferenceDialog({
      worldName: 'World',
      characters: [],
      references: [],
    });
    expect(readGenerateReferenceDialog(container)).toEqual({ prompt: '', characterId: null, referenceIds: [] });
  });
});
