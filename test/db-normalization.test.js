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

describe('deleteComicAndPages', () => {
  it('deletes the comic and all of its pages', async () => {
    const comicId = `comic-del-${Date.now()}`;
    await DB.put(DB.STORES.comics, { id: comicId, title: 'C' });
    await DB.put(DB.STORES.pages, { id: `${comicId}-p1`, comicId, pageNum: 1, data: {} });
    await DB.put(DB.STORES.pages, { id: `${comicId}-p2`, comicId, pageNum: 2, data: {} });

    await DB.deleteComicAndPages(comicId);

    expect(await DB.get(DB.STORES.comics, comicId)).toBeUndefined();
    expect(await DB.getByIndex(DB.STORES.pages, 'comicId', comicId)).toEqual([]);
  });

  it('never leaves an orphaned page when it races a concurrent background write', async () => {
    const comicId = `comic-race-${Date.now()}`;
    const pageId = `page-race-${Date.now()}`;
    await DB.put(DB.STORES.comics, { id: comicId, title: 'C', pageCount: 1 });

    // Whichever of these two transactions IndexedDB happens to run first,
    // neither the comic nor the page it writes should survive both settling —
    // either the write sees the comic already gone and discards itself, or
    // the delete's page-deletion cursor sweeps up the page the write just landed.
    await Promise.all([
      DB.commitPageAndComic(
        { id: pageId, comicId, pageNum: 2, data: { title: 'P2', panels: [] }, createdAt: 1 },
        { id: comicId, title: 'C', pageCount: 2 },
      ),
      DB.deleteComicAndPages(comicId),
    ]);

    expect(await DB.get(DB.STORES.comics, comicId)).toBeUndefined();
    expect(await DB.get(DB.STORES.pages, pageId)).toBeUndefined();
  });
});

describe('commitPageAndComic', () => {
  it('writes page and comic in one transaction when the comic exists', async () => {
    const comicId = `comic-${Date.now()}`;
    const pageId = `page-${Date.now()}`;
    await DB.put(DB.STORES.comics, { id: comicId, title: 'C', pageCount: 0 });
    const committed = await DB.commitPageAndComic(
      { id: pageId, comicId, pageNum: 1, data: { title: 'P1', panels: [] }, createdAt: 1 },
      {
        id: comicId,
        title: 'C',
        pageCount: 1,
        visualContinuity: { schemaVersion: 1, characterStates: {}, updatedAt: 1 },
      },
    );
    expect(committed).toBe(true);
    const page = await DB.get(DB.STORES.pages, pageId);
    const comic = await DB.get(DB.STORES.comics, comicId);
    expect(page.data.title).toBe('P1');
    expect(comic.visualContinuity.schemaVersion).toBe(1);
  });

  it('writes nothing and resolves false when the comic no longer exists', async () => {
    const comicId = `comic-deleted-${Date.now()}`;
    const pageId = `page-deleted-${Date.now()}`;
    const committed = await DB.commitPageAndComic(
      { id: pageId, comicId, pageNum: 1, data: { title: 'Orphan', panels: [] }, createdAt: 1 },
      { id: comicId, title: 'C', pageCount: 1 },
    );
    expect(committed).toBe(false);
    expect(await DB.get(DB.STORES.pages, pageId)).toBeUndefined();
    expect(await DB.get(DB.STORES.comics, comicId)).toBeUndefined();
  });
});

describe('putPageIfComicExists', () => {
  it('writes the page and bumps the comic updatedAt when touchComic is true', async () => {
    const comicId = `comic-touch-${Date.now()}`;
    const pageId = `page-touch-${Date.now()}`;
    await DB.put(DB.STORES.comics, { id: comicId, title: 'C', updatedAt: 1 });
    const committed = await DB.putPageIfComicExists(
      { id: pageId, comicId, pageNum: 1, data: { title: 'P1', panels: [] }, createdAt: 1 },
      comicId,
      true,
    );
    expect(committed).toBe(true);
    const page = await DB.get(DB.STORES.pages, pageId);
    const comic = await DB.get(DB.STORES.comics, comicId);
    expect(page.data.title).toBe('P1');
    expect(comic.updatedAt).toBeGreaterThan(1);
  });

  it('writes nothing and resolves false when the comic no longer exists', async () => {
    const comicId = `comic-gone-${Date.now()}`;
    const pageId = `page-gone-${Date.now()}`;
    const committed = await DB.putPageIfComicExists(
      { id: pageId, comicId, pageNum: 1, data: { title: 'Orphan', panels: [] }, createdAt: 1 },
      comicId,
    );
    expect(committed).toBe(false);
    expect(await DB.get(DB.STORES.pages, pageId)).toBeUndefined();
  });
});
