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

const FACET_VOCABULARY = {
  framing: [
    'extreme-close-up',
    'close-up',
    'medium-close-up',
    'medium',
    'three-quarter',
    'full-body',
    'wide',
    'establishing',
    'detail',
  ],
  cameraElevation: ['eye-level', 'high', 'low', 'overhead', 'aerial', 'ground-level'],
  viewDirection: ['front', 'three-quarter-front', 'left-profile', 'right-profile', 'three-quarter-rear', 'rear'],
  identityCoverage: ['face', 'upper-body', 'full-body'],
  spaceType: ['interior', 'exterior', 'threshold'],
  timeOfDay: ['dawn', 'morning', 'midday', 'afternoon', 'dusk', 'night'],
} as const;

/**
 * A fully-formed answer, so the model has a concrete target to imitate. Live probing
 * showed models otherwise echo an inline `"a|b|c"` option list back as a literal value,
 * which fails schema validation for an image they actually classified correctly.
 */
const EXAMPLE_RESPONSE = JSON.stringify({
  subjectType: 'character',
  use: 'identity',
  characterIds: ['<roster character id>'],
  locationId: '<roster location id or null>',
  facets: { framing: 'full-body', viewDirection: 'front', identityCoverage: 'full-body', spaceType: 'exterior' },
  description: 'One concise sentence describing only what is visible.',
  confidence: { subject: 0.94, links: 0.91, use: 0.93, facets: 0.9 },
  proposedCharacterNames: [],
  proposedLocationName: null,
});

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
    'Return one raw JSON object only. No Markdown, no commentary, and never invent IDs.',
    `Roster: ${JSON.stringify(roster)}`,
    `Allowed subject/use pairs: ${JSON.stringify(SUBJECT_SCHEMA)}`,
    `Allowed facet values: ${JSON.stringify(FACET_VOCABULARY)}`,
    'Fields:',
    '- subjectType: exactly one key from the allowed subject/use pairs.',
    '- use: exactly one value listed under that subjectType.',
    '- characterIds: roster character IDs visibly present, or [] when none are.',
    '- locationId: one roster location ID, or null when none is visibly supported.',
    '- facets: include only facets you can actually see, each set to exactly one allowed value.',
    '- description: one concise sentence describing only what is visible.',
    '- confidence: your own certainty for subject, links, use, and facets, each a number between 0 and 1.',
    '- proposedCharacterNames: short names for clearly visible characters that match no roster ID, or [] when none.',
    '- proposedLocationName: a short name for a clearly visible location that matches no roster ID, or null.',
    `Answer in exactly this form, with real values substituted: ${EXAMPLE_RESPONSE}`,
    'Choose one concrete value per field. Never copy an option list, a placeholder, or a field description into your answer.',
    'The example values above are illustrative only — report the confidence you actually have, not the numbers shown.',
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
