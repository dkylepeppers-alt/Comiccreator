// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createReferenceWorkspace, normalizeReferenceEditorSubject } from '../src/js/reference-workspace.js';
import type { ReferenceAsset } from '../src/js/references/types.js';

function asset(overrides: Partial<ReferenceAsset> = {}): ReferenceAsset {
  return {
    id: 'r1',
    worldId: 'w1',
    dataUrl: 'data:image/png;base64,REF',
    subjectType: 'character',
    use: 'identity',
    characterIds: ['mara'],
    locationId: null,
    facets: { viewDirection: 'front' },
    description: 'Mara facing forward',
    confidence: {},
    provenance: { source: 'uploaded', metadata: 'local' },
    classificationState: 'ready',
    acceptedAsIs: false,
    autoUse: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function dependencies(records = [asset()]) {
  const repository = {
    listByWorld: vi.fn(async () => records),
    getAsset: vi.fn(async (id: string) => records.find((record) => record.id === id)),
    putAsset: vi.fn(async (updated: ReferenceAsset) => {
      const index = records.findIndex((record) => record.id === updated.id);
      if (index >= 0) records[index] = updated;
    }),
    deleteAsset: vi.fn(async () => undefined),
    getJobByAsset: vi.fn(async () => undefined),
    putJob: vi.fn(async () => undefined),
    putAssetAndJob: vi.fn(async (updated: ReferenceAsset) => {
      const index = records.findIndex((record) => record.id === updated.id);
      if (index >= 0) records[index] = updated;
    }),
    setAutoUse: vi.fn(async () => undefined),
  };
  const queue = {
    acceptAsIs: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    reclassify: vi.fn(async () => undefined),
    pause: vi.fn(),
    resume: vi.fn(async () => undefined),
    retryAllFailed: vi.fn(async () => 0),
    getProgress: vi.fn(async () => ({
      total: 1,
      pending: 0,
      running: 0,
      complete: 1,
      failed: 0,
      paused: false,
    })),
  };
  return {
    repository,
    queue,
    listCharacters: vi.fn(async () => [{ id: 'mara', name: 'Mara' }]),
    listLocations: vi.fn(async () => []),
  };
}

describe('reference workspace', () => {
  it('renders a simple card and filters child views from the same records', async () => {
    const deps = dependencies();
    const workspace = createReferenceWorkspace(deps);
    const html = await workspace.render({ worldId: 'w1', characterId: 'mara', filter: 'all' });

    expect(html).toContain('Character / Mara / Identity / Front');
    expect(html).toContain('data-action="review-reference"');
    expect(html).toContain('data-action="hide-reference"');
    expect(html).not.toContain('<select');
    expect(deps.repository.listByWorld).toHaveBeenCalledWith('w1');
  });

  it('hides, accepts, retries, and manually reclassifies through canonical commands', async () => {
    const deps = dependencies();
    const workspace = createReferenceWorkspace(deps);

    await workspace.handleAction({ action: 'hide-reference', referenceId: 'r1' });
    await workspace.handleAction({ action: 'accept-reference', referenceId: 'r1' });
    await workspace.handleAction({ action: 'retry-reference', referenceId: 'r1' });
    await workspace.handleAction({ action: 'reclassify-reference', referenceId: 'r1' });

    expect(deps.repository.setAutoUse).toHaveBeenCalledWith('r1', false);
    expect(deps.queue.acceptAsIs).toHaveBeenCalledWith('r1');
    expect(deps.queue.retry).toHaveBeenCalledWith('r1');
    expect(deps.queue.reclassify).toHaveBeenCalledWith('r1');
  });

  it('supports world, character, review, and hidden filters without duplicating records', async () => {
    const deps = dependencies([
      asset(),
      asset({ id: 'r2', subjectType: 'location', use: 'spatial', characterIds: [], locationId: 'yard' }),
      asset({ id: 'r3', classificationState: 'needs-review' }),
      asset({ id: 'r4', autoUse: false }),
    ]);
    const workspace = createReferenceWorkspace(deps);

    expect(await workspace.render({ worldId: 'w1', filter: 'world' })).toContain('data-reference-id="r2"');
    expect(await workspace.render({ worldId: 'w1', filter: 'characters' })).not.toContain('data-reference-id="r2"');
    expect(await workspace.render({ worldId: 'w1', filter: 'needs-review' })).toContain('data-reference-id="r3"');
    expect(await workspace.render({ worldId: 'w1', filter: 'hidden' })).toContain('data-reference-id="r4"');
  });

  it('renders one shared accessible manual editor with world-scoped entities and metadata context', async () => {
    const deps = dependencies([
      asset({
        classificationState: 'could-not-classify',
        proposedCharacterNames: ['Mara Vale'],
        proposedLocationName: 'Old observatory',
      }),
    ]);
    deps.repository.getJobByAsset.mockResolvedValue({
      id: 'j1',
      assetId: 'r1',
      status: 'failed',
      lastError: 'invalid-schema',
    });
    const workspace = createReferenceWorkspace(deps);

    const html = await workspace.renderEditor({ worldId: 'w1', referenceId: 'r1' });

    expect(html).toContain('Manual classification');
    expect(html).toContain('for="reference-subject"');
    expect(html).toContain('for="reference-character-ids"');
    expect(html).toContain('Mara Vale');
    expect(html).toContain('Old observatory');
    expect(html).toContain('Classification source');
    expect(html).toContain('Could not classify: invalid-schema');
    expect(html).toContain('data-action="save-reference-classification"');
    expect(html).toContain('data-action="close-reference-editor"');
  });

  it('saves a valid manual ready classification, clears confidence, and completes its job', async () => {
    const records = [asset({ classificationState: 'needs-review', confidence: { subject: 0.4 } })];
    const deps = dependencies(records);
    deps.repository.getJobByAsset.mockResolvedValue({
      id: 'j1',
      assetId: 'r1',
      worldId: 'w1',
      status: 'failed',
      attemptCount: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const workspace = createReferenceWorkspace(deps);

    await workspace.handleAction({
      action: 'save-reference-classification',
      referenceId: 'r1',
      classification: {
        subjectType: 'character',
        use: 'identity',
        characterIds: ['mara'],
        locationId: 'yard',
        facets: { framing: 'close-up' },
        description: 'Manual identity image',
        proposedCharacterNames: ['Mara Vale'],
      },
    });

    expect(deps.repository.putAssetAndJob).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'character',
        locationId: null,
        provenance: { source: 'uploaded', metadata: 'manual' },
        confidence: {},
        classificationState: 'ready',
      }),
      expect.anything(),
    );
    expect(deps.repository.putAssetAndJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'complete' }),
    );
  });

  it('rejects a ready manual classification that links a non-world character', async () => {
    const deps = dependencies();
    const workspace = createReferenceWorkspace(deps);

    await expect(
      workspace.handleAction({
        action: 'save-reference-classification',
        referenceId: 'r1',
        classification: {
          subjectType: 'interaction',
          use: 'relationship',
          characterIds: ['mara', 'outsider'],
          locationId: null,
          facets: {},
          description: 'Cross-world interaction',
        },
      }),
    ).rejects.toThrow('current-world characters');
    expect(deps.repository.putAsset).not.toHaveBeenCalled();
    expect(deps.repository.putAssetAndJob).not.toHaveBeenCalled();
  });

  it('saves partial manual metadata as a needs-review draft and normalizes subject links', async () => {
    const deps = dependencies();
    const workspace = createReferenceWorkspace(deps);

    await workspace.handleAction({
      action: 'save-reference-draft',
      referenceId: 'r1',
      classification: {
        subjectType: 'style',
        use: 'identity',
        characterIds: ['mara'],
        locationId: 'yard',
        facets: { lighting: 'warm' },
        description: '',
      },
    });

    expect(deps.repository.putAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'style',
        use: null,
        characterIds: [],
        locationId: null,
        classificationState: 'needs-review',
        provenance: { source: 'uploaded', metadata: 'manual' },
      }),
    );
  });

  it('clears subject-incompatible use and entity links when the editor subject changes', () => {
    document.body.innerHTML = `<section data-reference-editor>
      <select name="subjectType"><option value="location">Location</option></select>
      <select name="use"><option value="identity" selected>Identity</option><option value="establishing">Establishing</option></select>
      <select name="characterIds" multiple><option value="mara" selected>Mara</option></select>
      <select name="locationId"><option value="yard" selected>Yard</option></select>
    </section>`;

    normalizeReferenceEditorSubject(document.querySelector('[data-reference-editor]')!);

    expect((document.querySelector('[name="use"]') as HTMLSelectElement).value).toBe('');
    expect((document.querySelector('[name="characterIds"] option') as HTMLOptionElement).selected).toBe(false);
    expect((document.querySelector('[name="locationId"]') as HTMLSelectElement).value).toBe('yard');
  });

  it('requires explicit confirmation before reclassifying manual metadata', async () => {
    const deps = dependencies([asset({ provenance: { source: 'uploaded', metadata: 'manual' } })]);
    const workspace = createReferenceWorkspace(deps);

    await expect(workspace.handleAction({ action: 'reclassify-reference', referenceId: 'r1' })).resolves.toEqual({
      requiresConfirmation: true,
    });
    expect(deps.queue.reclassify).not.toHaveBeenCalled();

    await workspace.handleAction({ action: 'reclassify-reference', referenceId: 'r1', confirmed: true });
    expect(deps.queue.reclassify).toHaveBeenCalledWith('r1');
  });

  it('renders dynamic world-scoped progress, resume, and retry-failed controls without counting failures as processed', async () => {
    const deps = dependencies([
      asset({ id: 'ready', classificationState: 'ready' }),
      asset({ id: 'review', classificationState: 'needs-review' }),
      asset({ id: 'failed', classificationState: 'could-not-classify' }),
      asset({ id: 'queued', classificationState: 'pending' }),
      asset({ id: 'running', classificationState: 'pending' }),
    ]);
    deps.repository.getJobByAsset.mockImplementation(async (id: string) => {
      if (id === 'failed') return { id: 'j-failed', assetId: id, status: 'failed' };
      if (id === 'queued') return { id: 'j-queued', assetId: id, status: 'pending' };
      if (id === 'running') return { id: 'j-running', assetId: id, status: 'running' };
      return { id: `j-${id}`, assetId: id, status: 'complete' };
    });
    deps.queue.getProgress.mockResolvedValue({
      total: 9,
      pending: 4,
      running: 1,
      complete: 3,
      failed: 2,
      paused: true,
    });
    const workspace = createReferenceWorkspace(deps);

    const html = await workspace.render({ worldId: 'w1', filter: 'all' });

    expect(html).toContain('2 / 5 processed');
    expect(html).toContain('1 Ready');
    expect(html).toContain('1 Needs review');
    expect(html).toContain('1 Could not classify');
    expect(html).toContain('1 queued · 1 running');
    expect(html).toContain('>Resume<');
    expect(html).toContain('Retry failed (1)');
    expect(html).toContain('References');
    expect(html).toContain('Reference Library');
    expect(html).not.toContain('Visual evidence');
    expect(html).not.toContain('Reference contact sheet');
  });
});
