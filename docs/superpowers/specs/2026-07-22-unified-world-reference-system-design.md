# Unified World Reference System Design

## Status

Approved through design review on 2026-07-22. This specification replaces the separate character-image and world-image tagging models with one world-owned reference system.

## Problem

Character and world references currently use different tags, metadata, editing controls, and generation-selection paths. Character tags mix view, framing, activity, appearance, and context, while world tags mix location, time, camera treatment, and interactions. Character references also have a second classification model layered over their legacy tags, whereas world references do not.

The split causes three user-visible problems:

- The same kind of image behaves differently depending on which gallery owns it.
- Interaction images cannot consistently represent all participating characters and their world.
- Legacy tag, keyword, semantic, primary-image, and embedding options expose implementation history instead of a coherent creative workflow.

The current stale warning is one symptom of this design. Character classification can change the text represented by a stored embedding after that embedding is created. The generation path can then consume the stale embedding before considering exact metadata.

## Goals

- Make the world the parent of all authoring data used for panel generation.
- Make every character a child of exactly one world.
- Store all reference images in one world-owned reference library.
- Make interaction images first-class shared references linked to every depicted character.
- Use one structured tagging model for characters, locations, interactions, props, and style references.
- Use the configured local LLM for every automatic image-tagging and classification operation.
- Keep the normal UI simple while preserving detailed, correctable metadata.
- Select panel references deterministically from structured metadata.
- Remove embeddings and all legacy reference-selection modes.
- Preserve existing generated comics as read-only snapshots.

## Ownership hierarchy

The canonical authoring hierarchy is:

```text
World
|-- Locations
|-- Characters
|   `-- Character reference views
`-- Reference library
    |-- World and location references
    |-- Character references
    `-- Shared interaction references
