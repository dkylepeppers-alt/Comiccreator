/**
 * Pure LLM-response parsing: JSON repair for truncated model output and
 * shape-normalization of comic-page / planned-page responses. No DB or
 * network access — everything here is synchronous and unit-testable in Node.
 */

export interface ComicPanel {
  narration: string;
  imagePrompt: string;
  imageSize?: string;
  dialogue: { speaker: string; text: string }[];
}

export interface ComicPageResult {
  title: string;
  panels: ComicPanel[];
  choices: { text: string; summary: string }[];
}

/**
 * Attempt to repair a truncated JSON string by closing any unclosed strings,
 * removing trailing commas, and appending missing closing brackets/braces.
 * Returns the repaired string (which may still be invalid if truncation was severe).
 */
export function repairTruncatedJson(str: string): string {
  let s = str.trimEnd();
  const stack = [];
  let inString = false;
  let escape = false;
  let out = '';

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      out += c;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      out += c;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      out += c;
      continue;
    }
    // Drop trailing commas before a closing brace/bracket (a common LLM
    // output mistake that JSON.parse rejects with "Expected double-quoted
    // property name" / "Unexpected token ]").
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && (s[j] === '}' || s[j] === ']')) continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
    out += c;
  }
  s = out;

  // Close any unclosed string literal.
  // If the string ended on a dangling backslash (escape still true), the '\' is
  // incomplete — drop it before appending the closing quote so the quote doesn't
  // get accidentally escaped (e.g. `{"a":"foo\` → `{"a":"foo"`).
  if (inString) {
    if (escape) s = s.slice(0, -1);
    s += '"';
  }
  // Remove trailing comma left by a truncated array or object
  s = s.replace(/,\s*$/, '');
  // Close all unclosed structures
  while (stack.length > 0) s += stack.pop();
  return s;
}

/**
 * Parse comic page JSON from LLM response.
 */
export function parseComicResponse(text: string): ComicPageResult | null {
  // Try to extract JSON from the response
  let jsonStr = text.trim();

  // Remove markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find JSON object boundaries
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  const buildResult = (parsed: any): ComicPageResult => ({
    title: parsed.title || 'Untitled Page',
    panels: (parsed.panels || []).map((p: any) => {
      const panel: any = {
        narration: p.narration || '',
        imagePrompt: p.imagePrompt || p.image_prompt || '',
        dialogue: (p.dialogue || []).map((d: any) => ({
          speaker: d.speaker || 'Unknown',
          text: d.text || '',
        })),
      };
      if (p.imageSize || p.image_size) panel.imageSize = p.imageSize || p.image_size;
      return panel;
    }),
    choices: (parsed.choices || []).map((c: any) => ({
      text: c.text || c.description || '',
      summary: c.summary || '',
    })),
  });

  try {
    return buildResult(JSON.parse(jsonStr));
  } catch (_e) {
    // First parse failed — the LLM response may have been truncated.
    // Attempt to repair the JSON and retry before giving up.
    try {
      return buildResult(JSON.parse(repairTruncatedJson(jsonStr)));
    } catch (_e2) {
      if (typeof (globalThis as any).App !== 'undefined')
        (globalThis as any).App.logError('parseComicResponse', _e2, text?.substring(0, 200));
      return null;
    }
  }
}

/**
 * Parse the structured planned-page JSON from the story model.
 * Shape-normalizes fields with safe defaults; ID/manifest validation is done
 * separately by visual-continuity.validatePlannedPage(). Returns null when
 * the text cannot be parsed even after truncation repair.
 */
export function parsePlannedPageResponse(text: string): any | null {
  let jsonStr = (text || '').trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

  const normalizeChange = (ch: any) => ({
    characterId: ch?.characterId || ch?.character_id || '',
    timing: ch?.timing === 'after-panel' ? 'after-panel' : 'before-panel',
    reason: ch?.reason || '',
    set: {
      ...(ch?.set && 'wardrobeDescription' in ch.set ? { wardrobeDescription: ch.set.wardrobeDescription } : {}),
      ...(ch?.set && 'hairState' in ch.set ? { hairState: ch.set.hairState } : {}),
      ...(ch?.set && 'carriedItems' in ch.set ? { carriedItems: ch.set.carriedItems } : {}),
      ...(ch?.set && 'injuries' in ch.set ? { injuries: ch.set.injuries } : {}),
      ...(ch?.set && 'temporaryChanges' in ch.set ? { temporaryChanges: ch.set.temporaryChanges } : {}),
    },
  });

  const buildResult = (parsed: any) => {
    if (!parsed || !Array.isArray(parsed.panels)) return null;
    const framingValues = new Set([
      'extreme-close-up',
      'close-up',
      'medium-close-up',
      'medium',
      'three-quarter',
      'full-body',
      'wide',
      'establishing',
      'detail',
    ]);
    const elevationValues = new Set(['eye-level', 'high', 'low', 'overhead', 'aerial', 'ground-level']);
    return {
      title: parsed.title || 'Untitled Page',
      panels: parsed.panels.map((p: any) => ({
        narration: p?.narration || '',
        dialogue: (Array.isArray(p?.dialogue) ? p.dialogue : []).map((d: any) => ({
          speaker: d?.speaker || 'Unknown',
          text: d?.text || '',
        })),
        visual: {
          locationId: p?.visual?.locationId || p?.visual?.location_id || null,
          environment: p?.visual?.environment || '',
          framing: framingValues.has(p?.visual?.framing) ? p.visual.framing : undefined,
          cameraElevation: elevationValues.has(p?.visual?.cameraElevation || p?.visual?.camera_elevation)
            ? p.visual.cameraElevation || p.visual.camera_elevation
            : undefined,
          lighting: p?.visual?.lighting || '',
          characters: (Array.isArray(p?.visual?.characters) ? p.visual.characters : []).map((c: any) => ({
            characterId: c?.characterId || c?.character_id || '',
            appearanceState: c?.appearanceState || c?.appearance_state || null,
            action: c?.action || '',
            pose: c?.pose || '',
            expression: c?.expression || '',
          })),
          interaction:
            p?.visual?.interaction && Array.isArray(p.visual.interaction.participantIds)
              ? {
                  participantIds: p.visual.interaction.participantIds.filter(
                    (participantId: unknown) => typeof participantId === 'string' && participantId,
                  ),
                  type: p.visual.interaction.type || '',
                }
              : null,
          keyProps: Array.isArray(p?.visual?.keyProps) ? p.visual.keyProps.filter(Boolean) : [],
        },
        visualStateChanges: Array.isArray(p?.visualStateChanges) ? p.visualStateChanges.map(normalizeChange) : [],
      })),
      choices: (Array.isArray(parsed.choices) ? parsed.choices : []).map((c: any) => ({
        text: c?.text || c?.description || '',
        summary: c?.summary || '',
      })),
    };
  };

  try {
    return buildResult(JSON.parse(jsonStr));
  } catch (_e) {
    try {
      return buildResult(JSON.parse(repairTruncatedJson(jsonStr)));
    } catch (_e2) {
      if (typeof (globalThis as any).App !== 'undefined')
        (globalThis as any).App.logError('parsePlannedPageResponse', _e2, text?.substring(0, 200));
      return null;
    }
  }
}
