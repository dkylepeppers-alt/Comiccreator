# Seedream Visual Continuity and Sequential Page Generation

**Status:** Proposed  
**Repository baseline:** Comiccreator 1.6.78  
**Last updated:** 2026-07-19

## 1. Summary

Comiccreator will use a single explicit identity anchor for each character, maintain mutable visual details in a persistent per-comic continuity ledger, and compile image prompts deterministically from structured story plans.

When `seedream-v4.5-sequential` is selected and a page can use one image size, all panel images on that page will be generated in one ordered request. `seedream-v4.5` will remain the single-image path for individual generation and cases that cannot be represented as one sequence.

The central distinction is:

| Visual information                                                 | Authoritative source                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Face, body proportions, base hair, age, skin tone, permanent marks | Character identity anchor                                        |
| Clothing                                                           | Current character visual state                                   |
| Hair arrangement or temporary hair condition                       | Current character visual state                                   |
| Carried items, injuries, dirt, blood, disguises, transformations   | Current character visual state                                   |
| Pose, action, expression, camera, lighting                         | Structured panel plan                                            |
| Location appearance                                                | Explicit world/location anchor                                   |
| Art style                                                          | Selected image preset, plus an optional style reference          |
| Cross-page visual continuity                                       | Previous page's last usable panel, when reference budget permits |

Full physical appearance descriptions will not be repeated in Seedream prompts when a valid identity anchor is present. Each panel will still explicitly state what every visible character is wearing and doing.

## 2. Problem statement

The current pipeline has several behaviors that work against consistency:

1. Each panel is sent as an independent `n: 1` image request, even when the selected model is Seedream Sequential.
2. Reference images are capped at a hidden default of four, although the target Seedream models currently accept up to ten.
3. Character references are inferred from character-name text inside `imagePrompt`.
4. A gallery image may be selected by comparing an embedding of the panel prompt with embeddings of image captions, tags, and names. This is text-to-text retrieval, not visual identity matching.
5. The selected reference can therefore change with pose or clothing words in the panel prompt, including selection of an alternate-outfit image that conflicts with the intended outfit.
6. All world references are appended before truncation, without an explicit location contract.
7. Multiple characters may be reduced into a low-resolution composite sheet when the reference limit is exceeded.
8. Character appearance and clothing are repeated as free text, while the reference legend also instructs the model to copy the reference outfit. These instructions conflict when the story changes clothing.
9. Clothing and other temporary visual facts are held mainly in recent text conversation history. Once older turns are trimmed, those facts can disappear or be paraphrased.
10. Gallery anchors are identified by array index, so removing or reordering images can change which image is authoritative.

The embedding feature is not nonfunctional. It performs caption-based semantic retrieval as designed. It is simply the wrong authority for deciding a character's identity image and should not be used for that purpose.

## 3. Goals

The implementation must:

- Preserve each visible character's identity by using exactly one explicit identity anchor per character.
- Keep wardrobe and other mutable visual details stable across panels and pages until an explicit state change occurs.
- Use Seedream Sequential as a page-level generator rather than as several unrelated panel requests.
- Use up to the model's live reference-image limit without treating the maximum as a target.
- Build references from structured character and location identifiers, not name detection in prose.
- Keep story planning separate from final image-prompt construction.
- Preserve exact wardrobe text across prompts instead of allowing enrichment or the story model to paraphrase it.
- Persist enough generation metadata to explain which prompt, state, references, model, and size produced each page.
- Retain a compatible single-image API for existing character and world reference-generation features.
- Degrade deliberately when a page exceeds a model limit; never silently discard a required character anchor.

## 4. Non-goals

This work does not promise perfect identity or wardrobe reproduction. Image generation remains probabilistic, and an identity anchor that strongly displays one outfit can still bias later clothing changes.

This version also does not attempt to:

- Train or fine-tune a character model.
- Create visual embeddings or face-recognition matching.
- Infer a complete wardrobe from an uploaded image.
- Guarantee readable speech lettering inside generated artwork.
- Support arbitrary image-model families with identical continuity behavior. The data and interfaces are generic, but the first page-sequence adapter is specifically for Seedream 4.5 Sequential.

## 5. Product decisions

### 5.1 One identity anchor per character

Every character may have many gallery images but must have one `identityAnchorImageId`. Generation uses that image for identity unless the user explicitly changes the anchor.

