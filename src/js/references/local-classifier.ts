import { registerPlugin } from '@capacitor/core';
import { parseReferenceClassification } from './schema.js';
import type { ReferenceAsset, ReferenceClassification, WorldLocation } from './types.js';

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
  classify(input: ClassificationInput): Promise<ReferenceClassification | null>;
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
    classify: async (input) => {
      try {
        if ((await plugin.getAvailability()).status !== 'available') return null;
        const response = await plugin.classify({
          dataUrl: input.asset.dataUrl,
          prompt: buildClassificationPrompt(input),
        });
        return parseReferenceClassification(JSON.parse(response.text), rosterFrom(input));
      } catch {
        return null;
      }
    },
  };
}

const nativeClassifier = registerPlugin<NativeClassifierPlugin>('LocalReferenceClassifier');

export const localReferenceClassifier = createLocalReferenceClassifier(nativeClassifier);
