import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

const { default: DB } = await import('../src/js/db.js');

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
    await DB.put(DB.STORES.comics, { id: comicId, title: 'C', pageCount: 1, referenceSchemaVersion: 2 });

    // Whichever of these two transactions IndexedDB happens to run first,
    // neither the comic nor the page it writes should survive both settling —
    // either the write sees the comic already gone and discards itself, or
    // the delete's page-deletion cursor sweeps up the page the write just landed.
    await Promise.all([
      DB.commitPageAndComic(
        { id: pageId, comicId, pageNum: 2, data: { title: 'P2', panels: [] }, createdAt: 1 },
        { id: comicId, title: 'C', pageCount: 2, referenceSchemaVersion: 2 },
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
    await DB.put(DB.STORES.comics, { id: comicId, title: 'C', pageCount: 0, referenceSchemaVersion: 2 });
    const committed = await DB.commitPageAndComic(
      { id: pageId, comicId, pageNum: 1, data: { title: 'P1', panels: [] }, createdAt: 1 },
      {
        id: comicId,
        title: 'C',
        pageCount: 1,
        referenceSchemaVersion: 2,
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

  it('rejects page and comic writes for read-only comics', async () => {
    const comicId = `comic-legacy-${Date.now()}`;
    await DB.put(DB.STORES.comics, { id: comicId, title: 'Legacy', referenceSchemaVersion: 1 });
    await expect(
      DB.commitPageAndComic(
        { id: `${comicId}-p1`, comicId, data: {} },
        { id: comicId, title: 'Legacy', referenceSchemaVersion: 1 },
      ),
    ).rejects.toThrow('This comic is read-only');
    expect(await DB.get(DB.STORES.pages, `${comicId}-p1`)).toBeUndefined();
  });
});

describe('putPageIfComicExists', () => {
  it('writes the page and bumps the comic updatedAt when touchComic is true', async () => {
    const comicId = `comic-touch-${Date.now()}`;
    const pageId = `page-touch-${Date.now()}`;
    await DB.put(DB.STORES.comics, { id: comicId, title: 'C', updatedAt: 1, referenceSchemaVersion: 2 });
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

  it('rejects page writes for read-only comics', async () => {
    const comicId = `comic-legacy-page-${Date.now()}`;
    await DB.put(DB.STORES.comics, { id: comicId, title: 'Legacy', referenceSchemaVersion: 1 });
    await expect(DB.putPageIfComicExists({ id: `${comicId}-p1`, comicId, data: {} }, comicId)).rejects.toThrow(
      'This comic is read-only',
    );
  });
});