A good anchor is a clean full-body or three-quarter view with the face unobstructed, a neutral pose, and a simple background. A single image containing several views of the same character is not the default recommendation because repeated bodies or faces can confuse multi-reference editing.

The anchor may show the character's default outfit. When a later wardrobe state differs, the prompt must say that the wardrobe state is authoritative and the clothing in the identity reference is not.

### 5.2 Identity and wardrobe are separate concepts

Identity references control stable traits. The continuity ledger controls mutable traits. The reference legend must never instruct Seedream to copy a character's outfit unconditionally.

The character-reference instruction will follow this meaning:

> Preserve this character's stable identity: face, age, body proportions, base hair traits, skin tone, and permanent distinguishing features. Ignore the source pose and background. Clothing instructions in each image description are authoritative; do not copy reference clothing when they differ.

### 5.3 Visual state is persistent application data

Each comic stores a visual state for every selected character. State is initialized when the comic is created, updated by explicit panel events, saved after each page, and restored when the comic resumes.

The user can edit the current visual state before generating the next page. A model-proposed change is shown in the page's generation details so an incorrect change can be identified and corrected.

An empty `wardrobeDescription` means “use the outfit shown in the identity anchor.” Once a concrete wardrobe description exists, its normalized text is reused verbatim until another change replaces it.

### 5.4 The story model plans; the application compiles

The story model will no longer be responsible for writing the complete final image prompt. It returns structured visual facts: cast IDs, actions, expressions, location key, camera, environment, lighting, composition, mood, and explicit state changes.

The application then compiles those facts with the identity-anchor map, visual-state snapshot, and style preset. This prevents the story model from rediscovering or paraphrasing continuity on every page.

### 5.5 Sequential generation is page-level

For a normal three- or four-panel page, Comiccreator sends one request to `seedream-v4.5-sequential` with:

- `n` equal to the number of image-bearing panels.
- One page-wide image size.
- One ordered set of references.
- One prompt containing shared continuity rules followed by `IMAGE 1`, `IMAGE 2`, and so on.

Response item `data[0]` maps only to `IMAGE 1`, `data[1]` maps only to `IMAGE 2`, and so forth. The application must not reorder outputs heuristically.

This mapping is a release gate: it must be verified against the live NanoGPT route before sequential batching is enabled by default. Public documentation describes multiple output images, but it does not make a sufficiently explicit ordering guarantee for this application to assume without a contract test.

### 5.6 Reference capacity is a ceiling, not a target

The allocator includes all required identity anchors first. Optional references are added only when they have a clear purpose. More references can introduce conflicts, especially when several images contain the same person in different clothing.

Automatic composite character sheets are disabled for Seedream 4.5. If the page-wide cast exceeds the reference capacity, the application falls back to independent panel generation when each individual panel fits. If even one panel contains more required identities than the model accepts, image generation for that panel stops with an actionable message rather than silently dropping characters.

### 5.7 Embeddings are advisory, not authoritative

Embeddings must not select a character identity anchor. Exact IDs choose character anchors, and exact `locationKey` values choose location anchors.

Existing caption embeddings may remain available for optional gallery search or as a suggestion when the user is choosing a location image. They must not silently change a generation reference.

## 6. Model capability and routing contract

NanoGPT model metadata is the runtime authority. Comiccreator must preserve and normalize the useful fields returned by `GET /api/v1/image-models?detailed=true`, including supported resolutions, input modalities, maximum input images, supported parameters, and maximum output images.

Observed metadata on 2026-07-19 provides this implementation baseline:

| Model                      | Maximum input images | Maximum outputs | Intended route                        |
| -------------------------- | -------------------: | --------------: | ------------------------------------- |
| `seedream-v4.5`            |                   10 |               4 | One image per request in this feature |
| `seedream-v4.5-sequential` |                   10 |              15 | One ordered request per page          |

These numbers must not become a permanent hard-coded capability table. Cached live metadata is used when the network refresh fails. With neither live nor cached metadata, the app takes the conservative path of one reference and one output and explains that model capabilities are unavailable.

### 6.1 Normalized model shape

```ts
export interface ImageModel {
  id: string;
  name: string;
  owned_by: string;
  pricing?: unknown;
  supports_edit?: boolean;
  sizes?: string[] | null;
  inputModalities?: string[];
  maxInputImages?: number | null;
  maxOutputImages?: number | null;
  supportedParameters?: Record<string, unknown>;
}
```

