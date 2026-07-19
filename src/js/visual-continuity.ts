import type { ImageRef } from './utils.js';

/**
 * Visual Continuity Domain
 *
 * Pure functions for anchored character identity, the per-comic visual-state
 * ledger, deterministic prompt compilation, reference allocation, and
 * page-generation routing. This module has no DB or network dependencies so
 * every rule is unit-testable in isolation.
 */

// ── Constants ────────────────────────────────────────────────────────

export const SEQUENTIAL_MODEL_ID = 'seedream-v4.5-sequential';
export const SINGLE_IMAGE_MODEL_ID = 'seedream-v4.5';
export const PROMPT_VERSION = 'vc-1';
/** Conservative limits used when neither live nor cached model metadata exists. */
export const CONSERVATIVE_MAX_INPUT_IMAGES = 1;
export const CONSERVATIVE_MAX_OUTPUT_IMAGES = 1;

// ── Types ────────────────────────────────────────────────────────────

export interface CharacterVisualStateDefaults {
  wardrobeDescription?: string;
  hairState?: string;
  carriedItems?: string[];
  injuries?: string[];
  temporaryChanges?: string[];
}

export interface CharacterVisualState {
  characterId: string;
  identityAnchorImageId: string | null;
  wardrobeDescription: string;
  hairState: string;
  carriedItems: string[];
  injuries: string[];
  temporaryChanges: string[];
  revision: number;
  lastChangedAt?: {
    pageNum: number;
    panelIndex: number;
  };
}

export interface ComicVisualContinuity {
  schemaVersion: 1;
  characterStates: Record<string, CharacterVisualState>;
  currentLocationKey?: string | null;
  updatedAt: number;
}

export interface PlannedVisualStateChange {
  characterId: string;
  timing: 'before-panel' | 'after-panel';
  reason: string;
  set: {
    wardrobeDescription?: string | null;
    hairState?: string | null;
    carriedItems?: string[] | null;
    injuries?: string[] | null;
    temporaryChanges?: string[] | null;
  };
}

export interface PlannedPanelCharacter {
  characterId: string;
  action: string;
  pose: string;
  expression: string;
}

export interface PlannedPanel {
  narration: string;
  dialogue: { speaker: string; text: string }[];
  visual: {
    locationKey: string | null;
    environment: string;
    shot: string;
    composition: string;
    lighting: string;
    colorMood: string;
    characters: PlannedPanelCharacter[];
    keyProps: string[];
    focalPoint?: string;
    layoutHint?: 'wide' | 'balanced' | 'tall';
  };
  visualStateChanges: PlannedVisualStateChange[];
}

export interface PlannedPage {
  title: string;
  panels: PlannedPanel[];
  choices: { text: string; summary: string }[];
}

export interface ReferenceManifestItem {
  index: number; // One-based prompt reference number
  role: 'identity' | 'location' | 'previous-frame' | 'prop' | 'style';
  label: string;
  characterId?: string;
  worldId?: string;
  imageId?: string;
  sourcePageId?: string;
  sourcePanelIndex?: number;
}

export interface PageGenerationMetadata {
  schemaVersion: 1;
  strategy: 'sequential-page' | 'independent-panels';
  modelId: string;
  singleImageModelId?: string;
  resolution: string;
  promptVersion: string;
  compiledPrompts: string[];
  referenceManifest: ReferenceManifestItem[];
  generatedAt: number;
}

/** Structural character shape — decoupled from db.ts so this module stays pure. */
export interface CharacterLike {
  id: string;
  name: string;
  appearance?: string;
  images?: ImageRef[];
  primaryImageIndex?: number;
  identityAnchorImageId?: string | null;
  defaultVisualState?: CharacterVisualStateDefaults;
}

export interface WorldLike {
  id: string;
  name: string;
  images?: ImageRef[];
  primaryImageIndex?: number;
  defaultAnchorImageId?: string | null;
}

