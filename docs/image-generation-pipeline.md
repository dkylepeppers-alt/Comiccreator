# Image Generation Pipeline

End-to-end documentation of how reference images flow from upload through to the final NanoGPT image-generation API call during comic creation.

## Overview

The pipeline has six stages:

1. **Reference Image Upload** — user uploads images for characters and worlds
2. **Auto-Captioning** — a vision-capable LLM generates a text description of each image
3. **Text Embeddings** — the caption is enriched with metadata and converted to a numeric vector
4. **Per-Panel Reference Selection** — during comic generation, each panel picks the best reference image per character
5. **Prompt Assembly** — the AI-returned `imagePrompt` is sanitized, prefixed, and augmented with appearance text
6. **API Call** — the final prompt and compressed reference images are sent to the NanoGPT image-generation endpoint

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  1. Upload   │───▶│ 2. Caption   │───▶│ 3. Embedding │
│  (user)      │    │ (vision LLM) │    │ (text→vector)│
└──────────────┘    └──────────────┘    └──────┬───────┘
                                               │
          stored in IndexedDB per image ◀──────┘
                         │
        ┌────────────────┘  (comic generation begins)
        ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ 4. Select    │───▶│ 5. Assemble  │───▶│ 6. API Call  │
│ (per-panel)  │    │ (prompt)     │    │ (NanoGPT)    │
└──────────────┘    └──────────────┘    └──────────────┘
```

---

## Stage 1: Reference Image Upload

### Relevant files

| File | Key functions / constants |
|---|---|
| `src/js/pages/characters.ts` | `handleImage()`, `addImageSlot()`, `pickImageForSlot()`, `generateReferences()`, `regenerateImage()` |
| `src/js/pages/worlds.ts` | `handleImage()`, `addImageSlot()`, `pickImageForSlot()`, `generateReferences()`, `regenerateImage()` |
| `src/js/db.ts` | `DB.fileToDataURL()`, `DB.migrateCharacter()`, `DB.migrateWorld()` |

### How it works

Each character or world can hold up to **20 reference images** (`MAX_IMAGES = 20`). In IndexedDB, these are stored on the character/world object in an `images[]` array, where each entry is an object (e.g., `{ dataUrl, tag, description, embedding, ... }`) whose `dataUrl` field contains the base64 image data URL.

#### Manual upload

1. The user clicks **+ Add Image** or clicks an empty gallery slot.
2. A `<input type="file" accept="image/*">` opens the native file picker.
3. `handleImage(event)` reads the file via `DB.fileToDataURL(file)` → base64 data URL.
4. The image is inserted into the in-editor `editorImages[]` array at the target slot index.
5. If the slot had no prior description, **Stage 2 (Auto-Captioning)** fires automatically.

#### AI-generated reference variations

The **🎨 Generate References** button creates additional tagged images from the user's primary upload:

1. `generateReferences()` selects the primary image using `editorPrimaryIndex` (falls back to the first image with a `dataUrl`).
2. It iterates over `API.CHARACTER_REF_VARIATIONS` (or `API.WORLD_REF_VARIATIONS` for worlds), skipping tags that already have an image.
3. For each variation it calls `API.generateRefVariation(primaryImg.dataUrl, prompt)`, which internally calls `API.generateImage()` with the source image as a single reference.
4. The returned image is pushed into `editorImages[]` with metadata `{ aiGenerated: true, generationPrompt: prompt }`.
5. After each successful generation, **Stage 2 (Auto-Captioning)** runs on the new image.

**Character variation tags** (defined in `API.CHARACTER_REF_VARIATIONS`):
`front-view`, `side-view`, `back-view`, `close-up`, `action-pose`, `expression`

**World variation tags** (defined in `API.WORLD_REF_VARIATIONS`):
`aerial`, `interior`, `night`, `detail`

#### Image metadata shape

Each entry in the `images[]` array has this structure:

```js
{
  dataUrl: string,          // base64 data URL of the image
  tag: string,              // e.g. 'default', 'front-view', 'close-up', 'aerial'
  description: string,      // AI-generated or manually entered caption
  embedding: number[]|null, // semantic embedding vector (generated on save)
  embeddingText: string|null, // the enriched text that was embedded
  aiGenerated?: boolean,     // true if created by generateReferences() (undefined for manual uploads)
  generationPrompt?: string, // the prompt used to generate AI images (undefined for manual uploads)
}
```

#### Primary image

One image can be marked as **primary** via the ⭐ button (`setPrimary(idx)`). Clicking the active star toggles it off (`primaryImageIndex = -1`). The primary image is the default fallback when embedding and keyword matching both fail during panel image selection (Stage 4).

---

## Stage 2: Auto-Captioning

### Relevant files

| File | Key functions |
|---|---|
| `src/js/api.ts` | `generateImageCaption()`, `compressDataUrl()`, `chatCompletion()` |
| `src/js/pages/characters.ts` | `handleImage()` (auto-trigger), `recaptionImage()`, `recaptionAll()` |
| `src/js/pages/worlds.ts` | `handleImage()` (auto-trigger), `recaptionImage()`, `recaptionAll()` |

### When captioning happens

- **Automatically** after uploading an image, if the slot's `description` is empty.
- **Automatically** after each AI-generated reference variation is created.
- **Manually** via the 📝 button on a single slot (`recaptionImage(idx)`).
- **Batch** via the **📝 Caption All** toolbar button (`recaptionAll()`).

### How `generateImageCaption()` works

```
dataUrl (input image)
    │
    ▼