Normalization should accept known field variants from NanoGPT rather than leaking response-shape differences through the rest of the app.

### 6.2 Generation routing

`resolveImageGenerationPlan()` chooses a route from model metadata and page requirements.

| Condition                                                                                                                           | Route                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Selected model is `seedream-v4.5-sequential`, page has 2+ image panels, one common size, output count fits, and page references fit | One sequential page request                          |
| Page-wide references do not fit, but every panel's references fit                                                                   | Independent panel requests                           |
| Mixed image sizes are required                                                                                                      | Independent panel requests                           |
| One image is requested                                                                                                              | Single-image model, one request                      |
| Selected model has no verified sequence adapter                                                                                     | Independent panel requests                           |
| Required references for an individual panel exceed model capacity                                                                   | Stop that panel and show the exact capacity conflict |

`imageModel` remains the page model. Add an optional `singleImageModel` setting. When the page model is `seedream-v4.5-sequential`, the UI should recommend `seedream-v4.5` as the single-image companion if it is present in the live model list. If no companion is configured, use the selected model with `n: 1` only when its metadata permits it.

### 6.3 Page size behavior

A sequential request has one `size` field, so all outputs in that request use one aspect ratio. The configured image size becomes the page image size and must be validated against the selected model's live resolution list.

The story planner may return layout and focal-point hints, but it must not assign different generation sizes to panels in sequential mode. Comic layout may vary through CSS sizing and cropping while retaining the same underlying image ratio.

If the user explicitly requires different generated ratios, routing switches to independent generation.

## 7. Data model

### 7.1 Stable image identifiers and anchors

```ts
export interface ImageRef {
  id: string;
  tag?: string;
  description?: string;
  dataUrl?: string;
  embedding?: number[] | null;
  embeddingText?: string | null;
  locationKey?: string | null;
}

export interface Character {
  // Existing fields remain.
  identityAnchorImageId?: string | null;
  defaultVisualState?: CharacterVisualStateDefaults;
}

export interface World {
  // Existing fields remain.
  defaultAnchorImageId?: string | null;
}
```

`primaryImageIndex` may remain temporarily for thumbnails and old imports, but generation must resolve anchors by ID. Removing or reordering a non-anchor image cannot change the anchor. Removing the anchor requires the user to select a replacement or accept a clearly shown fallback.

World images may carry a user-editable `locationKey`, such as `main-street`, `machine-shop`, or `north-rooftop`. The default world anchor is used when a planned location has no more-specific anchor.

### 7.2 Character visual state

```ts
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
```

The anchor ID is copied into the comic state at creation so a comic has an explicit continuity choice. At generation time, the image is resolved from the current character record. If that image no longer exists, the app warns and falls back to the character's current anchor, then the first valid gallery image.

### 7.3 Explicit state changes

```ts
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
```

Omitted fields remain unchanged. A present string replaces the prior string. `null` clears a string. A present array replaces the prior array, and an empty array clears it. This replacement behavior is deliberately simpler and more deterministic than asking the model to emit incremental add/remove operations.

The planner must emit a change only when the story visibly changes the state. It must not redesign clothing for variety. `reason` is retained for diagnostics and display but does not alter the reducer.

### 7.4 Page snapshots and generation metadata

Each newly generated page stores the state used to begin the page and the committed state after its last panel.

```ts
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
```

New page data adds:

```ts
interface ComicPageData {
  // Existing title, panels, and choices fields remain.
  continuityBefore?: ComicVisualContinuity;
  continuityAfter?: ComicVisualContinuity;
  generation?: PageGenerationMetadata;
}
```

The metadata stores reference IDs and prompt text, not duplicate anchor data URLs.

## 8. Story-planning contract

### 8.1 Planned page schema

The system prompt supplies a manifest containing allowed character IDs, names, and allowed location keys. The story model returns valid JSON in this shape:

```ts
export interface PlannedPage {
  title: string;
  panels: PlannedPanel[];
  choices: { text: string; summary: string }[];
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
    characters: Array<{
      characterId: string;
      action: string;
      pose: string;
      expression: string;
    }>;
    keyProps: string[];
    focalPoint?: string;
    layoutHint?: 'wide' | 'balanced' | 'tall';
  };
  visualStateChanges: PlannedVisualStateChange[];
}
```

The planner must follow these rules:

