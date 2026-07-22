/**
 * Pure system-prompt compilation for story generation: the legacy free-form
 * comic prompt and the structured planner prompt (spec §8.1). No DB or
 * network access — everything here is synchronous and unit-testable in Node.
 */

export interface BuildSystemPromptOptions {
  imageSizes?: string[];
  includeAppearanceText?: boolean;
  imageStylePreset?: string;
}

export interface PlannerManifest {
  genreName: string;
  characters: Array<{
    id: string;
    name: string;
    role?: string;
    description?: string;
    powers?: string;
  }>;
  world?: { id?: string; name: string; description?: string; details?: string; atmosphere?: string } | null;
  locations?: Array<{ id: string; name: string; description?: string }>;
  customSystemPrompt?: string | null;
  panelCount?: string;
}

/**
 * Build system prompt for comic generation.
 * @param {string} genre
 * @param {Array} characters
 * @param {Object} world
 * @param {string|null} customSystemPrompt
 * @param {Object} [options]
 * @param {string[]} [options.imageSizes] - available image sizes for dynamic per-panel selection
 * @param {boolean} [options.includeAppearanceText] - whether to include character appearance text (default: true)
 * @param {string} [options.imageStylePreset] - image style prompt prefix from the selected image preset (e.g. "watercolor painting, soft edges").
 */
export function buildSystemPrompt(
  genre: string,
  characters: any[],
  world: any,
  customSystemPrompt: string | null,
  options?: BuildSystemPromptOptions,
): string {
  const base = customSystemPrompt || `You are a masterful comic book creator specializing in ${genre} stories.`;

  const imageSizes = options?.imageSizes;
  const hasDynamicSizes = Array.isArray(imageSizes) && imageSizes.length > 1;
  const includeAppearance = options?.includeAppearanceText !== false;
  const imageStylePreset = options?.imageStylePreset || '';

  // When an image style preset is selected, use it as the art style directive;
  // otherwise fall back to a generic placeholder so the LLM doesn't hardcode one style.
  const artStyleDirective = imageStylePreset ? imageStylePreset : '[art style keywords matching the story genre]';
  const artStyleExamples = imageStylePreset
    ? `art style (use: ${imageStylePreset})`
    : 'art style (comic book illustration, bold ink lines, cel shading, halftone texture, watercolor, photorealistic — pick the style that fits the story)';

  // Build the per-panel JSON example — include imageSize field when dynamic sizing is enabled
  // Use the first available size as a placeholder; the IMAGE SIZES section instructs the AI to vary them
  const panelExample = hasDynamicSizes
    ? `{
    "narration": "Scene-setting narration text (optional)",
    "imagePrompt": "${artStyleDirective}, [shot type], [lighting], [composition] — describe the scene, characters, action",
    "imageSize": "one of the supported sizes listed below",
    "dialogue": [
      { "speaker": "Character Name", "text": "What they say" }
    ]
  }`
    : `{
    "narration": "Scene-setting narration text (optional)",
    "imagePrompt": "${artStyleDirective}, [shot type], [lighting], [composition] — describe the scene, characters, action",
    "dialogue": [
      { "speaker": "Character Name", "text": "What they say" }
    ]
  }`;

  let prompt = `${base}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, just raw JSON.

Your response must be a JSON object with this exact structure:
{
"title": "Page title",
"panels": [
  ${panelExample}
],
"choices": [
  { "text": "Choice description for the reader", "summary": "Brief consequence summary" }
]
}

Generate 3-4 panels per page. Each panel needs:
- A vivid imagePrompt describing the visual scene using technical art direction language. Specify: shot type (wide establishing shot, medium shot, close-up portrait, over-the-shoulder, Dutch angle), lighting (rim lighting, dramatic side-lighting, chiaroscuro, soft diffused light, hard shadows), ${artStyleExamples}, composition (rule of thirds, foreground/midground/background layers, dynamic diagonal composition), and color mood (desaturated, high contrast, warm palette, etc.).${imageStylePreset ? ` IMPORTANT: Every imagePrompt MUST begin with "${imageStylePreset}" as the art style prefix.` : ''}${includeAppearance ? " Include each character's physical appearance details (clothing, hair, build, distinguishing features) so the image generator maintains visual consistency." : ''}
- Optional narration for scene-setting
- Character dialogue that advances the story

CRITICAL: In each panel's "imagePrompt", you MUST explicitly name every character
who appears in that panel.${
    includeAppearance
      ? ` Include their full physical appearance description
inline. Do NOT just say "the hero" — say "Nova (tall woman with silver hair,
black armor, glowing blue eyes)". This is essential for visual consistency.`
      : ` Describe their actions, poses, and the scene composition.
Reference images will be provided for visual consistency, so you do not need
to repeat full appearance descriptions — but always use character names.`
  }