export interface ModelCapability {
  maxInputImages?: number | null;
  maxOutputImages?: number | null;
  sizes?: string[] | null;
}

// ── Text normalization ───────────────────────────────────────────────

/**
 * Normalize whitespace in authoritative state text ONCE at state entry.
 * After this, the string is reused verbatim — never paraphrased.
 */
export function normalizeStateText(text: string | null | undefined): string {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

function normalizeStateArray(items: string[] | null | undefined): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((s) => normalizeStateText(s)).filter(Boolean);
}

// ── State initialization ─────────────────────────────────────────────

export function createCharacterVisualState(
  character: CharacterLike,
  overrides?: CharacterVisualStateDefaults,
): CharacterVisualState {
  const defaults = character.defaultVisualState || {};
  const merged = Object.assign({}, defaults, overrides || {});
  return {
    characterId: character.id,
    identityAnchorImageId: character.identityAnchorImageId ?? null,
    wardrobeDescription: normalizeStateText(merged.wardrobeDescription),
    hairState: normalizeStateText(merged.hairState),
    carriedItems: normalizeStateArray(merged.carriedItems),
    injuries: normalizeStateArray(merged.injuries),
    temporaryChanges: normalizeStateArray(merged.temporaryChanges),
    revision: 0,
  };
}

export function initializeContinuity(
  characters: CharacterLike[],
  overridesById?: Record<string, CharacterVisualStateDefaults>,
): ComicVisualContinuity {
  const characterStates: Record<string, CharacterVisualState> = {};
  for (const c of characters || []) {
    if (!c || !c.id) continue;
    characterStates[c.id] = createCharacterVisualState(c, overridesById?.[c.id]);
  }
  return {
    schemaVersion: 1,
    characterStates,
    currentLocationKey: null,
    updatedAt: Date.now(),
  };
}

// ── State reduction ──────────────────────────────────────────────────

/**
 * Apply one state-change `set` block to a character state.
 * Semantics (spec §7.3): omitted fields unchanged; a present string replaces;
 * `null` clears a string; a present array replaces (empty array clears);
 * `null` clears an array. Returns the same object when nothing changed.
 */
export function applyVisualStateChange(
  state: CharacterVisualState,
  set: PlannedVisualStateChange['set'],
  at?: { pageNum: number; panelIndex: number },
): CharacterVisualState {
  if (!set) return state;
  let changed = false;
  const next: CharacterVisualState = Object.assign({}, state);

  const stringFields: Array<'wardrobeDescription' | 'hairState'> = ['wardrobeDescription', 'hairState'];
  for (const field of stringFields) {
    if (!(field in set)) continue;
    const raw = set[field];
    const value = raw === null ? '' : normalizeStateText(raw);
    if (raw === undefined) continue;
    if (value !== state[field]) {
      next[field] = value;
      changed = true;
    }
  }

  const arrayFields: Array<'carriedItems' | 'injuries' | 'temporaryChanges'> = [
    'carriedItems',
    'injuries',
    'temporaryChanges',
  ];
  for (const field of arrayFields) {
    if (!(field in set)) continue;
    const raw = set[field];
    if (raw === undefined) continue;
    const value = raw === null ? [] : normalizeStateArray(raw);
    if (JSON.stringify(value) !== JSON.stringify(state[field])) {
      next[field] = value;
      changed = true;
    }
  }

  if (!changed) return state;
  next.revision = state.revision + 1;
  if (at) next.lastChangedAt = { pageNum: at.pageNum, panelIndex: at.panelIndex };
  return next;
}

export interface PageStateReduction {
  /** For each panel (by index): characterId → the state used to render it. */
  panelRenderStates: Array<Record<string, CharacterVisualState>>;
  continuityAfter: ComicVisualContinuity;
  errors: string[];
}