- Use only character IDs supplied in the manifest.
- List every visible character in `visual.characters`, including silent background cast members whose identity matters.
- Do not place full appearance descriptions in `visual`.
- Do not invent or restate wardrobe details in `visual.characters`.
- Put a wardrobe, hair, injury, carried-item, disguise, or transformation change only in `visualStateChanges`.
- Use only supplied `locationKey` values or `null`.
- Keep style out of the plan; the selected image preset is authoritative.
- Emit three or four panels unless the calling workflow requests a different count.

The application validates IDs and required fields before image generation. Exact ID arrays replace character-name regex matching. A legacy `imagePrompt` response may be supported as a compatibility path, but it does not receive the same continuity guarantee.

### 8.2 State-reduction order

For each panel, in order:

1. Clone the current working state.
2. Apply all `before-panel` changes for that panel.
3. Save the resulting state as the panel's render state.
4. Compile the panel image description from that render state.
5. Apply all `after-panel` changes.
6. Continue to the next panel.

After the final panel, the working state becomes `continuityAfter`. The comic's current state changes only when the page record and comic update are committed.

## 9. Deterministic prompt compilation

Prompt construction belongs in a new pure module, recommended as `src/js/visual-continuity.ts`. It should expose state reduction, reference allocation, route resolution, and prompt compilation as separately testable functions.

### 9.1 Controlled and descriptive prompt blocks

The compiler builds prompts from blocks with different authority:

1. **Reference map:** exact relationship between reference index and subject.
2. **Shared style and continuity rules:** selected preset, palette, rendering style, and page-wide consistency.
3. **Per-image description:** location, cast, exact current wardrobe, mutable state, action, expression, shot, lighting, composition, and mood.
4. **Output contract:** requested image count and order.

Optional prompt enrichment may expand only descriptive scene fields such as environment or lighting. It must not rewrite the reference map, character IDs, wardrobe strings, injuries, carried items, or other controlled state.

### 9.2 Sequential prompt template

The compiled prompt should follow this semantic structure:

```text
Generate exactly 4 images as one continuous comic-page sequence.
Return them in the same order as IMAGE 1 through IMAGE 4.

REFERENCE MAP
Reference image 1: identity anchor for Mara.
Preserve stable identity only. Ignore source pose and background. The wardrobe
listed for each image is authoritative and may differ from the reference.

Reference image 2: identity anchor for Ellis.
...

Reference image 3: location anchor for machine-shop.
Match its architecture, materials, spatial character, and atmosphere. Do not
copy people from the reference.

SHARED CONTINUITY
[selected style preset]
Keep identity, wardrobe, palette, and location details continuous between images
unless an image description explicitly changes them.

IMAGE 1
Location: machine-shop (Reference image 3).
Mara (Reference image 1). Wardrobe: faded olive coveralls with sleeves rolled
to the elbows, black work boots, red shop rag in right pocket. Hair: loose and dry.
Action and expression: ...
Camera, composition, lighting, mood: ...

IMAGE 2
...
```

The actual prompt should remain concise. Empty state fields are omitted. Arrays are rendered in stable order. Whitespace is normalized, but authoritative wardrobe text is not paraphrased.

### 9.3 Independent prompt behavior

Independent generation uses the same state reducer and per-panel compiler. The only differences are:

- Each request contains one panel description.
- References are allocated for that panel rather than the union of the page.
- The configured single-image model is used.
- Each panel may use its own supported resolution.

This keeps continuity semantics identical even when the transport strategy changes.

## 10. Reference allocation

### 10.1 Mandatory references

For a sequential page, mandatory references are:

1. One identity anchor for every unique visible character on the page.
2. One anchor for every explicitly used location key on the page when such an anchor exists.

For independent generation, the same rule applies to one panel at a time.

Identity anchors are ordered by the comic's selected-character order, not by incidental object-key order. Location anchors follow in panel first-use order. Stable ordering prevents reference numbers from changing unpredictably.

### 10.2 Optional references

After all mandatory references fit, remaining slots are considered in this order:

1. The prior page's last successfully generated panel as a cross-page continuity reference.
2. An explicit key-prop reference used by the page.
3. An explicit style reference, when supported by future preset data.

The previous-frame reference is not an identity authority. Its legend instructs the model to carry forward relevant scene continuity without copying its pose or composition. It is omitted when it would displace an identity or location anchor.

### 10.3 Budget rules

The effective budget is:

```text
min(user reference budget, live model maxInputImages)
```

