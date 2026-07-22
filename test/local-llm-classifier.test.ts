import { describe, expect, it } from 'vitest';
import { createLocalLlmClassifier } from '../src/js/local-llm-classifier.js';

const validResponse = JSON.stringify({
  referenceKey: 'battle-armor',
  classifications: {
    viewAngle: 'front',
    framing: 'full-body',
    activity: 'neutral',
    context: 'isolated',
  },
  visualState: {
    wardrobeDescription: 'red battle armor',
    hairState: '',
    carriedItems: [],
    injuries: [],
    temporaryChanges: [],
  },
});

describe('local LLM classifier', () => {
  it('skips availability and classification outside a native platform', async () => {
    let calls = 0;
    const classifier = createLocalLlmClassifier({
      isNative: () => false,
      plugin: {
        systemAvailability: async () => {
          calls++;
          return { status: 'available' as const };
        },
        download: async () => undefined,
        prompt: async () => ({ text: validResponse }),
      },
    });

    await expect(classifier.getAvailability()).resolves.toBe('unsupported');
    await expect(
      classifier.classify({ characterName: 'Mara', imageDescription: 'Mara wears red armor.' }),
    ).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it('requests a short stateless JSON classification when available', async () => {
    const prompts: any[] = [];
    const classifier = createLocalLlmClassifier({
      isNative: () => true,
      plugin: {
        systemAvailability: async () => ({ status: 'available' as const }),
        download: async () => undefined,
        prompt: async (options) => {
          prompts.push(options);
          return { text: validResponse };
        },
      },
    });

    const result = await classifier.classify({
      characterName: 'Mara',
      characterAppearance: 'cropped black hair',
      imageDescription: 'Mara wears red battle armor.',
    });

    expect(result?.referenceKey).toBe('battle-armor');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].sessionId).toBeUndefined();
    expect(prompts[0].options.maximumOutputTokens).toBe(192);
  });

  it('serializes native prompt calls and converts failures to null', async () => {
    let active = 0;
    let maxActive = 0;
    const classifier = createLocalLlmClassifier({
      isNative: () => true,
      plugin: {
        systemAvailability: async () => ({ status: 'available' as const }),
        download: async () => undefined,
        prompt: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
          throw new Error('BUSY');
        },
      },
    });

    const results = await Promise.all([
      classifier.classify({ characterName: 'A', imageDescription: 'one' }),
      classifier.classify({ characterName: 'B', imageDescription: 'two' }),
    ]);
    expect(results).toEqual([null, null]);
    expect(maxActive).toBe(1);
  });
});
