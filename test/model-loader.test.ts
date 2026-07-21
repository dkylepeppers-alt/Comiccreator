import { describe, expect, it, vi } from 'vitest';
import { loadModelCatalog, type ModelLoaderDependencies } from '../src/js/settings/model-loader.js';
import type { TextModel, ImageModel } from '../src/js/model-catalog.js';

const FALLBACK_TEXT_IDS = ['fallback-text-a', 'fallback-text-b'] as const;
const FALLBACK_IMAGE_IDS = ['fallback-image-a', 'fallback-image-b'] as const;

function makeDependencies(overrides: Partial<ModelLoaderDependencies> = {}): ModelLoaderDependencies {
  return {
    fetchText: vi.fn().mockResolvedValue([]),
    fetchImage: vi.fn().mockResolvedValue([]),
    fallbackTextModelIds: FALLBACK_TEXT_IDS,
    fallbackImageModelIds: FALLBACK_IMAGE_IDS,
    ...overrides,
  };
}

describe('loadModelCatalog', () => {
  it('returns fetched text models and derives the vision-capable caption subset', async () => {
    const textModels: TextModel[] = [
      { id: 'a', name: 'A', owned_by: 'x', supports_vision: true },
      { id: 'b', name: 'B', owned_by: 'x', supports_vision: false },
      { id: 'c', name: 'C', owned_by: 'x' }, // undefined supports_vision -> treated as caption-capable
    ];
    const dependencies = makeDependencies({ fetchText: vi.fn().mockResolvedValue(textModels) });

    const result = await loadModelCatalog('text', false, dependencies);

    expect(result.models).toEqual(textModels);
    expect(result.captionModels).toEqual([textModels[0], textModels[2]]);
    expect(result.usedFallback).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns fetched image models with no caption models', async () => {
    const imageModels: ImageModel[] = [{ id: 'img-a', name: 'Img A', owned_by: 'y' }];
    const dependencies = makeDependencies({ fetchImage: vi.fn().mockResolvedValue(imageModels) });

    const result = await loadModelCatalog('image', false, dependencies);

    expect(result.models).toEqual(imageModels);
    expect(result.captionModels).toEqual([]);
    expect(result.usedFallback).toBe(false);
  });

  it('forwards forceRefresh=true to fetchText', async () => {
    const fetchText = vi.fn().mockResolvedValue([]);
    const dependencies = makeDependencies({ fetchText });

    await loadModelCatalog('text', true, dependencies);

    expect(fetchText).toHaveBeenCalledWith(true);
  });

  it('forwards forceRefresh=true to fetchImage', async () => {
    const fetchImage = vi.fn().mockResolvedValue([]);
    const dependencies = makeDependencies({ fetchImage });

    await loadModelCatalog('image', true, dependencies);

    expect(fetchImage).toHaveBeenCalledWith(true);
  });

  it('forwards forceRefresh=false explicitly', async () => {
    const fetchText = vi.fn().mockResolvedValue([]);
    const dependencies = makeDependencies({ fetchText });

    await loadModelCatalog('text', false, dependencies);

    expect(fetchText).toHaveBeenCalledWith(false);
  });

  it('falls back to normalized text model records when fetchText rejects, treating all as caption-capable', async () => {
    const error = new Error('network down');
    const dependencies = makeDependencies({ fetchText: vi.fn().mockRejectedValue(error) });

    const result = await loadModelCatalog('text', false, dependencies);

    const expectedFallback = [
      { id: 'fallback-text-a', name: 'fallback-text-a', owned_by: '' },
      { id: 'fallback-text-b', name: 'fallback-text-b', owned_by: '' },
    ];
    expect(result.models).toEqual(expectedFallback);
    expect(result.captionModels).toEqual(expectedFallback);
    expect(result.usedFallback).toBe(true);
    expect(result.error).toBe(error);
  });

  it('falls back to normalized image model records when fetchImage rejects, with no caption models', async () => {
    const error = new Error('server error');
    const dependencies = makeDependencies({ fetchImage: vi.fn().mockRejectedValue(error) });

    const result = await loadModelCatalog('image', false, dependencies);

    const expectedFallback = [
      { id: 'fallback-image-a', name: 'fallback-image-a', owned_by: '' },
      { id: 'fallback-image-b', name: 'fallback-image-b', owned_by: '' },
    ];
    expect(result.models).toEqual(expectedFallback);
    expect(result.captionModels).toEqual([]);
    expect(result.usedFallback).toBe(true);
    expect(result.error).toBe(error);
  });

  it('preserves the exact caught error value (non-Error thrown values too)', async () => {
    const dependencies = makeDependencies({ fetchImage: vi.fn().mockRejectedValue('stringy failure') });

    const result = await loadModelCatalog('image', false, dependencies);

    expect(result.error).toBe('stringy failure');
    expect(result.usedFallback).toBe(true);
  });
});
