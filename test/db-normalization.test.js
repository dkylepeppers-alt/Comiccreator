import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

const { default: DB } = await import('../src/js/db.js');

describe('normalizeCharacterRecord', () => {
  it('assigns stable IDs to gallery images and picks the primary as anchor', () => {
    const legacy = {
      id: 'c1',
      name: 'Nova',
      images: [
        { dataUrl: 'data:image/png;base64,A', tag: 'default' },
        { dataUrl: 'data:image/png;base64,B', tag: 'close-up' },
      ],
      primaryImageIndex: 1,
    };
    const { record, changed } = DB.normalizeCharacterRecord(legacy);
    expect(changed).toBe(true);
    expect(record.images.every((img) => typeof img.id === 'string' && img.id.length > 0)).toBe(true);
    expect(record.identityAnchorImageId).toBe(record.images[1].id);
    // Original object untouched (pure)
    expect(legacy.images[0].id).toBeUndefined();
  });

  it('migrates legacy single-imageData records', () => {
    const veryOld = { id: 'c2', name: 'Old', imageData: 'data:image/png;base64,OLD' };
    const { record } = DB.normalizeCharacterRecord(veryOld);
    expect(record.images.length).toBe(1);
    expect(record.identityAnchorImageId).toBe(record.images[0].id);
  });

  it('falls back to the first valid image when primary index is invalid', () => {
    const rec = {
      id: 'c3',
      name: 'X',
      images: [{ id: 'i1', dataUrl: 'data:image/png;base64,A' }],
      primaryImageIndex: 9,
    };
    const { record } = DB.normalizeCharacterRecord(rec);
    expect(record.identityAnchorImageId).toBe('i1');
  });

  it('keeps a valid existing anchor and reports unchanged for already-normalized records', () => {
    const rec = {
      id: 'c4',
      name: 'Y',
      images: [
        { id: 'i1', dataUrl: 'data:image/png;base64,A' },
        { id: 'i2', dataUrl: 'data:image/png;base64,B' },
      ],
      primaryImageIndex: 0,
      identityAnchorImageId: 'i2',
    };
    const first = DB.normalizeCharacterRecord(rec);
    expect(first.changed).toBe(false);
    expect(first.record.identityAnchorImageId).toBe('i2');
  });

  it('replaces a dangling anchor ID with a valid fallback', () => {
    const rec = {
      id: 'c5',
      name: 'Z',
      images: [{ id: 'i1', dataUrl: 'data:image/png;base64,A' }],
      primaryImageIndex: 0,
      identityAnchorImageId: 'deleted-image',
    };
    const { record, changed } = DB.normalizeCharacterRecord(rec);
    expect(changed).toBe(true);
    expect(record.identityAnchorImageId).toBe('i1');
  });

  it('yields a null anchor when no valid image exists', () => {
    const { record } = DB.normalizeCharacterRecord({ id: 'c6', name: 'Empty', images: [], primaryImageIndex: 0 });
    expect(record.identityAnchorImageId).toBeNull();
  });
});

describe('normalizeWorldRecord', () => {
  it('migrates legacy string images, assigns IDs, and sets a default anchor', () => {
    const legacy = { id: 'w1', name: 'Town', images: ['data:image/png;base64,A', 'data:image/png;base64,B'] };
    const { record, changed } = DB.normalizeWorldRecord(legacy);
    expect(changed).toBe(true);
    expect(record.images.length).toBe(2);
    expect(record.images.every((img) => img.id)).toBe(true);
    expect(record.defaultAnchorImageId).toBe(record.images[0].id);
  });

  it('normalizes location keys to slug form', () => {
    const rec = {
      id: 'w2',
      name: 'Town',
      images: [{ id: 'i1', dataUrl: 'data:image/png;base64,A', locationKey: 'Main Street!' }],
      primaryImageIndex: 0,
      defaultAnchorImageId: 'i1',
    };
    const { record } = DB.normalizeWorldRecord(rec);
    expect(record.images[0].locationKey).toBe('main-street');
  });
});

describe('commitPageAndComic', () => {
  it('writes page and comic in one transaction', async () => {
    const comicId = `comic-${Date.now()}`;
    const pageId = `page-${Date.now()}`;
    await DB.commitPageAndComic(
      { id: pageId, comicId, pageNum: 1, data: { title: 'P1', panels: [] }, createdAt: 1 },
      { id: comicId, title: 'C', pageCount: 1, visualContinuity: { schemaVersion: 1, characterStates: {}, updatedAt: 1 } },
    );
    const page = await DB.get(DB.STORES.pages, pageId);
    const comic = await DB.get(DB.STORES.comics, comicId);
    expect(page.data.title).toBe('P1');
    expect(comic.visualContinuity.schemaVersion).toBe(1);
  });
});