function cloneStates(states: Record<string, CharacterVisualState>): Record<string, CharacterVisualState> {
  const out: Record<string, CharacterVisualState> = {};
  for (const [id, s] of Object.entries(states)) {
    out[id] = Object.assign({}, s, {
      carriedItems: [...s.carriedItems],
      injuries: [...s.injuries],
      temporaryChanges: [...s.temporaryChanges],
      lastChangedAt: s.lastChangedAt ? Object.assign({}, s.lastChangedAt) : undefined,
    });
  }
  return out;
}

/**
 * Run the panel-by-panel state reduction for a planned page (spec §8.2):
 * clone → before-panel changes → snapshot render state → after-panel changes.
 * State changes targeting characters absent from the continuity ledger are
 * ignored and recorded as validation errors — no new entry is created.
 */
export function reducePageStates(
  continuity: ComicVisualContinuity,
  plannedPage: PlannedPage,
  pageNum: number,
): PageStateReduction {
  const errors: string[] = [];
  let working = cloneStates(continuity.characterStates || {});
  const panelRenderStates: Array<Record<string, CharacterVisualState>> = [];
  let lastLocationKey: string | null = continuity.currentLocationKey ?? null;

  (plannedPage.panels || []).forEach((panel, panelIndex) => {
    const changes = Array.isArray(panel.visualStateChanges) ? panel.visualStateChanges : [];
    const applyChanges = (timing: 'before-panel' | 'after-panel') => {
      for (const change of changes) {
        if (!change || change.timing !== timing) continue;
        const current = working[change.characterId];
        if (!current) {
          errors.push(
            `Panel ${panelIndex + 1}: state change targets unknown character "${change.characterId}" — ignored`,
          );
          continue;
        }
        working[change.characterId] = applyVisualStateChange(current, change.set, { pageNum, panelIndex });
      }
    };

    applyChanges('before-panel');
    panelRenderStates.push(cloneStates(working));
    applyChanges('after-panel');

    if (panel.visual?.locationKey) lastLocationKey = panel.visual.locationKey;
  });

  return {
    panelRenderStates,
    continuityAfter: {
      schemaVersion: 1,
      characterStates: working,
      currentLocationKey: lastLocationKey,
      updatedAt: Date.now(),
    },
    errors,
  };
}

// ── Anchor resolution ────────────────────────────────────────────────

export interface AnchorResolution {
  image: ImageRef | null;
  /** How the image was found: exact anchor, primary-index fallback, first valid, or none. */
  source: 'anchor' | 'primary' | 'first' | 'none';
}

/**
 * Resolve a character's identity-anchor image strictly by ID, with an
 * explicit deterministic fallback chain. Embeddings never participate.
 */
export function resolveIdentityAnchorImage(character: CharacterLike): AnchorResolution {
  const images = (character.images || []).filter((img) => img && img.dataUrl);
  if (images.length === 0) return { image: null, source: 'none' };

  if (character.identityAnchorImageId) {
    const anchor = images.find((img) => img.id === character.identityAnchorImageId);
    if (anchor) return { image: anchor, source: 'anchor' };
  }
  const primary =
    typeof character.primaryImageIndex === 'number' ? (character.images || [])[character.primaryImageIndex] : null;
  if (primary && primary.dataUrl) return { image: primary, source: 'primary' };
  return { image: images[0], source: 'first' };
}

export interface LocationAnchorResolution {
  image: ImageRef | null;
  /** The location key that was actually matched, or null when falling back. */
  matchedKey: string | null;
  usedFallback: boolean;
}

/**
 * Resolve a location anchor: exact `locationKey` match first, then the
 * world's default anchor, then primary index, then first valid image.
 */
