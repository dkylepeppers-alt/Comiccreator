import { describe, expect, it } from 'vitest';
import { buildDiagnosticExport } from '../src/js/references/diagnostic-privacy.js';

describe('classification diagnostic export', () => {
  it('exports an explicit allowlist without images, prompts, rosters, or unknown fields', () => {
    const payload = buildDiagnosticExport(
      [
        {
          id: 'd1',
          assetId: 'r1',
          worldId: 'w1',
          createdAt: 100,
          queueState: 'failed',
          error: {
            stage: 'parse',
            code: 'invalid-json',
            mode: 'local',
            nativeCode: -105,
            nativeMode: 'structured',
            rawOutputExcerpt: 'safe model fragment',
            message: 'must not be exported',
            prompt: 'private roster',
          },
          dataUrl: 'data:image/png;base64,private',
          unknown: true,
        } as any,
      ],
      new Date('2026-07-23T00:00:00.000Z'),
    );

    expect(payload).toEqual({
      schemaVersion: 1,
      exportedAt: '2026-07-23T00:00:00.000Z',
      diagnostics: [
        {
          id: 'd1',
          assetId: 'r1',
          worldId: 'w1',
          createdAt: 100,
          queueState: 'failed',
          error: {
            stage: 'parse',
            code: 'invalid-json',
            mode: 'local',
            nativeCode: -105,
            nativeMode: 'structured',
          },
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /data:image|private roster|must not be exported|unknown|safe model fragment/,
    );
  });
});
