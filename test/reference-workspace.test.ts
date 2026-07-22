import { describe, expect, it, vi } from 'vitest';
import { createReferenceWorkspace } from '../src/js/reference-workspace.js';
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
    setAutoUse: vi.fn(async () => undefined),
  };
  const queue = {
    acceptAsIs: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    reclassify: vi.fn(async () => undefined),
    pause: vi.fn(),
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
});