The user setting defaults to `auto`, which means “include every required reference and then useful optional references up to the live limit.” It does not mean “always send the maximum.” The UI displays both the chosen count and model capacity, for example `6 of 10 references`.

If mandatory page references exceed the effective budget, route independently. If mandatory panel references exceed the budget, do not create a partial prompt.

### 10.4 Reference preparation

Reference preparation must preserve enough detail for identity:

- Do not upscale small references.
- Do not automatically reduce every reference to a 1024-pixel long edge.
- Keep a long edge up to 2048 pixels when payload limits permit.
- Re-encode only when dimensions or payload size require it.
- Target a safe encoded size below NanoGPT's documented per-image recommendation.
- Preserve reference order through preprocessing.
- Do not burn labels into identity anchors.

## 11. Image API client

### 11.1 Array-capable method

Add an array-returning method while preserving the current single-image wrapper:

```ts
export interface GenerateImagesOptions extends ImageGenOptions {
  count: number;
}

export interface GeneratedImage {
  index: number;
  value: string;
  source: 'url' | 'b64_json';
}

async function generateImages(prompt: string, options: GenerateImagesOptions): Promise<GeneratedImage[]>;

async function generateImage(prompt: string, options?: ImageGenOptions): Promise<string>;
```

`generateImage()` calls `generateImages()` with `count: 1` and returns the first value. Existing character and world reference-generation callers therefore remain compatible.

### 11.2 Request rules

The OpenAI-compatible request remains `POST /api/v1/images/generations` with:

```json
{
  "model": "seedream-v4.5-sequential",
  "prompt": "...",
  "size": "1920x1920",
  "n": 4,
  "imageDataUrls": ["data:image/...", "data:image/..."]
}
```

Before sending, validate:

- `count >= 1`.
- `count <= maxOutputImages` when the capability is known.
- Reference count does not exceed `maxInputImages`.
- Resolution appears in the model's live supported list when that list is available.
- `imageDataUrls` and the compiled reference manifest have equal lengths and matching order.

The response parser returns every `data[]` entry, accepting either `url` or `b64_json`. It never returns only the first entry for a multi-image request.

If fewer outputs are returned than requested, map only by index, leave the missing panel images empty, and report the mismatch. Do not shift later images forward. If more outputs are returned, retain only the requested indices and log the discrepancy.

Remote result URLs should be converted to data URLs before the page is committed when possible, because signed URLs may expire.

## 12. User interface requirements

### 12.1 Character editor

- Give every saved gallery image a stable ID.
- Add an explicit **Set as identity anchor** control and visible anchor badge.
- Keep thumbnail selection visually distinct from identity-anchor selection if both concepts remain.
- Add optional default visual-state fields: wardrobe, hair state, carried items, injuries, and temporary changes.
- Explain that the identity anchor controls stable physical identity while the wardrobe field controls clothing.
- When deleting the active anchor, require selection of a replacement or display the exact fallback that will be used.

### 12.2 World editor

- Add an explicit default world anchor.
- Allow each world image to have a unique `locationKey` and human-readable description.
- Prevent duplicate nonempty location keys within the same world.
- Show which image will be used when a planned location has no exact match.

### 12.3 Comic setup

- Show an **Initial visual state** section for selected characters.
- Initialize it from each character's defaults.
- Allow per-comic overrides without changing the reusable character record.
- If wardrobe is blank, display `Use identity-anchor outfit` rather than an unexplained empty field.

### 12.4 Reading and continuation

- Add a compact **Continuity** panel showing each character's current wardrobe and mutable state.
- Allow the user to edit state before the next page.
- Show a page-level summary of model, generation strategy, resolution, reference count, and state changes.
- Whole-page image regeneration uses the page's stored render-state snapshots rather than the comic's latest state.
- A future single-panel image regeneration action uses that panel's stored render state and the single-image route.

### 12.5 Settings

- Display the selected model's live maximum input images, maximum outputs, and supported sizes.
- Replace the hidden reference cap behavior with an `Auto` reference-budget control plus valid numeric choices up to the live maximum.
- Add an optional single-image companion model.
- Explain that per-panel generated sizes require independent generation; sequential pages use one shared size.
- Treat appearance repetition and character-gallery selection modes as compatibility behavior for generation paths that do not use the anchored continuity pipeline.

## 13. Persistence and migration

### 13.1 Database migration

Increase the IndexedDB schema version and migrate existing character and world records in the upgrade transaction:

1. Assign a UUID to every gallery image that lacks `id`.
2. For each character lacking `identityAnchorImageId`, select the valid image at `primaryImageIndex`, then the first valid image, then `null`.
3. For each world lacking `defaultAnchorImageId`, use the same fallback order.
4. Preserve existing image data, descriptions, tags, and embeddings.
5. Persist the migrated records immediately so IDs do not change between sessions.

Import and save paths must also normalize records, because imported files may predate the database migration.

### 13.2 Existing comics

Existing comics have no continuity ledger or page snapshots. On the first continuation after upgrade:

1. Build state from the currently selected character anchors and defaults.
2. Show the initialized state before generation so the user can correct clothing.
3. Save the initialized ledger to the comic.
4. Leave existing pages unchanged.

New fields on old page data remain optional so library rendering continues to work.

### 13.3 Commit order

Page creation must treat `continuityBefore`, panel images, `continuityAfter`, and the comic's current ledger as one logical commit. Add a database helper that updates the page and comic in one multi-store IndexedDB transaction. A failed write must not advance the comic state without the corresponding page snapshot.

## 14. Failure and fallback behavior

| Failure                                                            | Required behavior                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Identity anchor ID is missing                                      | Warn, use current character anchor, then first valid image                                                               |
| No valid character image exists                                    | Generate only after clearly marking that identity is unanchored                                                          |
| Exact location key is missing                                      | Use the world's default anchor and record the fallback                                                                   |
| Page reference union exceeds capacity                              | Route to independent panels if each panel fits                                                                           |
| A panel's mandatory references exceed capacity                     | Do not silently drop anchors; leave image empty with an actionable error                                                 |
| Sequential output count is short                                   | Preserve index mapping, retain available outputs, mark missing panels                                                    |
| Sequential request fails                                           | Preserve the story plan so page images can be retried without regenerating story text                                    |
| Live model metadata fails                                          | Use cached metadata; otherwise use conservative limits and explain the limitation                                        |
| Planner emits an unknown character ID                              | Reject the affected visual plan or use an exact, unambiguous compatibility mapping; never guess by fuzzy name similarity |
| Planner emits a state change for a character absent from the comic | Ignore the change, record a validation error, and do not create a new state entry                                        |

## 15. Testing and release gates

### 15.1 Unit tests

Add tests for:

- Stable image-ID and anchor migration.
- Anchor behavior after image deletion and reordering.
- Visual-state initialization, replacement, clearing, revision increments, and before/after timing.
- Structured-plan validation with known and unknown IDs.
- Exact wardrobe-text preservation through compilation.
- Reference ordering and budget allocation.
- No embedding dependency in identity reference selection.
- Sequential-to-independent routing when page references or sizes do not fit.
- API request `n` and complete `data[]` parsing.
- Short and extra response arrays without index shifting.
- Prompt enrichment isolation from controlled continuity blocks.
- Existing single-image callers through the compatibility wrapper.

### 15.2 Integration tests

With mocked NanoGPT responses, verify:

1. A four-panel sequential page produces one image request with `n: 4`.
2. Four ordered response entries populate the matching four panels.
3. The same wardrobe string appears in every relevant image description until an explicit state change.
4. A mid-page wardrobe change affects the correct current or following panel according to its timing.
5. A page with too many unique characters routes to per-panel requests without creating a composite sheet.
6. Whole-page image regeneration reuses stored panel render states.
7. Resuming a comic restores the committed end-of-page state.

### 15.3 Live NanoGPT contract test

Before enabling the sequential route by default, run a low-cost live test using three unmistakably different ordered scene descriptions and verify:

- `n: 3` returns three outputs.
- Output array order matches `IMAGE 1`, `IMAGE 2`, and `IMAGE 3`.
- Reference array order matches the numbered reference legend.
- The route accepts the current live maximum needed by a normal comic page.
- Returned URLs can be persisted before expiration.

Record the model ID and test date. Repeat when NanoGPT materially changes the model metadata or endpoint behavior.

### 15.4 Visual benchmark

Use a fixed multi-page scenario containing:

- One character in unchanged clothing for several pages.
- A deliberate wardrobe change partway through the story.
- Two characters with distinct outfits in the same panels.
- A location change and return to an earlier location.
- One carried item and one temporary injury.

Compare the current pipeline and the new pipeline without telling reviewers which is which. Ship the sequential path only if it produces a clear wardrobe-continuity improvement without a meaningful identity regression. Record failures by category: identity, wardrobe, state timing, location, reference confusion, and output order.