compressDataUrl(dataUrl, 512, 0.75)  ← resize to max 512px, JPEG 75%
    │
    ▼
Build vision prompt messages:
  messages[0] = { role: 'system', content: 'You are a visual description assistant…' }
  messages[1] = { role: 'user', content: [
      { type: 'image_url', image_url: { url: compressedUrl } },
      { type: 'text',      text: contextLine + instructionLine }
  ]}
    │
    ▼
chatCompletion(messages, { model, maxTokens, temperature: 0.3 })
    │
    ▼
Returns trimmed string caption, or null on failure
```

### Context-aware prompting

The function accepts `contextHints` to tailor the prompt:

```js
contextHints = {
  type: 'character' | 'character-in-world' | 'character-interaction' | 'world',
  name: string,            // character or world name
  role: string,            // character role (hero, villain, etc.)
  tag: string,             // image tag (front-view, aerial, etc.)
  era: string,             // world era/period
  appearance: string,      // known character appearance text
  worldName: string,       // world name (used for character-in-world and character-interaction types)
  characterNames: string[], // all character names in scene (used for character-interaction type)
}
```

**`character`** — instructs the model to begin with the character's name as subject and focus on outfit, pose, expression, notable features.

**`character-in-world`** — focuses on how the character appears within a specific world setting.

**`character-interaction`** — describes multiple characters together in a shared scene.

**`world`** — instructs the model to begin with the location name and focus on architecture, lighting, atmosphere, scale.

### Model selection

1. `captionModel` setting (if set in Settings).
2. Falls back to the configured text chat model.
3. Skips silently if the model is known not to support vision (`supports_vision === false` in the cached model list).

### Result

The returned caption is stored in `img.description`. Any existing `embedding` and `embeddingText` are nulled out (stale), so they will be regenerated on the next save.

---

## Stage 3: Text Embeddings

### Relevant files

| File | Key functions |
|---|---|
| `src/js/utils.ts` | `buildImageEmbeddingText()` |
| `src/js/api.ts` | `generateEmbedding()` |
| `src/js/pages/characters.ts` | `saveCharacter()` |
| `src/js/pages/worlds.ts` | `saveWorld()` |

### When embeddings are generated

Embeddings are generated **on save**, not on upload or captioning. This avoids redundant API calls when the user is still editing.

Inside `saveCharacter()` (and the equivalent `saveWorld()`):

1. Filter valid images (those with a `dataUrl`).
2. For each image that has a non-empty `description`, compute its **enriched text** via `buildImageEmbeddingText(img, name)`.
3. Compare `enriched` with the stored `embeddingText`. If they differ (or no embedding exists), the image needs re-embedding.
4. Call `API.generateEmbedding(enriched)` for each image that needs it.
5. Store the returned vector in `img.embedding` and the enriched text in `img.embeddingText`.
6. Save the character/world object to IndexedDB via `DB.put()`.

### `buildImageEmbeddingText(img, contextName)`

Builds a richer text string that prepends the image tag and owner name to the description, so the resulting vector better matches panel prompts that reference character names and visual contexts.

**Format rules:**

| Input | Output |
|---|---|
| Tag = semantic (e.g. `action-pose`), name present, description present | `"action-pose Iron Man: Fist raised"` |
| Tag = `default`/`establishing`/`custom`, name present, description present | `"Superman: Red cape flowing"` |
| Tag = semantic, no name, description present | `"front-view: Full body shot"` |
| Tag = `default`, no name, description present | `"Cape flowing"` (description only) |
| Name present, no description | `"close-up Batman"` |

Tags `default`, `establishing`, and `custom` are considered semantically empty and are omitted.

### `generateEmbedding(text)`

```
enrichedText
    │
    ▼