```

A `Character` has one required `worldId`. A `WorldLocation` also belongs to one world. A `ReferenceAsset` belongs to one world and may link to zero, one, or many of that world's characters plus an optional location.

Characters cannot be selected across worlds for new comics. Selecting a world in the creation flow limits character and reference choices to that world's children.

## Canonical domain model

### World

The existing world record remains the aggregate root for authoring. Embedded image arrays and legacy primary-image fields are removed. References are queried from the reference store by `worldId`.

### WorldLocation

A location is a stable child entity rather than a free-form image key:

- `id`
- `worldId`
- `name`
- optional description and aliases used by planning and classification
- optional preferred reference ID

The classifier may propose an unmatched location name for review, but it must not silently create or guess a location relationship.

### Character

A character retains its descriptive and continuity data and adds:

- required `worldId`
- optional preferred identity-reference ID

Embedded image arrays, `primaryImageIndex`, and legacy reference metadata are removed. Character pages query the world reference library by `characterIds`.

### ReferenceAsset

Every reference uses one record shape:

- `id`
- `worldId`
- image data and thumbnail data
- `subjectType`: `character`, `location`, `interaction`, `prop`, or `style`
- `characterIds`: IDs of depicted child characters
- optional `locationId`
- `use`: a controlled generation role within the subject type
- structured `facets`
- concise visual description
- field-level classification confidence and provenance
- `classificationState`: `pending`, `ready`, or `needs-review`
- `acceptedAsIs`: explicit user override for automatic use
- `autoUse`: false when hidden from automatic generation
- source provenance such as uploaded, generated, or migrated
- created and updated timestamps

There is no `tag`, `referenceKey`, `locationKey`, embedding, or parallel character/world classification structure.

## Structured tagging model

Tagging is a structured classification, not a free-form label. It has four layers:

1. **Subject**: what kind of reference this is.
2. **Links**: the exact known characters and location depicted.
3. **Use**: why panel generation should select it.
4. **Facets**: how the subjects are visually depicted.

The normal UI renders these layers as a readable composite label, for example:

- `Character / Mara / Identity / Front view`
- `Character / Mara / Appearance / Red coat`
- `Location / Castle courtyard / Establishing / Night`
- `Interaction / Mara + Theo / Conversation / Medium shot`

### Controlled uses

Uses remain deliberately small and generation-oriented:

- Character: identity, appearance, expression, pose, or action.
- Location: establishing, spatial, landmark, or detail.
- Interaction: relationship or action.
- Prop: design or state.
- Style: rendering.

An image has one primary subject type and use. Additional visual meaning belongs in facets and the description rather than accumulating more top-level tags.

### Required facet vocabulary

Common visual facets include:

- framing: extreme close-up, close-up, medium close-up, medium, three-quarter, full body, wide, establishing, or detail
- camera elevation: eye level, high, low, overhead, aerial, or ground level
- view direction: front, three-quarter front, left profile, right profile, three-quarter rear, or rear
- lighting
- visibility and occlusion

Character facets include:

- identity coverage: face, upper body, or full body
- outfit and appearance state
- expression
- pose
- activity
- held or worn props

Location facets include:

- interior, exterior, or threshold
- establishing, area, landmark, or detail scale
- time of day
- weather
- season
- occupancy or crowd state

Interaction facets include:

- exact participant IDs
- interaction type
- participant roles
- spatial arrangement
- physical contact
- screen positions

Prop facets include owner, state, scale, and viewing angle. Unsupported or genuinely unknown values remain unset; the classifier does not force a vague value merely to complete the schema. A concise visual description retains useful nuances that do not fit controlled fields, but it is not a replacement for the structured facets.

## Local-LLM classification workflow

Uploading, generating, or migrating an image creates a pending reference and a durable classification job. Generated-image prompt context may be supplied as a hint, but it does not bypass classification.

The configured local vision-capable LLM receives:

- the image
- the active world's identity and description
- the world's character roster with stable IDs and names
- the world's location roster with stable IDs, names, and aliases
- the allowed subject types, uses, and facet schema

The response must be schema-validated before it updates the asset. Unknown IDs are rejected. Ambiguous relationships remain unset and move the asset to `needs-review`. Automatic classification never falls back to remote classification, legacy tags, filename inference, or keyword heuristics.

Jobs persist in IndexedDB, run with bounded concurrency, resume after reload, and support pause and retry. The progress UI reports completed, pending, failed, and total counts.

### User review states

The user can:

- correct subject links, use, or facets
- rerun local classification
- accept the reference as-is
- hide or unhide it

`Accept as-is` makes a pending or low-confidence reference eligible for automatic generation without inventing missing metadata. The override is recorded so the same asset is not repeatedly flagged.

Hiding sets `autoUse` to false. A hidden reference remains stored, appears under `Show hidden`, and may be selected manually for a panel, but it is excluded from all automatic reference selection.

## Reference UI

The World page owns one References workspace with these views:

- All
- World and locations
- Characters
- Interactions
- Needs review
- Hidden

Character pages provide filtered views of the same world-owned records. They do not own a separate gallery model or tagging implementation.

Each normal reference card contains only:

- image preview
- readable composite classification
- classification status
- Review
- Hide or Unhide

The Review Metadata panel contains the structured fields plus Reclassify and Accept as-is. Detailed facets are correctable but do not crowd every gallery card.

The primary add action offers Upload or Generate. Generation may ask for a small canonical goal such as identity, appearance, location, or interaction, but the resulting image still enters local-LLM classification. Existing reference-variation keys and separate character/world generation menus are not retained as metadata systems.

Removing a relationship from a child view unlinks that subject; it does not destroy a shared asset. Permanent deletion is performed from the world's reference library with the affected relationships made clear.

There are no keyword-versus-semantic selectors, embedding controls, per-gallery tag menus, or duplicated character/world classification controls.

## Panel reference request

Before image generation, each structured panel plan produces a `PanelReferenceRequest` containing:

- active `worldId`
- depicted character IDs
- optional location ID
- requested appearance or outfit state per character
- expressions and activities
- interaction participants and type
- relevant framing, camera, time, lighting, and spatial facets

The request uses stable entity IDs. Names and prose are presentation and prompt context, not primary relationship keys.

## Deterministic reference resolver

Reference selection does not use embeddings. It is a pure, testable resolver over the panel request and the active world's reference records.

The resolver first filters out:

- assets from other worlds
- assets with `autoUse` set to false
- pending or needs-review assets that have not been accepted as-is
- assets whose subject links conflict with the panel request

It then selects, within the model's reference-image budget:

1. The preferred identity reference for each depicted character.
2. Exact requested appearance or state references.
3. The exact location reference when a location is requested.
4. A shared interaction reference when its participant set and interaction facets match.
5. Relevant prop and style references.
6. The previous-frame continuity reference when applicable.

Candidates are ranked as a deterministic tuple: exact entity links, exact use, number of matching requested facets, number of conflicting facets, preferred-anchor status, and a stable final ID tie-break. No recency, network response, or semantic similarity can silently change the winner.

The resulting manifest gives every selected image an explicit role:

- identity
- appearance
- location
- interaction
- prop
- style
- previous frame

The generation prompt receives a reference map explaining each image's role. An interaction reference names every participant and its relevant spatial arrangement. A general reference must never claim to depict an exact missing location or state.

Both image-generation entry points use this same resolver: independent panel generation and the structured visual-continuity pipeline. Neither path may keep its own gallery search, tag matching, or fallback selection. Planner output moves from free-form `referenceKey` and `locationKey` values to stable entity IDs plus requested uses and facets.

For a new comic, the visual-continuity ledger records the reference IDs deliberately selected for that comic. Later pages supply those pinned IDs to the resolver so unrelated library edits do not silently change an ongoing comic's identity or location anchors. Eligibility rules still apply: hiding a pinned reference removes it from automatic use until the user unhides it or selects it manually.

If no valid reference satisfies a requirement, preflight reports the missing character, location, state, or interaction. The resolver does not substitute an unrelated image. Hidden references remain available through deliberate manual panel selection.

## Embedding removal

Embeddings are removed from the reference domain and selection path. The migration discards stored vectors and embedding text. Settings and UI for semantic, keyword, or hybrid reference modes are removed, along with stale-embedding warnings and refresh actions.

Structured IDs and facets provide the authoritative filters and ranking inputs. If future generation evaluations demonstrate a specific selection gap, a reranker can be designed separately and measured against deterministic selection; it is not retained speculatively as a user option.

## Existing comics and migration

### Existing comics

Comics created under the old reference model become read-only snapshots. Users may view, export, and delete them. Editing, continuation, targeted regeneration, and any other operation that would rerun the old selection path are disabled.

New comics use only the unified world-owned system. There is no compatibility switch between old and new generation behavior.

Read-only behavior is enforced at the application/service boundary, not only by hiding buttons. Mutation, continuation, reroll, and retry entry points reject a legacy comic even if called directly.

### Parent assignment

Legacy characters are currently global. Migration derives candidate parent worlds from existing comic relationships:

- A character associated with exactly one world is assigned automatically.
- A character associated with no world or multiple worlds requires one parent-world choice in the migration UI before it can be used for new authoring.
- Characters are not duplicated between worlds.

Read-only comics keep their historical rendered pages and are unaffected by the selected parent assignment.

### Reference conversion

For each world and character image, migration:

1. Creates a world-owned `ReferenceAsset` containing the original image data.
2. Links it to the selected parent world and known source character where applicable.
3. Validates that the new asset safely contains the image before removing the embedded source copy.
4. Discards embeddings and all legacy tag and metadata fields.
5. Queues the asset for fresh local-LLM classification.

Legacy metadata is not copied into the canonical record or consulted by panel generation. The image itself and known ownership relationships are the classification source of truth.

Migration is resumable and reports per-item and overall progress. A failed classification leaves a preserved pending asset that can be retried, reviewed, accepted as-is, or hidden. It does not leave a half-moved image.

After conversion, legacy fields, selectors, settings, classification structures, and generation branches are absent from normal application code. Only an isolated versioned database upgrader understands the stored legacy shape.

### Backup and entity transfer

New backups are explicitly schema-versioned and include worlds, locations, characters, reference assets, classification jobs, comics, pages, and settings that remain valid. Character and world exports use the same canonical records rather than reconstructing embedded galleries.

Import is one-way into the unified model. A supported old backup is decoded only by the isolated upgrader and converted before any record reaches the normal stores. Export never writes legacy tags, keys, embeddings, or embedded image arrays.

## Integration boundaries

Implementation must replace, rather than wrap, each current ownership path:

- IndexedDB schema, record normalization, deletion, backup, import, and entity export
- character, world, and shared gallery pages
- reference generation and upload workflows
- local classification service and its structured prompt/parser
- panel-plan validation and visual-continuity allocation
- independent-panel reference selection
- generation reference-map construction
- settings related to embeddings and legacy selection modes

The shared resolver and canonical reference service are the only normal application APIs allowed to query or mutate reference assets. Page modules render state and dispatch commands; they do not implement their own tag or selection rules.

## Failure handling

- Local-LLM unavailability leaves jobs pending or failed without remote fallback.
- Invalid classifier output is rejected without partially updating an asset.
- Deleted characters or locations are removed from asset links transactionally and affected assets return to review when their meaning becomes ambiguous.
- Reference deletion cannot leave preferred character or location reference IDs dangling.
- Classification and migration progress survives reloads and app restarts.
- Panel preflight makes missing references visible before generation and preserves manual selection.

## Testing and acceptance criteria

### Domain and migration

- Every editable character has exactly one valid parent world.
- Every reference has exactly one valid parent world.
- Shared interactions retain all participant links without image duplication.
- Legacy image data is preserved through successful conversion.
- Embeddings and legacy metadata do not remain on canonical records.
- Ambiguous character ownership requires one explicit assignment.
- Existing comics expose only view, export, and delete operations.
- Service-level guards reject mutation, reroll, retry, continuation, and regeneration for existing comics.
- New backup exports contain only the versioned unified schema, and supported old imports are converted before persistence.

### Classification

- Uploaded, generated, and migrated images all enter the same local-LLM queue.
- Schema validation rejects unknown IDs and unsupported controlled values.
- Low-confidence and ambiguous outputs become needs-review.
- Accept as-is makes an asset automatically eligible.
- Hiding excludes an asset from automatic selection while preserving manual use.
- Jobs pause, resume, retry, and recover after reload.

### Resolver

- Assets never cross world boundaries.
- Identity, appearance, location, interaction, prop, style, and previous-frame roles map correctly into generation manifests.
- Exact entity and facet matches beat partial matches.
- Hidden and unaccepted review assets are excluded.
- Multi-character interactions match the exact participant set and requested spatial facets.
- Missing exact references are reported instead of replaced by unrelated images.
- Equal inputs always produce the same selected references and order.
- Independent-panel and visual-continuity generation produce their manifests through the same resolver.
- Comic-pinned reference IDs remain stable across unrelated library edits and obey hide status.

### UI and integration

- World and character views edit the same underlying reference record.
- Normal cards expose only the composite tag, status, review, and visibility controls.
- Migration and classification progress remain visible and accurate.
- Manual panel selection can include hidden references.
- New comic creation shows only characters owned by the selected world.
- Legacy reference and embedding settings are absent.

Completion is gated by the repository's strict-core typecheck where applicable, standard typecheck, unit tests, coverage thresholds, lint, formatting, production build, and relevant Playwright workflows.

## Non-goals

- Editing or regenerating existing comics under the new reference model.
- Supporting a character as an editable child of multiple worlds.
- Retaining an old/new reference-system toggle.
- Retaining embeddings as an optional selection mode.
- Automatically creating new characters or locations from uncertain classifier output.
- Hiding migration complexity behind silent duplication or guessed ownership.
