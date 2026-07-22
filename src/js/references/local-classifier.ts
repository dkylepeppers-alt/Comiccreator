import { registerPlugin } from '@capacitor/core';
import { parseReferenceClassificationDraft, validateReferenceClassificationDraft } from './schema.js';
import type { ClassificationOutcome, ReferenceAsset, WorldLocation } from './types.js';

export type LocalClassifierStatus = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface ClassificationInput {
  asset: ReferenceAsset;
  world: { id: string; name: string; description?: string };
  characters: Array<{ id: string; name: string; appearance?: string }>;
  locations: WorldLocation[];
}

export interface NativeClassifierPlugin {
  getAvailability(): Promise<{ status: LocalClassifierStatus }>;
  download(): Promise<void>;
  classify(options: { dataUrl: string; prompt: string }): Promise<{ text: string }>;
}

export interface LocalReferenceClassifier {
  getAvailability(): Promise<{ status: LocalClassifierStatus }>;
  download(): Promise<void>;
  classify(input: ClassificationInput): Promise<ClassificationOutcome>;
}

const SUBJECT_SCHEMA = {
  character: ['identity', 'appearance', 'expression', 'pose', 'action'],
  location: ['establishing', 'spatial', 'landmark', 'detail'],
  interaction: ['relationship', 'action'],
  prop: ['design', 'state'],
  style: ['rendering'],
} as const;

export function buildClassificationPrompt(input: ClassificationInput): string {
  const roster = {
    world: input.world,
    characters: input.characters,
    locations: input.locations.map(({ id, worldId, name, description, aliases }) => ({
      id,
      worldId,
      name,
      description,
      aliases,
    })),
  };
  return [
    'Classify the supplied comic reference image using only visible evidence and the stable-ID roster below.',
    'Return one raw JSON object only. Do not use Markdown or invent IDs.',
    `Roster: ${JSON.stringify(roster)}`,
    `Allowed subject/use pairs: ${JSON.stringify(SUBJECT_SCHEMA)}`,
    'Shape: {"subjectType":"character|location|interaction|prop|style","use":"allowed use for subject","characterIds":["stable IDs"],"locationId":"stable ID or null","facets":{"framing":"extreme-close-up|close-up|medium-close-up|medium|three-quarter|full-body|wide|establishing|detail","cameraElevation":"eye-level|high|low|overhead|aerial|ground-level","viewDirection":"front|three-quarter-front|left-profile|right-profile|three-quarter-rear|rear","identityCoverage":"face|upper-body|full-body","spaceType":"interior|exterior|threshold","timeOfDay":"dawn|morning|midday|afternoon|dusk|night"},"description":"concise visible description","confidence":{"subject":0.0,"links":0.0,"use":0.0,"facets":0.0}}',
    'Omit unknown optional facets. Use an empty characterIds array or null locationId when no roster link is visibly supported.',
  ].join('\n');
}

function rosterFrom(input: ClassificationInput) {
  return {
    worldId: input.world.id,
    characterIds: new Set(input.characters.map((character) => character.id)),
    locationIds: new Set(input.locations.map((location) => location.id)),
  };
}

function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function waiting(status: LocalClassifierStatus): ClassificationOutcome {
  return status === 'downloadable' || status === 'downloading'
    ? { kind: 'waiting', reason: 'model-downloading', retryDelayMs: 30_000 }
    : { kind: 'waiting', reason: 'model-unavailable', retryDelayMs: 60_000 };
}

function runtimeWaiting(error: unknown): ClassificationOutcome | null {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('background')) return { kind: 'waiting', reason: 'app-background', retryDelayMs: 15_000 };
  if (message.includes('quota') || message.includes('busy')) {
    return { kind: 'waiting', reason: 'quota-busy', retryDelayMs: 30_000 };
  }
  return null;
}

export function createLocalReferenceClassifier(plugin: NativeClassifierPlugin): LocalReferenceClassifier {
  return {
    getAvailability: async () => {
      try {
        return await plugin.getAvailability();
      } catch {
        return { status: 'unavailable' };
      }
    },
    download: () => plugin.download(),
    classify: async (input): Promise<ClassificationOutcome> => {
      let status: LocalClassifierStatus;
      try {
        status = (await plugin.getAvailability()).status;
      } catch (error) {
        return {
          kind: 'failure',
          error: {
            stage: 'plugin',
            code: 'plugin-unavailable',
            mode: 'local',
            message: error instanceof Error ? error.message : undefined,
          },
        };
      }
      if (status !== 'available') return waiting(status);
      try {
        const response = await plugin.classify({
          dataUrl: input.asset.dataUrl,
          prompt: buildClassificationPrompt(input),
        });
        if (typeof response.text !== 'string') {
          return { kind: 'failure', error: { stage: 'decode', code: 'decode-failed', mode: 'local' } };
        }
        const raw = extractJsonObject(response.text);
        if (!raw) return { kind: 'failure', error: { stage: 'parse', code: 'invalid-json', mode: 'local' } };
        const draft = parseReferenceClassificationDraft(raw);
        if (!draft) return { kind: 'failure', error: { stage: 'validation', code: 'invalid-schema', mode: 'local' } };
        const validated = validateReferenceClassificationDraft(draft, rosterFrom(input));
        return {
          kind: 'classified',
          classification: validated.classification,
          state: validated.state,
          validationReason: validated.validationReason,
        };
      } catch (error) {
        const wait = runtimeWaiting(error);
        if (wait) return wait;
        return {
          kind: 'failure',
          error: {
            stage: 'inference',
            code: 'inference-failed',
            mode: 'local',
            message: error instanceof Error ? error.message : undefined,
          },
        };
      }
    },
  };
}

const nativeClassifier = registerPlugin<NativeClassifierPlugin>('LocalReferenceClassifier');

export const localReferenceClassifier = createLocalReferenceClassifier(nativeClassifier);