export function resolveLocationAnchor(world: WorldLike | null, locationKey: string | null): LocationAnchorResolution {
  if (!world) return { image: null, matchedKey: null, usedFallback: false };
  const images = (world.images || []).filter((img) => img && img.dataUrl);
  if (images.length === 0) return { image: null, matchedKey: null, usedFallback: false };

  if (locationKey) {
    const exact = images.find((img) => img.locationKey === locationKey);
    if (exact) return { image: exact, matchedKey: locationKey, usedFallback: false };
  }
  if (world.defaultAnchorImageId) {
    const def = images.find((img) => img.id === world.defaultAnchorImageId);
    if (def) return { image: def, matchedKey: def.locationKey || null, usedFallback: !!locationKey };
  }
  const primary = typeof world.primaryImageIndex === 'number' ? (world.images || [])[world.primaryImageIndex] : null;
  if (primary && primary.dataUrl) return { image: primary, matchedKey: primary.locationKey || null, usedFallback: true };
  return { image: images[0], matchedKey: images[0].locationKey || null, usedFallback: true };
}

// ── Cast and location collection ─────────────────────────────────────

/** Unique visible character IDs across panels, ordered by the comic's selected-character order. */
export function collectPageCast(plannedPage: PlannedPage, characterOrder: string[]): string[] {
  const seen = new Set<string>();
  for (const panel of plannedPage.panels || []) {
    for (const c of panel.visual?.characters || []) {
      if (c?.characterId) seen.add(c.characterId);
    }
  }
  const ordered = (characterOrder || []).filter((id) => seen.has(id));
  // Any cast IDs not in the selection order (shouldn't happen after validation) go last, sorted for stability
  const extras = [...seen].filter((id) => !ordered.includes(id)).sort();
  return [...ordered, ...extras];
}

export function collectPanelCast(panel: PlannedPanel): string[] {
  const seen = new Set<string>();
  for (const c of panel.visual?.characters || []) {
    if (c?.characterId) seen.add(c.characterId);
  }
  return [...seen];
}