If a panel has NO characters (e.g., establishing shot), say "No characters present."

Provide 2-3 meaningful choices at the end that affect the story direction.`;

  if (hasDynamicSizes) {
    prompt += `\n\nIMAGE SIZES:
For each panel, choose the most appropriate image size from these supported values: ${imageSizes.join(', ')}
Set the "imageSize" field in each panel object. Pick sizes that best match the composition:
- Use landscape/wide sizes for panoramic scenes, establishing shots, or action sequences
- Use portrait/tall sizes for character close-ups, vertical compositions, or tall structures
- Use square sizes for balanced scenes, dialogue-focused panels, or group shots
Vary the sizes across panels to create a visually dynamic comic layout.`;
  }

  if (characters && characters.length > 0) {
    prompt += '\n\nCHARACTERS:\n';
    for (const c of characters) {
      prompt += `- ${c.name}: ${c.description}`;
      if (c.role) prompt += ` (Role: ${c.role})`;
      if (c.appearance && includeAppearance) prompt += `\n  APPEARANCE: ${c.appearance}`;
      if (c.powers) prompt += `\n  Abilities: ${c.powers}`;
      prompt += '\n';
    }
    if (includeAppearance) {
      prompt += `\nVISUAL CONSISTENCY RULES:
- EVERY panel's "imagePrompt" must repeat each visible character's full appearance (hair color/style, build, outfit, distinguishing marks). Never abbreviate or omit details between panels.
- Use the exact character name and appearance text from the CHARACTERS list above so the image generator can match reference images.
- Keep each character's outfit, proportions, and features identical across all panels unless the story explicitly calls for a change (e.g., transformation, costume swap).`;
    } else {
      prompt += `\nVISUAL CONSISTENCY RULES:
- In each panel's "imagePrompt", name every visible character and describe their actions, poses, and the scene. Reference images will be provided to the image generator for visual consistency.
- Keep each character's outfit, proportions, and features identical across all panels unless the story explicitly calls for a change (e.g., transformation, costume swap).`;
    }
  }

  if (world) {
    prompt += `\nWORLD SETTING:\nName: ${world.name}\nDescription: ${world.description}\n`;
    if (world.details) prompt += `Details: ${world.details}\n`;
    if (world.atmosphere) prompt += `Atmosphere: ${world.atmosphere}\n`;
    prompt += `\nWORLD VISUAL RULES:
- Every imagePrompt must ground the scene in ${world.name}. Include at least one specific environmental detail (architecture style, lighting quality, material textures, color palette) that reflects this world's atmosphere.
- When characters appear indoors, name the specific interior space (e.g., "a cluttered kitchen in ${world.name}", "the dim office corridor of ${world.name}") rather than a generic room.
- When characters appear outdoors, name the specific exterior context (e.g., "the rain-slicked streets of ${world.name}", "the rooftop overlooking ${world.name}") to reinforce the world's visual identity.
- Blend the character's presence with the world — show how they belong to (or contrast with) this environment through lighting, color mood, and framing.`;
  }

  return prompt;
}

/**
 * Build the system prompt for the structured story planner (spec §8.1).
 * The story model plans visual facts against an explicit ID manifest; the
 * application compiles the final image prompts deterministically. The model
 * must NOT write appearance or wardrobe prose — continuity owns those.
 */