POST /api/v1/embeddings
  body: { input: text, model, encoding_format: 'float', dimensions?: 256 }
    │
    ▼
Returns: number[] (embedding vector) or null on failure
```

- **Default model:** `text-embedding-3-small`
- **Dimension reduction:** Sent only for models in the `DIMENSION_REDUCTION_MODELS` set (e.g. `text-embedding-3-small`, `text-embedding-3-large`, Qwen3 embedding models). Default: 256 dimensions.
- Returns `null` on any error (does not throw).

### Embedding staleness

The gallery UI shows badges per image to indicate embedding status:

| Badge | Meaning |
|---|---|
| ✓ embedded (green) | `embedding` and `embeddingText` are present and match current enriched text |
| ↻ stale (yellow) | Embedding exists but enriched text has changed (tag rename, description edit, name change) |
| — not embedded (gray) | Description exists but no embedding yet (needs save) |

---

## Stage 4: Per-Panel Reference Selection

### Relevant files

| File | Key functions / constants |
|---|---|
| `src/js/pages/create.ts` | `selectBestImage()`, `buildPanelImageOpts()`, `buildCompositeSheet()`, `nameInPrompt()`, `getPromptEmbedding()`, `TAG_KEYWORDS` |

### When it runs

During `generatePage()` in `create.ts`, after the LLM returns a page JSON with panels. For each panel that has an `imagePrompt`, the function `buildPanelImageOpts(panel)` is called to determine which reference images to attach.

### Reference collection at comic start

When the user clicks **Generate** (`startGeneration()`), before any LLM call:

1. For each selected character, `DB.migrateCharacter()` normalizes legacy format, then the full `images[]` array and `primaryImageIndex` are stored in `state.characterImagesByName[name]`.
2. For the selected world, `DB.migrateWorld()` normalizes format. Each world image is added to `state.referenceImages[]` as `{ dataUrl, label, tag, description, type: 'world' }`. For backward compatibility, each selected character's primary image is also pushed into `state.referenceImages[]` as `{ dataUrl, label, type: 'character' }`, although downstream panel logic that builds world reference sets filters this array with `type === 'world'`.

### Character name detection

`nameInPrompt(name, text)` uses a regex with word-boundary matching to check whether a character name appears in the panel's `imagePrompt`. This determines which characters are visible in each panel.

```js
function nameInPrompt(name, text) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'i').test(text);
}
```

### The `selectBestImage()` cascading strategy

For each character detected in a panel, `selectBestImage()` picks the single best reference image from that character's gallery using a three-tier cascade:

```
Panel imagePrompt
    │
    ▼
┌─────────────────────────────────┐
│ 1. Embedding-based selection    │  (unless charRefMode = 'keyword')
│    - Filter images with stored  │
│      embeddings                 │
│    - Generate embedding for the │
│      panel's imagePrompt text   │
│    - Cosine similarity: pick    │
│      highest-scoring image      │
└────────────┬────────────────────┘
             │ (falls through if no embeddings or API failure)
             ▼