## 16. Acceptance criteria

The feature is complete when all of the following are true:

1. Every character and world gallery image has a stable ID after migration or import.
2. Every character used for anchored generation has one explicit identity anchor.
3. Deleting or reordering another gallery image cannot change that anchor.
4. Structured panel cast IDs, not prose name detection, determine required character references.
5. Character embeddings cannot change the selected identity reference.
6. A concrete wardrobe description is reproduced verbatim in every applicable compiled panel prompt until an explicit state change.
7. `seedream-v4.5-sequential` generates an eligible page in one request with `n` equal to the image-panel count.
8. All returned response entries are retained and mapped by array index.
9. No request exceeds the live model's reference or output limits.
10. Required character anchors are never silently truncated.
11. Composite character sheets are not generated automatically for Seedream 4.5.
12. Sequential pages use one validated size; mixed-size pages route independently.
13. Each new page stores continuity snapshots, compiled prompts, reference manifest, model, strategy, and resolution.
14. Continuing a saved comic restores the last committed visual state.
15. Existing character/world image generation continues to work through the single-image wrapper.
16. Unit, integration, build, typecheck, lint, and browser smoke tests pass.
17. The live sequential output-order contract test has been completed successfully.

## 17. Recommended implementation sequence

### Phase 1: Capability and API foundations

- Expand `ImageModel` metadata normalization.
- Add live reference/output limits to Settings.
- Add `generateImages()` and retain `generateImage()` as a wrapper.
- Add mocked multi-output API tests.

### Phase 2: Stable anchors and migration

- Add image IDs, character identity anchors, world default anchors, and location keys.
- Implement database/import normalization.
- Update character and world editor controls.

### Phase 3: Visual continuity domain

- Add the new pure continuity module.
- Implement state initialization, reduction, snapshots, reference allocation, and prompt compilation.
- Add exhaustive pure-function tests before wiring UI generation.

### Phase 4: Structured story planning

- Replace appearance-heavy panel prompts with the structured planned-page schema.
- Validate cast IDs, location keys, and state-change records.
- Retain the old response shape only as a clearly separated compatibility path.

### Phase 5: Page generation routing

- Add the Seedream Sequential adapter.
- Generate eligible pages and whole-page image retries in one request.
- Route capacity or mixed-size cases independently with the same compiled state.
- Persist generation metadata and continuity snapshots.

### Phase 6: Continuity controls

- Add initial state fields to comic setup.
- Add the reading-page continuity panel and generation details.
- Make model capacity, selected references, and fallbacks visible.

### Phase 7: Verification and rollout

- Run the full automated suite.
- Complete the live NanoGPT ordering/reference contract test.
- Run the fixed visual benchmark against the current pipeline.
- Enable the sequential route by default only after both gates pass.

## 18. Primary file impact

| File                          | Expected responsibility                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `src/js/utils.ts`             | Stable `ImageRef` fields and shared normalization helpers                         |
| `src/js/db.ts`                | New interfaces, schema migration, import normalization, atomic page/comic commit  |
| `src/js/api.ts`               | Model capability normalization, array image API, structured planner prompt/parser |
| `src/js/visual-continuity.ts` | State reducer, reference allocator, route resolver, deterministic prompt compiler |
| `src/js/pages/characters.ts`  | Identity-anchor and default-state controls                                        |
| `src/js/pages/worlds.ts`      | Default anchor and explicit location-key controls                                 |
| `src/js/pages/settings.ts`    | Live capability display, reference budget, single-image companion model           |
| `src/js/pages/create.ts`      | Orchestration, state initialization, batch generation, persistence, continuity UI |
| `src/css/app.css`             | Anchor badges, continuity panel, generation-details presentation                  |
| `test/`                       | Migration, reducer, allocator, routing, parser, integration, and browser coverage |

## 19. External contracts

- [ByteDance Seedream 4.5](https://seed.bytedance.com/en/seedream4_5)
- [NanoGPT OpenAI-compatible image generation](https://docs.nano-gpt.com/api-reference/endpoint/image-generation-openai)
- [NanoGPT image generation API](https://docs.nano-gpt.com/api-reference/image-generation)
- [NanoGPT image-model metadata](https://docs.nano-gpt.com/api-reference/endpoint/image-models)

The live NanoGPT metadata and a successful contract test take precedence over observed values recorded in this document.