export function buildPlannerSystemPrompt(manifest: PlannerManifest): string {
  const base =
    manifest.customSystemPrompt ||
    `You are a masterful comic book creator specializing in ${manifest.genreName} stories.`;
  const panelCount = manifest.panelCount || '3-4';

  const characterLines = manifest.characters
    .map((c) => {
      let line = `- id: "${c.id}"  name: ${c.name}`;
      if (c.role) line += ` (${c.role})`;
      if (c.description) line += `\n  ${c.description}`;
      if (c.powers) line += `\n  Abilities: ${c.powers}`;
      return line;
    })
    .join('\n');

  const locationLines =
    manifest.locations && manifest.locations.length > 0
      ? manifest.locations
          .map(
            (location) =>
              `- id: "${location.id}"  name: ${location.name}${location.description ? ` — ${location.description}` : ''}`,
          )
          .join('\n')
      : '(none — always use null for locationId)';

  let worldBlock = '';
  if (manifest.world) {
    worldBlock = `\nWORLD SETTING:\nName: ${manifest.world.name}\nDescription: ${manifest.world.description || ''}\n`;
    if (manifest.world.details) worldBlock += `Details: ${manifest.world.details}\n`;
    if (manifest.world.atmosphere) worldBlock += `Atmosphere: ${manifest.world.atmosphere}\n`;
  }

  return `${base}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, just raw JSON.

Your response must be a JSON object with this exact structure:
{
"title": "Page title",
"panels": [
  {
    "narration": "Scene-setting narration text (optional, may be empty)",
    "dialogue": [ { "speaker": "Character Name", "text": "What they say" } ],
    "visual": {
      "locationId": "one of the allowed location IDs, or null",
      "environment": "brief scene-specific environmental description",
      "framing": "extreme-close-up | close-up | medium-close-up | medium | three-quarter | full-body | wide | establishing | detail",
      "cameraElevation": "eye-level | high | low | overhead | aerial | ground-level",
      "lighting": "brief lighting description",
      "characters": [
        { "characterId": "id from the CHARACTER MANIFEST", "appearanceState": "named visible state such as red-coat, or null", "action": "what they are doing", "pose": "body position", "expression": "facial expression" }
      ],
      "interaction": { "participantIds": ["character IDs"], "type": "conversation, embrace, fight, handoff, or another concise relationship" },
      "keyProps": ["important objects visible in the panel"]
    },
    "visualStateChanges": [
      {
        "characterId": "id from the CHARACTER MANIFEST",
        "timing": "before-panel or after-panel",
        "reason": "why the story changes this state",
        "set": {
          "wardrobeDescription": "complete new outfit description (only when clothing visibly changes; null to revert to the identity-anchor outfit)",
          "hairState": "new hair arrangement or condition",
          "carriedItems": ["complete replacement list of carried items"],
          "injuries": ["complete replacement list of visible injuries"],
          "temporaryChanges": ["complete replacement list of temporary visual changes (dirt, disguise, transformation)"]
        }
      }
    ]
  }
],
"choices": [ { "text": "Choice description for the reader", "summary": "Brief consequence summary" } ]
}

Generate ${panelCount} panels per page.

CHARACTER MANIFEST (the ONLY allowed characterId values):
${characterLines}

LOCATION MANIFEST (the ONLY allowed locationId values):
${locationLines}

STRICT PLANNING RULES:
- Use ONLY characterId values from the CHARACTER MANIFEST. Never invent IDs and never use character names as IDs.
- List EVERY visible character in visual.characters, including silent background cast whose identity matters.
- Use appearanceState only for a concise, story-relevant visible state. Use null when the identity state is sufficient.
- interaction.participantIds must contain only CHARACTER MANIFEST IDs and must describe the exact visible participants.
- Use only the listed framing and cameraElevation values.
- Do NOT describe any character's physical appearance, face, hair color, build, or clothing in visual fields. Identity and wardrobe are supplied separately by the application.
- Report a wardrobe, hair, injury, carried-item, disguise, or transformation change ONLY in visualStateChanges, and ONLY when the story visibly changes it. Never redesign clothing for variety.
- In "set", omit any field that does not change. A present value fully replaces the old value.
- Use only LOCATION MANIFEST IDs for locationId, or null when no listed location fits.
- Do not specify art style anywhere; the application's image preset is authoritative.
- Provide 2-3 meaningful choices at the end that affect the story direction.${worldBlock}`;
}
