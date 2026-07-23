import type { ReferenceAsset, WorldLocation } from './types.js';

export interface ClassificationInput {
  asset: ReferenceAsset;
  world: { id: string; name: string; description?: string };
  characters: Array<{ id: string; name: string; appearance?: string }>;
  locations: WorldLocation[];
}

const SUBJECT_SCHEMA = {
  character: ['identity', 'appearance', 'expression', 'pose', 'action'],
  location: ['establishing', 'spatial', 'landmark', 'detail'],
  interaction: ['relationship', 'action'],
  prop: ['design', 'state'],
  style: ['rendering'],
} as const;

/**
 * The single classification prompt. Both the cloud and on-device backends send this
 * verbatim so their outputs are directly comparable and validated identically.
 */
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

export function rosterFrom(input: ClassificationInput) {
  return {
    worldId: input.world.id,
    characterIds: new Set(input.characters.map((character) => character.id)),
    locationIds: new Set(input.locations.map((location) => location.id)),
  };
}

/** Recover the first balanced JSON object from model output that may be fenced or padded with prose. */
export function extractJsonObject(text: string): unknown | null {
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
