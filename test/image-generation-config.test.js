import {
  migrateCompanionSettings,
  resolveCompanionModel,
  selectCompatibleImageSize,
} from '../src/js/image-generation-config.ts';

const model = (id, sizes = ['1920x1920']) => ({ id, name: id, owned_by: '', sizes });

describe('image generation config', () => {
  it('migrates old blank and configured companion settings', () => {
    expect(migrateCompanionSettings(undefined, '')).toEqual({ mode: 'auto', configuredModelId: '', migrated: true });
    expect(migrateCompanionSettings(undefined, 'custom-model')).toEqual({
      mode: 'custom',
      configuredModelId: 'custom-model',
      migrated: true,
    });
  });

  it('maps Seedream Sequential to the standard companion in auto mode', () => {
    expect(
      resolveCompanionModel({
        pageModelId: 'seedream-v4.5-sequential',
        mode: 'auto',
        models: [model('seedream-v4.5-sequential'), model('seedream-v4.5')],
      }),
    ).toEqual({ modelId: 'seedream-v4.5' });
  });

  it('fails a missing custom companion and safely falls back when auto is unavailable', () => {
    const models = [model('seedream-v4.5-sequential')];
    expect(
      resolveCompanionModel({
        pageModelId: 'seedream-v4.5-sequential',
        mode: 'custom',
        configuredModelId: 'missing',
        models,
      }),
    ).toMatchObject({ error: expect.stringMatching(/not available/), errorCode: 'unavailable' });
    expect(
      resolveCompanionModel({ pageModelId: 'seedream-v4.5-sequential', mode: 'custom', configuredModelId: '', models }),
    ).toMatchObject({ modelId: 'seedream-v4.5-sequential', errorCode: 'blank-custom' });
    expect(resolveCompanionModel({ pageModelId: 'seedream-v4.5-sequential', mode: 'auto', models })).toMatchObject({
      modelId: 'seedream-v4.5-sequential',
      warning: expect.any(String),
    });
  });

  it('ignores companion settings for page models without an auto-companion mapping', () => {
    const models = [model('gpt-image-1')];
    expect(
      resolveCompanionModel({ pageModelId: 'gpt-image-1', mode: 'custom', configuredModelId: 'stale-model', models }),
    ).toEqual({ modelId: 'gpt-image-1' });
    expect(
      resolveCompanionModel({ pageModelId: 'gpt-image-1', mode: 'custom', configuredModelId: '', models }),
    ).toEqual({ modelId: 'gpt-image-1' });
  });

  it('prefers 1920x1920 from the common supported sizes', () => {
    expect(
      selectCompatibleImageSize({
        savedSize: '1024x1024',
        pageModel: model('page', ['2048x2048', '1920x1920']),
        companionModel: model('single', ['1920x1920', '1024x1024']),
        sequentialEnabled: true,
      }),
    ).toMatchObject({ size: '1920x1920', corrected: true, sequentialEnabled: true });
  });

  it('disables sequential for the attempt when model sizes do not intersect', () => {
    expect(
      selectCompatibleImageSize({
        savedSize: '1024x1024',
        pageModel: model('page', ['2048x2048']),
        companionModel: model('single', ['1024x1024']),
        sequentialEnabled: true,
      }),
    ).toMatchObject({ size: '1024x1024', corrected: false, sequentialEnabled: false, warning: expect.any(String) });
  });
});