/** Unique non-null location keys in panel first-use order. */
export function collectLocationKeys(panels: PlannedPanel[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const panel of panels || []) {
    const key = panel.visual?.locationKey;
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// ── Reference allocation ─────────────────────────────────────────────

export interface PreviousFrameRef {
  dataUrl: string;
  sourcePageId?: string;
  sourcePanelIndex?: number;
}

export interface ReferenceAllocationInput {
  /** Cast IDs in stable (comic selected-character) order. */
  characterIds: string[];
  charactersById: Record<string, CharacterLike>;
  /** Location keys in panel first-use order. */
  locationKeys: string[];
  world?: WorldLike | null;
  /** Effective budget — already min(user budget, model max). */
  budget: number;
  previousFrame?: PreviousFrameRef | null;
}

export interface ReferenceAllocation {
  manifest: ReferenceManifestItem[];
  dataUrls: string[];
  /** Characters that could not be anchored (no valid image at all). */
  unanchoredCharacterIds: string[];
  warnings: string[];
  error?: { type: 'capacity'; required: number; budget: number; detail: string };
}

/**
 * Allocate references for one request (page-wide or single panel).
 * Mandatory identity/location anchors first, in stable order; optional
 * references only when they fit. Never silently drops a required anchor —
 * a capacity overflow is returned as an explicit error instead.
 */
export function allocateReferences(input: ReferenceAllocationInput): ReferenceAllocation {
  const warnings: string[] = [];
  const unanchoredCharacterIds: string[] = [];
  const mandatory: Array<{ item: Omit<ReferenceManifestItem, 'index'>; dataUrl: string }> = [];

  for (const charId of input.characterIds || []) {
    const character = input.charactersById[charId];
    if (!character) {
      warnings.push(`Unknown character "${charId}" skipped during reference allocation`);
      continue;
    }
    const resolved = resolveIdentityAnchorImage(character);
    if (!resolved.image?.dataUrl) {
      unanchoredCharacterIds.push(charId);
      warnings.push(`Character "${character.name}" has no valid reference image — identity is unanchored`);
      continue;
    }
    if (resolved.source !== 'anchor') {
      warnings.push(
        `Character "${character.name}" identity anchor missing — fell back to ${resolved.source} gallery image`,
      );
    }
    mandatory.push({
      item: {
        role: 'identity',
        label: character.name,
        characterId: charId,
        imageId: resolved.image.id,
      },
      dataUrl: resolved.image.dataUrl,
    });
  }

  for (const key of input.locationKeys || []) {
    const resolved = resolveLocationAnchor(input.world || null, key);
    if (!resolved.image?.dataUrl) continue;
    if (resolved.usedFallback) {
      warnings.push(`No exact anchor for location "${key}" — using the world's default anchor`);
    }
    // Avoid duplicating the same physical image when several keys fall back to one default
    if (mandatory.some((m) => m.item.role === 'location' && m.item.imageId === resolved.image!.id)) continue;
    mandatory.push({
      item: {
        role: 'location',
        label: key,
        worldId: input.world?.id,
        imageId: resolved.image.id,
      },
      dataUrl: resolved.image.dataUrl,
    });
  }

  if (mandatory.length > input.budget) {
    return {
      manifest: [],
      dataUrls: [],
      unanchoredCharacterIds,
      warnings,
      error: {
        type: 'capacity',
        required: mandatory.length,
        budget: input.budget,
        detail:
          `This request needs ${mandatory.length} mandatory reference image(s) ` +
          `(${input.characterIds.length} character identit${input.characterIds.length === 1 ? 'y' : 'ies'}, ` +
          `${input.locationKeys.length} location(s)) but only ${input.budget} fit.`,
      },
    };
  }

  const selected = [...mandatory];
  if (input.previousFrame?.dataUrl && selected.length < input.budget) {
    selected.push({
      item: {
        role: 'previous-frame',
        label: 'previous page final panel',
        sourcePageId: input.previousFrame.sourcePageId,
        sourcePanelIndex: input.previousFrame.sourcePanelIndex,
      },
      dataUrl: input.previousFrame.dataUrl,
    });
  }

  const manifest = selected.map((entry, i) => Object.assign({ index: i + 1 }, entry.item));
  return {
    manifest,
    dataUrls: selected.map((entry) => entry.dataUrl),
    unanchoredCharacterIds,
    warnings,
  };
}

/** Effective reference budget: min(user budget, live model limit), conservative when unknown. */
export function effectiveReferenceBudget(
  userBudget: number | 'auto' | null | undefined,
  modelMaxInputImages: number | null | undefined,
): number {
  const modelMax =
    typeof modelMaxInputImages === 'number' && modelMaxInputImages > 0
      ? modelMaxInputImages
      : CONSERVATIVE_MAX_INPUT_IMAGES;
  if (userBudget === 'auto' || userBudget == null) return modelMax;
  const user = Number(userBudget);
  if (!Number.isFinite(user) || user < 1) return modelMax;
  return Math.min(Math.floor(user), modelMax);
}

// ── Route resolution ─────────────────────────────────────────────────

export interface GenerationPlanInput {
  modelId: string;
  modelMeta: ModelCapability | null;
  /** Number of image-bearing panels on the page. */
  imagePanelCount: number;
  /** Reference count for the page-wide union allocation. */
  pageReferenceCount: number;
  /** Reference count per image-bearing panel (same order as panels). */
  panelReferenceCounts: number[];
  /** Distinct generation sizes requested across panels. */
  requestedSizes: string[];
  /** Whether the sequential route has been enabled (post contract-test gate). */
  sequentialEnabled: boolean;
}

export interface GenerationPlan {
  strategy: 'sequential-page' | 'independent-panels';
  reasons: string[];
  /** Panels whose mandatory references exceed capacity — must not be generated. */
  blockedPanels: Array<{ panelIndex: number; required: number; capacity: number }>;
  capacity: number;
  maxOutputs: number;
  metadataAvailable: boolean;
}

/** Choose sequential-page vs independent-panels routing from model metadata and page shape (spec §6.2). */
export function resolveImageGenerationPlan(input: GenerationPlanInput): GenerationPlan {
  const metadataAvailable = !!input.modelMeta;
  const capacity =
    typeof input.modelMeta?.maxInputImages === 'number' && input.modelMeta.maxInputImages > 0
      ? input.modelMeta.maxInputImages
      : CONSERVATIVE_MAX_INPUT_IMAGES;
  const maxOutputs =
    typeof input.modelMeta?.maxOutputImages === 'number' && input.modelMeta.maxOutputImages > 0
      ? input.modelMeta.maxOutputImages
      : CONSERVATIVE_MAX_OUTPUT_IMAGES;

  const reasons: string[] = [];
  if (!metadataAvailable) reasons.push('Model capability metadata unavailable — using conservative limits');

  const blockedPanels = (input.panelReferenceCounts || [])
    .map((required, panelIndex) => ({ panelIndex, required, capacity }))
    .filter((p) => p.required > capacity);

  const hasAdapter = input.modelId === SEQUENTIAL_MODEL_ID;
  const mixedSizes = (input.requestedSizes || []).length > 1;

  if (!hasAdapter) {
    reasons.push('Selected model has no verified sequence adapter');
  } else if (!input.sequentialEnabled) {
    reasons.push('Sequential page generation is disabled (output-order contract test gate)');
  } else if (input.imagePanelCount < 2) {
    reasons.push('Fewer than two image panels — single-image route');
  } else if (mixedSizes) {
    reasons.push('Mixed image sizes require independent panel requests');
  } else if (input.imagePanelCount > maxOutputs) {
    reasons.push(`Page needs ${input.imagePanelCount} outputs but the model supports ${maxOutputs}`);
  } else if (input.pageReferenceCount > capacity) {
    reasons.push(`Page-wide references (${input.pageReferenceCount}) exceed model capacity (${capacity})`);
  } else {
    return {
      strategy: 'sequential-page',
      reasons: ['Sequential page request'],
      blockedPanels,
      capacity,
      maxOutputs,
      metadataAvailable,
    };
  }

  return { strategy: 'independent-panels', reasons, blockedPanels, capacity, maxOutputs, metadataAvailable };
}

// ── Planned-page validation ──────────────────────────────────────────

export interface PlannedPageValidationInput {
  characterIds: string[];
  locationKeys: string[];
}

export interface PlannedPageValidation {
  page: PlannedPage;
  errors: string[];
}

/**
 * Validate and sanitize a planned page against the ID manifest supplied to
 * the story model. Unknown character IDs and location keys are removed and
 * recorded — never fuzzily remapped by name similarity.
 */
export function validatePlannedPage(planned: PlannedPage, manifest: PlannedPageValidationInput): PlannedPageValidation {
  const errors: string[] = [];
  const knownChars = new Set(manifest.characterIds || []);
  const knownLocations = new Set(manifest.locationKeys || []);

  const panels = (planned.panels || []).map((panel, i) => {
    const visual = panel.visual || ({} as PlannedPanel['visual']);

    const characters = (visual.characters || []).filter((c) => {
      if (c?.characterId && knownChars.has(c.characterId)) return true;
      errors.push(`Panel ${i + 1}: unknown character ID "${c?.characterId ?? '(missing)'}" removed from cast`);
      return false;
    });

    let locationKey = visual.locationKey ?? null;
    if (locationKey && !knownLocations.has(locationKey)) {
      errors.push(`Panel ${i + 1}: unknown location key "${locationKey}" — falling back to default world anchor`);
      locationKey = null;
    }

    const visualStateChanges = (panel.visualStateChanges || []).filter((change) => {
      if (change?.characterId && knownChars.has(change.characterId)) return true;
      errors.push(
        `Panel ${i + 1}: state change for unknown character "${change?.characterId ?? '(missing)'}" ignored`,
      );
      return false;
    });

    return Object.assign({}, panel, {
      visual: Object.assign({}, visual, { characters, locationKey }),
      visualStateChanges,
    });
  });

  return { page: Object.assign({}, planned, { panels }), errors };
}

// ── Prompt compilation ───────────────────────────────────────────────

const IDENTITY_LEGEND =
  "Preserve this character's stable identity: face, age, body proportions, base hair traits, skin tone, and " +
  'permanent distinguishing features. Ignore the source pose and background. Clothing instructions in each image ' +
  'description are authoritative; do not copy reference clothing when they differ.';

const LOCATION_LEGEND =
  'Match its architecture, materials, spatial character, and atmosphere. Do not copy people from the reference.';

const PREVIOUS_FRAME_LEGEND =
  'Carry forward relevant scene continuity from this frame. Do not copy its pose or composition. It is not an ' +
  'identity authority.';

function buildReferenceMap(manifest: ReferenceManifestItem[]): string {
  if (!manifest.length) return '';
  const lines = manifest.map((item) => {
    switch (item.role) {
      case 'identity':
        return `Reference image ${item.index}: identity anchor for ${item.label}. ${IDENTITY_LEGEND}`;
      case 'location':
        return `Reference image ${item.index}: location anchor for ${item.label}. ${LOCATION_LEGEND}`;
      case 'previous-frame':
        return `Reference image ${item.index}: final panel of the previous page. ${PREVIOUS_FRAME_LEGEND}`;
      case 'prop':
        return `Reference image ${item.index}: prop reference for ${item.label}. Match its design and materials.`;
      case 'style':
        return `Reference image ${item.index}: art-style reference. Match its rendering style only.`;
    }
  });
  return `REFERENCE MAP\n${lines.join('\n')}`;
}

export interface CompilePanelInput {
  panel: PlannedPanel;
  renderState: Record<string, CharacterVisualState>;
  manifest: ReferenceManifestItem[];
  charactersById: Record<string, CharacterLike>;
}

/**
 * Compile one panel's image description from its render state (spec §9.1
 * block 3). Wardrobe strings are inserted verbatim; empty fields are omitted.
 */
export function compilePanelDescription(input: CompilePanelInput): string {
  const { panel, renderState, manifest, charactersById } = input;
  const visual = panel.visual || ({} as PlannedPanel['visual']);
  const refByCharacter = new Map(manifest.filter((m) => m.role === 'identity').map((m) => [m.characterId, m]));
  const refByLocation = new Map(manifest.filter((m) => m.role === 'location').map((m) => [m.label, m]));

  const lines: string[] = [];

  if (visual.locationKey) {
    const locRef = refByLocation.get(visual.locationKey);
    const refNote = locRef ? ` (Reference image ${locRef.index})` : '';
    lines.push(`Location: ${visual.locationKey}${refNote}.${visual.environment ? ` ${visual.environment}` : ''}`);
  } else if (visual.environment) {
    lines.push(`Location: ${visual.environment}`);
  }

  for (const cast of visual.characters || []) {
    const character = charactersById[cast.characterId];
    const name = character?.name || cast.characterId;
    const ref = refByCharacter.get(cast.characterId);
    const state = renderState[cast.characterId];

    const parts: string[] = [];
    if (ref) {
      parts.push(`${name} (Reference image ${ref.index}).`);
    } else {
      parts.push(`${name} (no reference image; identity unanchored).`);
      if (character?.appearance) parts.push(`Appearance: ${normalizeStateText(character.appearance)}.`);
    }
    if (state) {
      if (state.wardrobeDescription) {
        parts.push(`Wardrobe: ${state.wardrobeDescription}.`);
      } else if (ref) {
        parts.push(`Wardrobe: as shown in Reference image ${ref.index} (identity anchor outfit).`);
      }
      if (state.hairState) parts.push(`Hair: ${state.hairState}.`);
      if (state.carriedItems.length) parts.push(`Carrying: ${state.carriedItems.join(', ')}.`);
      if (state.injuries.length) parts.push(`Injuries: ${state.injuries.join(', ')}.`);
      if (state.temporaryChanges.length) parts.push(`Temporary changes: ${state.temporaryChanges.join(', ')}.`);
    }
    const actionBits = [cast.action, cast.pose].map((s) => normalizeStateText(s)).filter(Boolean);
    if (actionBits.length) parts.push(`Action and pose: ${actionBits.join('; ')}.`);
    if (cast.expression) parts.push(`Expression: ${normalizeStateText(cast.expression)}.`);
    lines.push(parts.join(' '));
  }

  const cine: string[] = [];
  if (visual.shot) cine.push(`Camera: ${normalizeStateText(visual.shot)}`);
  if (visual.composition) cine.push(`Composition: ${normalizeStateText(visual.composition)}`);
  if (visual.lighting) cine.push(`Lighting: ${normalizeStateText(visual.lighting)}`);
  if (visual.colorMood) cine.push(`Color mood: ${normalizeStateText(visual.colorMood)}`);
  if (cine.length) lines.push(`${cine.join('. ')}.`);
  if (visual.keyProps?.length) lines.push(`Key props: ${visual.keyProps.map((p) => normalizeStateText(p)).join(', ')}.`);
  if (visual.focalPoint) lines.push(`Focal point: ${normalizeStateText(visual.focalPoint)}.`);

  return lines.filter(Boolean).join('\n');
}

export interface CompileSequentialInput {
  /** Image-bearing planned panels in page order. */
  panels: PlannedPanel[];
  /** Render state per panel, parallel to `panels`. */
  renderStates: Array<Record<string, CharacterVisualState>>;
  manifest: ReferenceManifestItem[];
  charactersById: Record<string, CharacterLike>;
  stylePreset?: string;
}

/** Compile the single page-level prompt for a Seedream Sequential request (spec §9.2). */
export function compileSequentialPagePrompt(input: CompileSequentialInput): string {
  const n = input.panels.length;
  const blocks: string[] = [];

  blocks.push(
    `Generate exactly ${n} image${n === 1 ? '' : 's'} as one continuous comic-page sequence.\n` +
      `Return them in the same order as IMAGE 1 through IMAGE ${n}.`,
  );

  const refMap = buildReferenceMap(input.manifest);
  if (refMap) blocks.push(refMap);

  const shared: string[] = ['SHARED CONTINUITY'];
  if (input.stylePreset) shared.push(normalizeStateText(input.stylePreset));
  shared.push(
    'Keep identity, wardrobe, palette, and location details continuous between images unless an image description ' +
      'explicitly changes them.',
  );
  blocks.push(shared.join('\n'));

  input.panels.forEach((panel, i) => {
    const description = compilePanelDescription({
      panel,
      renderState: input.renderStates[i] || {},
      manifest: input.manifest,
      charactersById: input.charactersById,
    });
    blocks.push(`IMAGE ${i + 1}\n${description}`);
  });

  return blocks.join('\n\n');
}

export interface CompileIndependentInput {
  panel: PlannedPanel;
  renderState: Record<string, CharacterVisualState>;
  manifest: ReferenceManifestItem[];
  charactersById: Record<string, CharacterLike>;
  stylePreset?: string;
}

/** Compile a single-panel prompt using the same state and legend semantics as the sequential path. */
export function compileIndependentPanelPrompt(input: CompileIndependentInput): string {
  const blocks: string[] = [];
  const refMap = buildReferenceMap(input.manifest);
  if (refMap) blocks.push(refMap);

  const shared: string[] = [];
  if (input.stylePreset) shared.push(normalizeStateText(input.stylePreset));
  if (shared.length) blocks.push(shared.join('\n'));

  blocks.push(
    compilePanelDescription({
      panel: input.panel,
      renderState: input.renderState,
      manifest: input.manifest,
      charactersById: input.charactersById,
    }),
  );

  return blocks.join('\n\n');
}