┌─────────────────────────────────┐
│ 2. Keyword tag matching         │  (unless charRefMode = 'semantic')
│    - For each image, check its  │
│      tag's keywords against the │
│      panel prompt text          │
│    - Pick image with the most   │
│      keyword hits               │
└────────────┬────────────────────┘
             │ (falls through if no keyword match)
             ▼
┌─────────────────────────────────┐
│ 3. Primary image fallback       │
│    - Use primaryImageIndex      │
│    - If index is -1 or invalid, │
│      use the first valid image  │
└─────────────────────────────────┘
```

#### Embedding tier details

1. Filter the character's images to those with a stored `embedding` vector.
2. Get the panel prompt's embedding via `getPromptEmbedding(panelPromptText)`, which calls `API.generateEmbedding()` with per-page-generation caching (`promptEmbeddingCache` Map).
3. Compute `cosineSimilarity(panelEmb, img.embedding)` for each candidate.
4. Return the image with the highest score.

#### Keyword tier details

`TAG_KEYWORDS` maps each image tag to an array of keywords:

```js
{
  'front-view':       ['front', 'facing', 'standing', 'full body', 'looking at'],
  'side-view':        ['profile', 'side view', 'side-on', 'looking away'],
  'back-view':        ['behind', 'back view', 'from behind', 'walking away', 'rear'],
  'close-up':         ['close-up', 'closeup', 'face', 'portrait', 'headshot', ...],
  'action-pose':      ['running', 'jumping', 'flying', 'fighting', 'action', ...],
  'alternate-outfit': ['casual', 'civilian', 'disguise', 'formal', 'armor', ...],
  'expression':       ['angry', 'sad', 'happy', 'shocked', 'scared', ...],
  'character-sheet':  ['character sheet', 'turnaround', 'model sheet', ...],
}
```

For each image, count how many of its tag's keywords appear (case-insensitive) in the panel prompt. The image with the highest score wins.

#### `charRefMode` setting

Controls which tiers are used:

| Mode | Behavior |
|---|---|
| `auto` (default) | Try embedding → keyword → primary |
| `keyword` | Skip embedding tier, use keyword → primary |
| `semantic` | Skip keyword tier, use embedding → primary |
| `composite` | Use embedding → keyword → primary, but force composite sheet when multiple characters |

### Building panel image options (`buildPanelImageOpts`)

After selecting the best image for each character in the panel:

1. **Resolution:** Uses the user's configured `imageSize` setting. If `dynamicImageSizes` is enabled and the AI provided a valid `WxH` value in `panel.imageSize`, uses that instead.
2. **Composite sheet mode:** If more than one character is present and either `charRefMode === 'composite'` or total refs exceed `maxRefImages`, build a composite canvas (`buildCompositeSheet()`). This stitches character images into a labeled grid with position legends.
3. **Individual refs:** Otherwise, each character's selected image becomes a separate labeled reference, combined with world references.
4. **World references:** All world images from `state.referenceImages` (type `'world'`) are included for every panel.

The output is an options object:

```js
{
  resolution: '1024x1024',
  imageDataUrl?: string,       // single ref (when exactly 1 total ref)
  imageDataUrls?: string[],    // multiple refs
  labeledRefs?: [              // metadata per ref for the prompt legend
    { dataUrl, label, tag, description, type: 'character'|'world' }
  ]
}
```

---

## Stage 5: Prompt Assembly

### Relevant files

| File | Key functions |
|---|---|
| `src/js/pages/create.ts` | `buildEnhancedImagePrompt()` |
| `src/js/utils.ts` | `sanitizeImagePrompt()` |
| `src/js/api.ts` | `generateImage()` — reference legend construction, `enrichImagePrompt()` — LLM prompt expansion |

### `buildEnhancedImagePrompt(panel)`

Transforms the AI-returned `panel.imagePrompt` into the final prompt text sent to the image API.

```
panel.imagePrompt  (raw text from the LLM)
    │
    ▼
