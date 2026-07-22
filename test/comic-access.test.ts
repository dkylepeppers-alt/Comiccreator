import { describe, expect, it } from 'vitest';
import { assertComicWritable, isComicReadOnly } from '../src/js/references/comic-access.js';

describe('comic reference access', () => {
  it('rejects mutation for legacy comics', () => {
    expect(() => assertComicWritable({ id: 'old' })).toThrow('This comic is read-only');
    expect(() => assertComicWritable({ id: 'new', referenceSchemaVersion: 2 })).not.toThrow();
  });

  it('does not treat a missing comic as a legacy comic', () => {
    expect(isComicReadOnly(null)).toBe(false);
    expect(isComicReadOnly(undefined)).toBe(false);
    expect(isComicReadOnly({ referenceSchemaVersion: 1 })).toBe(true);
  });
});
