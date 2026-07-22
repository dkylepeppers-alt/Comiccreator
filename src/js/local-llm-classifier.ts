import { Capacitor } from '@capacitor/core';
import { LocalLLM } from '@capacitor/local-llm';
import { parseReferenceClassification } from './reference-metadata.js';
import type { ReferenceClassification } from './reference-metadata.js';

export type LocalClassifierAvailability = 'unsupported' | 'available' | 'unavailable' | 'notready' | 'downloadable';

export interface CharacterReferenceClassificationInput {
  characterName: string;
  characterAppearance?: string;
  imageDescription?: string;
  generationPrompt?: string;
  legacyTag?: string;
}

interface LocalLlmPluginLike {
  systemAvailability(): Promise<{ status: 'available' | 'unavailable' | 'notready' | 'downloadable' }>;
  download(): Promise<void>;
  prompt(options: {
    prompt: string;
    instructions?: string;
    options?: { temperature?: number; maximumOutputTokens?: number };
  }): Promise<{ text: string }>;
}

interface ClassifierDependencies {
  isNative: () => boolean;
  plugin: LocalLlmPluginLike;
}

const INSTRUCTIONS = `Classify a comic character reference from text metadata. Return raw JSON only with:
{"referenceKey":"short semantic kebab-case image key","classifications":{"viewAngle":"front|side|back|three-quarter|multiple|unspecified","framing":"close-up|medium|full-body|character-sheet|unspecified","activity":"neutral|action|expression|interaction|unspecified","context":"isolated|in-world|unspecified"},"visualState":{"wardrobeDescription":"","hairState":"","carriedItems":[],"injuries":[],"temporaryChanges":[]}}.
Use only facts in the input. Use empty strings/arrays or unspecified when unknown.`;

export function createLocalLlmClassifier(dependencies: ClassifierDependencies) {
  let queue: Promise<unknown> = Promise.resolve();

  async function getAvailability(): Promise<LocalClassifierAvailability> {
    if (!dependencies.isNative()) return 'unsupported';
    try {
      return (await dependencies.plugin.systemAvailability()).status;
    } catch {
      return 'unavailable';
    }
  }

  async function download(): Promise<boolean> {
    if (!dependencies.isNative()) return false;
    try {
      await dependencies.plugin.download();
      return true;
    } catch {
      return false;
    }
  }

  async function classify(input: CharacterReferenceClassificationInput): Promise<ReferenceClassification | null> {
    const source = [
      input.imageDescription && `Description: ${input.imageDescription}`,
      input.generationPrompt && `Generation prompt: ${input.generationPrompt}`,
      input.legacyTag && `Legacy tag: ${input.legacyTag}`,
    ]
      .filter(Boolean)
      .join('\n');
    if (!source || (await getAvailability()) !== 'available') return null;

    const run = async () => {
      try {
        const response = await dependencies.plugin.prompt({
          instructions: INSTRUCTIONS,
          prompt: `Character: ${input.characterName || 'unknown'}\nKnown appearance: ${input.characterAppearance || ''}\n${source}`,
          options: { temperature: 0.1, maximumOutputTokens: 192 },
        });
        return parseReferenceClassification(response.text);
      } catch {
        return null;
      }
    };
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { getAvailability, download, classify };
}

const classifier = createLocalLlmClassifier({
  isNative: () => Capacitor.isNativePlatform(),
  plugin: LocalLLM,
});

export const getLocalLlmAvailability = classifier.getAvailability;
export const downloadLocalLlm = classifier.download;
export const classifyCharacterReference = classifier.classify;