sanitizeImagePrompt(panel.imagePrompt)
    │  Strips:
    │  - Quoted dialogue ("I will save you!")
    │  - Narrative lead-ins (Meanwhile, Hours later…)
    │  - Internal states (thinking about, feeling conflicted…)
    │  - Meta-narration (In this panel, cut to…)
    │  - Collapses whitespace, removes orphaned punctuation
    │  Falls back to original if sanitization removes all content
    │
    ▼
Prepend imagePromptPrefix (if set)
    │  From selected image preset's `promptPrefix`
    │  or legacy `imagePromptPrefix` setting
    │  Format: "{prefix}, {sanitized prompt}"
    │
    ▼
Append character appearances (if includeAppearanceText is true)
    │  For each character named in the panel prompt
    │  that has non-empty appearance text:
    │  Appends ". Characters in scene: {name}: {appearance}; …"
    │
    ▼
AI Prompt Enrichment  (if enrichImagePrompts is true)
    │  Calls API.enrichImagePrompt(prompt, { genre })
    │  LLM expands the prompt with:
    │    - Specific shot type (close-up, dutch-angle wide shot, etc.)
    │    - Lighting style (rim lighting, chiaroscuro, soft fill, etc.)
    │    - Dominant colour palette and mood
    │    - Compositional details
    │  Result is cached in promptEnrichmentCache for the current page
    │  Falls back to un-enriched prompt on any API failure
    │
    ▼
Returns: enhanced prompt string
```

### `API.enrichImagePrompt(rawPrompt, options)`

Uses the configured text LLM to expand a terse panel prompt into a detailed, cinematic description that produces noticeably better image results.

- `options.genre` — passed as genre context to the LLM (e.g. `'noir'`, `'sci-fi'`)
- `options.model` — override the text model used for enrichment
- `options.signal` — `AbortSignal` for cancellation
- Returns `rawPrompt` unchanged if: input is falsy, API key is missing, or any API error occurs
- Token budget: 250 output tokens, temperature 0.5

### Reference legend (inside `generateImage()`)

When `labeledRefs` are provided, `generateImage()` prepends a **reference legend** to the prompt before sending it to the API. This legend tells the image model what each reference image represents:

```
Reference image 1: {label}{details} ({type} reference). {instruction}
Reference image 2: …
{enhanced prompt}
```

**Details** are derived from the ref metadata:
- If `description` is present: ` — {description}`
- Else if `tag` is present and not `'default'`: ` ({tag})`
- Otherwise empty

**Instruction** varies by type:
- **character:** `"Replicate this character's exact appearance, proportions, outfit, and distinguishing features precisely as shown."`
- **world:** `"Use this as an environment and style reference — match the architecture, lighting, and atmosphere."`
- **default:** `"Use this as a visual reference."`

---

## Stage 6: API Call

### Relevant files

| File | Key functions |
|---|---|
| `src/js/api.ts` | `generateImage()`, `compressDataUrl()` |

### `generateImage(prompt, options)`

Sends the final request to the NanoGPT image-generation endpoint.

```
finalPrompt  (legend + enhanced prompt)
compressedRefs  (compressed reference images)
    │
    ▼
POST /api/v1/images/generations
  Headers:
    Content-Type: application/json
    Authorization: Bearer {apiKey}
  Body: {
    model: string,             // e.g. 'gpt-image-1'
    prompt: string,            // finalPrompt
    size: string,              // e.g. '1024x1024'
    n: 1,
    showExplicitContent?: boolean,
    imageDataUrls?: string[],  // compressed base64 reference images
    negative_prompt?: string   // from options.negativePrompt; omitted if empty
  }
    │
    ▼
Response: { data: [{ url | b64_json }] }
    │
    ▼
