import { describe, expect, it } from 'vitest';
import {
  applyReferenceClassification,
  migrateCharacterReferenceMetadata,
  normalizeReferenceKey,
  parseReferenceClassification,
} from '../src/js/reference-metadata.js';

describe('reference key normalization', () => {
  it('normalizes keys with the same slug rules as location keys', () => {
    expect(normalizeReferenceKey('  Battle Armor / Front  ')).toBe('battle-armor-front');
  });
});

describe('legacy character reference migration', () => {
  it('maps legacy tags to unique keys and structured facets idempotently', () => {
    const images = [
      { id: 'a', dataUrl: 'a', tag: 'default' },
      { id: 'b', dataUrl: 'b', tag: 'action-pose' },
      { id: 'c', dataUrl: 'c', tag: 'action-pose' },
      { id: 'd', dataUrl: 'd', tag: 'character-sheet' },
    ];

    const first = migrateCharacterReferenceMetadata(images);
    expect(first.changed).toBe(true);
    expect(first.images.map((image) => image.referenceKey)).toEqual([
      null,
      'action-pose',
      'action-pose-2',
      'character-sheet',
    ]);
    expect(first.images[1].referenceClassifications?.activity).toBe('action');
    expect(first.images[3].referenceClassifications?.framing).toBe('character-sheet');
    expect(first.images[1].referenceKeySource).toBe('legacy');

    const second = migrateCharacterReferenceMetadata(first.images);
    expect(second.changed).toBe(false);
    expect(second.images).toBe(first.images);
  });
});

describe('local classification parsing', () => {
  it('accepts fenced JSON, normalizes the key, and validates controlled facets', () => {
    const parsed = parseReferenceClassification(`\`\`\`json
{"referenceKey":"Battle Armor Front","classifications":{"viewAngle":"front","framing":"full-body","activity":"action","context":"isolated"},"visualState":{"wardrobeDescription":"red battle armor","hairState":"braided","carriedItems":["sword"],"injuries":[],"temporaryChanges":[]}}
\`\`\``);

    expect(parsed?.referenceKey).toBe('battle-armor-front');
    expect(parsed?.classifications.viewAngle).toBe('front');
    expect(parsed?.visualState.carriedItems).toEqual(['sword']);
  });

  it('rejects malformed or out-of-taxonomy output', () => {
    expect(parseReferenceClassification('not json')).toBeNull();
    expect(
      parseReferenceClassification(
        '{"referenceKey":"armor","classifications":{"viewAngle":"diagonal","framing":"full-body","activity":"action","context":"isolated"},"visualState":{}}',
      ),
    ).toBeNull();
  });
});

describe('applying local reference metadata', () => {
  const classification = parseReferenceClassification(
    '{"referenceKey":"battle armor","classifications":{"viewAngle":"front","framing":"full-body","activity":"action","context":"isolated"},"visualState":{"wardrobeDescription":"red battle armor","hairState":"braided","carriedItems":["sword"],"injuries":[],"temporaryChanges":[]}}',
  )!;

  it('makes the key unique and seeds locally managed defaults from the identity anchor', () => {
    const character = {
      id: 'c1',
      identityAnchorImageId: 'anchor',
      images: [
        { id: 'other', referenceKey: 'battle-armor' },
        { id: 'anchor', referenceKey: null, referenceKeySource: 'legacy' },
      ],
      defaultVisualState: {},
    };
    const result = applyReferenceClassification(character, 'anchor', classification);
    expect(result.changed).toBe(true);
    expect(result.record.images[1].referenceKey).toBe('battle-armor-2');
    expect(result.record.defaultVisualState.wardrobeDescription).toBe('red battle armor');
    expect(result.record.defaultVisualStateSources.wardrobeDescription).toBe('local');
  });

  it('never overwrites manually managed character defaults', () => {
    const character = {
      id: 'c1',
      identityAnchorImageId: 'anchor',
      images: [{ id: 'anchor', referenceKey: null }],
      defaultVisualState: { wardrobeDescription: 'user outfit' },
      defaultVisualStateSources: { wardrobeDescription: 'manual' },
    };
    const result = applyReferenceClassification(character, 'anchor', classification);
    expect(result.record.defaultVisualState.wardrobeDescription).toBe('user outfit');
    expect(result.record.defaultVisualStateSources.wardrobeDescription).toBe('manual');
  });
});