Returns: URL string or base64 string
```

**Negative prompt:** when `options.negativePrompt` is a non-empty string, it is sent to the API as `negative_prompt`. Models that support it (FLUX, Stable Diffusion family, etc.) will avoid generating the described content. Models that ignore the field treat it as a no-op — no error is raised.

### Image compression

Before sending, all reference images are compressed via `compressDataUrl(dataUrl, 1024, 0.85)`:

- Resizes so neither dimension exceeds 1024 px.
- Re-encodes as JPEG at 85% quality.
- Falls back to the original data URL if the image fails to load; other unexpected errors during compression are propagated.

The number of references is capped by the `maxRefImages` setting (default: 4). Excess refs are truncated with a console warning.

### Error handling

On HTTP error, `generateImage()` throws an `Error` that includes the model ID, resolution, API error message, and the prompt text. This is caught per-panel in `generatePage()` and logged via `App.logError()`.

### Image result handling (in `generatePage()`)

For each panel, after `generateImage()` returns:

1. If the result starts with `http` — fetch the URL, convert to a data URL for offline storage. Falls back to the direct URL if fetch fails.
2. If the result starts with `data:` — use directly.
3. Otherwise — wrap as `data:image/png;base64,{result}`.

The final data URL is stored in `panel.imageUrl` and persisted to IndexedDB with the page data.

---

## Settings That Control the Pipeline

| Setting key | Default | Stage(s) | Description |
|---|---|---|---|
| `useRefImages` | `true` | 4 | Master toggle — when false, no reference images are collected |
| `charRefMode` | `'auto'` | 4 | Selection strategy: `auto`, `keyword`, `semantic`, `composite` |
| `maxRefImages` | `4` | 4, 6 | Maximum reference images per API call |
| `imageModel` | `'gpt-image-1'` | 6 | Image generation model |
| `imageSize` | `'1024x1024'` | 4, 6 | Default image resolution |
| `dynamicImageSizes` | `false` | 4 | Let the LLM pick per-panel sizes |
| `includeAppearanceText` | `true` | 5 | Append character appearance to image prompts |
| `imagePromptPrefix` | `''` | 5 | Legacy style prefix (superseded by image presets) |
| `enrichImagePrompts` | `false` | 5 | Expand each panel prompt via LLM before image generation |
| `negativePrompt` | `''` | 6 | Content to suppress in generated images (model-dependent) |
| `captionModel` | `''` | 2 | Dedicated model for vision captioning (falls back to chat model) |
| `embeddingModel` | `'text-embedding-3-small'` | 3 | Model for text embeddings |
| `enableImages` | `true` | 4–6 | Master toggle for image generation during comic creation |
| `showExplicitContent` | `false` | 6 | Passes `showExplicitContent: true` to the API |

---

## Data Flow Summary

```
CHARACTER / WORLD EDITOR                    COMIC GENERATION
═══════════════════════                     ════════════════

Upload image                                LLM returns page JSON with panels
    │                                           │
    ▼                                           ▼
Auto-caption (vision LLM)                  For each panel.imagePrompt:
    │                                           │
    ▼                                      ┌────┴────┐
description stored                         │ Detect  │ nameInPrompt()
    │                                      │ chars   │
    ▼  (on Save)                           └────┬────┘
buildImageEmbeddingText()                       │
    │                                      ┌────┴─────────────────┐
    ▼                                      │ selectBestImage()    │
generateEmbedding()                        │ per detected char    │
    │                                      │  1. cosine(panel,img)│
    ▼                                      │  2. keyword tag      │
embedding + embeddingText                  │  3. primary fallback │
    stored in IndexedDB                    └────┬─────────────────┘
                                                │
                                           ┌────┴────────────────┐
                                           │buildPanelImageOpts()│
                                           │ char refs + world   │
                                           │ refs → labeled opts │
                                           └────┬────────────────┘
                                                │
                                           ┌────┴──────────────────┐
                                           │buildEnhancedImagePrompt│
                                           │ sanitize → prefix →   │
                                           │ append appearance     │
                                           └────┬──────────────────┘
                                                │
                                           ┌────┴───────────────┐
                                           │ generateImage()    │
                                           │ legend + prompt    │
                                           │ + compressed refs  │
                                           │ → POST /images/gen │
                                           └────────────────────┘
```
