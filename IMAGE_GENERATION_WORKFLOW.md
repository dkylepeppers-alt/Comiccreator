# Image Generation Workflow

This document describes the complete image generation pipeline in AI Comic Creator: how reference images are uploaded, captioned, embedded, selected, and used to generate per-panel comic artwork.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Settings Reference](#settings-reference)
4. [Phase 1: Reference Image Upload and Storage](#phase-1-reference-image-upload-and-storage)
5. [Phase 2: Auto-Captioning](#phase-2-auto-captioning)
6. [Phase 3: Text Embeddings](#phase-3-text-embeddings)
7. [Phase 4: AI Reference Generation](#phase-4-ai-reference-generation)
8. [Phase 5: Comic Creation Setup](#phase-5-comic-creation-setup)
9. [Phase 6: Story Generation (Text)](#phase-6-story-generation-text)
10. [Phase 7: Per-Panel Image Generation](#phase-7-per-panel-image-generation)
11. [Image Style Presets](#image-style-presets)
12. [Image Compression](#image-compression)
13. [Reference Legend Construction](#reference-legend-construction)
14. [Error Handling and Fallbacks](#error-handling-and-fallbacks)

---

## Overview

The image generation workflow spans four modules and proceeds through distinct phases:

1. **Preparation** — Users upload reference images for characters and worlds. Each image is automatically captioned by a vision model, then a text embedding is generated from the caption. Users can also AI-generate reference variations.
2. **Story generation** — A text LLM produces structured JSON comic pages, each containing `imagePrompt` fields with visual scene descriptions.
3. **Image generation** — For each panel, the system selects the best reference images using a hybrid cascading strategy (embedding → keyword → primary fallback), assembles a prompt with style prefix and appearance text, then calls the image API.

### Key Files

| File | Role |
|------|------|
| `js/api.js` | API client: `generateImage`, `generateImageCaption`, `generateEmbedding`, `generateRefVariation`, `buildSystemPrompt`, `compressDataUrl` |
| `js/pages/create.js` | Comic generation engine: `selectBestImage`, `buildPanelImageOpts`, `buildEnhancedImagePrompt`, `buildCompositeSheet`, `generatePage` |
| `js/pages/characters.js` | Character editor: image upload, auto-caption on upload, `generateReferences`, `recaptionAll`, embedding generation on save |
| `js/pages/worlds.js` | World editor: same pattern as characters with world-specific tags and variations |
| `js/pages/image-presets.js` | Image style preset CRUD (prompt prefix management) |
| `js/utils.js` | Utility functions: `sanitizeImagePrompt`, `buildImageEmbeddingText`, `cosineSimilarity` |
| `js/db.js` | Persistence layer: `migrateCharacter`, `migrateWorld`, IndexedDB storage |
| `js/pages/settings.js` | All image-related settings UI |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PREPARATION PHASE                                  │
│                                                                             │
│  User uploads image ──► Auto-caption (vision model) ──► Description text    │
│                                                              │              │
│                                                              ▼              │
│  [Save character/world] ──► buildImageEmbeddingText() ──► Embedding API     │
│                                                              │              │
│                                                              ▼              │
│                                            Stored: { dataUrl, tag,          │
│                                              description, embedding,        │
│                                              embeddingText }                │
│                                                                             │
│  "Generate References" ──► generateRefVariation() ──► Auto-caption ──► ...  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          GENERATION PHASE                                   │
│                                                                             │
│  buildSystemPrompt() ──► LLM stream ──► parseComicResponse() ──► panels[]   │
│       │                                                            │        │
│       │ (includes CHARACTERS,                                      │        │
│       │  VISUAL CONSISTENCY RULES,                                 │        │
│       │  IMAGE SIZES, WORLD SETTING)                               │        │
│                                                                    ▼        │
│                                                        For each panel:      │
│                                                                             │
│  1. Identify characters in panel ──► nameInPrompt()                         │
│  2. Select best ref per character ──► selectBestImage()                     │
│     ├── Embedding match (cosine similarity)                                 │
│     ├── Keyword/tag match (TAG_KEYWORDS)                                    │
│     └── Primary image fallback                                              │
│  3. Build composite sheet (if needed) ──► buildCompositeSheet()             │
│  4. Collect world reference images                                          │
│  5. Assemble prompt ──► buildEnhancedImagePrompt()                          │
│     ├── sanitizeImagePrompt() (strip narrative noise)                       │
│     ├── Prepend image style preset prefix                                   │
│     └── Append character appearance text                                    │
│  6. Build labeled refs ──► Reference legend                                 │
│  7. Compress ref images ──► compressDataUrl()                               │
│  8. Call API.generateImage() ──► NanoGPT /images/generations                │
│  9. Convert result to data URL ──► panel.imageUrl                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Settings Reference

All settings are stored in IndexedDB via `DB.getSetting(key, default)` / `DB.setSetting(key, value)`.

| Setting Key | Default | Type | Description |
|---|---|---|---|
| `enableImages` | `true` | boolean | Master toggle for AI image generation. When `false`, panels have no artwork. |
| `useRefImages` | `true` | boolean | Whether to send character/world reference images with generation requests. |
| `imageModel` | `'gpt-image-1'` | string | Image generation model ID. |
| `imageSize` | `'1024x1024'` | string | Default image resolution (WxH). Used as fallback when dynamic sizing is off or AI provides no valid size. |
| `dynamicImageSizes` | `false` | boolean | Let the AI choose per-panel image sizes from the model's supported sizes. |
| `includeAppearanceText` | `true` | boolean | Include character appearance descriptions in the system prompt and image prompts. When `false`, relies solely on reference images. |
| `charRefMode` | `'auto'` | string | Reference image selection strategy: `'auto'`, `'semantic'`, `'keyword'`, or `'composite'`. |
| `maxRefImages` | `4` | number | Maximum reference images sent per API call. Excess refs are truncated. |
| `captionModel` | `''` (empty) | string | Vision model for auto-captioning. Falls back to the text model when empty. |
| `embeddingModel` | `'text-embedding-3-small'` | string | Model for generating text embeddings. |
| `showExplicitContent` | `false` | boolean | When `true`, adds `showExplicitContent: true` to image API requests. |
| `imagePromptPrefix` | `''` | string | Legacy setting: global image prompt prefix. Superseded by image style presets. |

---

## Phase 1: Reference Image Upload and Storage

### Character Images

**File:** `js/pages/characters.js`

Each character can hold up to 12 reference images (`MAX_IMAGES = 12`). Each image is stored as an object:

```js
{
  dataUrl: 'data:image/...', // base64 data URL
  tag: 'front-view',         // one of IMAGE_TAGS
  description: '',           // auto-generated or user-entered caption
  embedding: [...],          // number array from embedding API (or null)
  embeddingText: '',         // the enriched text used to generate the embedding
  aiGenerated: false,        // true if created by generateRefVariation
  generationPrompt: '',      // prompt used to AI-generate this image (if aiGenerated)
}
```

**Available character image tags:**
`default`, `front-view`, `side-view`, `back-view`, `close-up`, `action-pose`, `alternate-outfit`, `expression`, `character-sheet`, `custom`

**Upload flow:**
1. User clicks "+ Add Image" → empty slot is added → file picker opens (`addImageSlot` → `pickImageForSlot`).
2. Selected file is converted to a data URL via `DB.fileToDataURL()`.
3. If the file picker is cancelled, the empty slot is cleaned up.
4. After upload, auto-captioning is triggered (see [Phase 2](#phase-2-auto-captioning)).

**Primary image:**
One image can be designated as "primary" via the ⭐ button (`setPrimary`). Clicking the active star deselects it (`primaryImageIndex = -1`). The primary image is the default fallback in `selectBestImage` when no better match is found.

### World Images

**File:** `js/pages/worlds.js`

Worlds follow the same pattern with up to 12 images.

**Available world image tags:**
`establishing`, `interior`, `exterior`, `aerial`, `night`, `day`, `detail`, `landmark`, `custom`

### Legacy Migration

**File:** `js/db.js`

- `DB.migrateCharacter(char)` upgrades records from the legacy single-`imageData` string field to `images[]` format. Does not persist automatically.
- `DB.migrateWorld(world)` upgrades records from the legacy `images: string[]` format to `images: [{dataUrl, tag, description}]` format. Does not persist automatically.

---

## Phase 2: Auto-Captioning

**File:** `js/api.js` → `generateImageCaption(dataUrl, contextHints, options)`

Auto-captioning uses a vision-capable LLM to generate a text description of an uploaded reference image. The caption serves two purposes:

1. **Human-readable description** displayed in the image slot.
2. **Input for embedding generation** — the caption text becomes the basis for semantic matching against panel prompts.

### When Captioning Triggers

| Trigger | Location |
|---|---|
| Image uploaded (no existing description) | `characters.js handleImage()`, `worlds.js handleImage()` |
| Manual re-caption (📝 button) | `recaptionImage(idx)` |
| Batch re-caption ("Caption All" button) | `recaptionAll()` |
| After AI reference generation | `generateReferences()`, `regenerateImage()` |

### Caption Generation Process

1. **Model selection:** Uses `captionModel` setting if set, otherwise the default text model. Skips captioning silently if the model lacks vision capability (checked via `fetchTextModels` cached data).

2. **Image compression:** The image is compressed to max 512px dimension at 0.75 JPEG quality before sending to avoid 413 payload errors.

3. **Prompt construction:** Two messages are sent:
   - **System message:** `"You are a visual description assistant for a comic book creator. Describe reference images concisely to help match them to comic panel art prompts."`
   - **User message:** Contains the compressed image and a text prompt built from `contextHints`.

4. **Context-aware prompting:** The prompt adapts based on `contextHints`:

   | `type` | `tag` | Behavior |
   |---|---|---|
   | `character` | `character-sheet` | Requests 2–3 sentences describing consistent visual traits, views/angles shown, and outfit details across poses. Uses `maxTokens: 200`. |
   | `character` | (any other) | Requests 1–2 sentences about outfit, pose, expression, notable features. Uses `maxTokens: 120`. |
   | `world` | (any) | Requests 1–2 sentences about architecture, lighting, atmosphere, scale. Uses `maxTokens: 120`. |

   When a `name` is provided, the prompt instructs the model to begin the description with that name as the subject (e.g., `"Nova wears…"`). An optional `appearance` hint provides additional context for character captioning.

5. **Temperature:** Fixed at `0.3` for caption consistency.

6. **Result:** Returns a trimmed string or `null` on failure. On success, the description is stored in `img.description` and any existing embedding is invalidated (`img.embedding = null`).

---

## Phase 3: Text Embeddings

Text embeddings power the semantic matching that selects which reference image to send for each comic panel.

### Embedding Text Construction

**File:** `js/utils.js` → `buildImageEmbeddingText(img, contextName)`

Builds an enriched text string from the image's tag, the owning character/world name, and the user-supplied description:

```
Format: "{tag} {contextName}: {description}"

Examples:
  buildImageEmbeddingText({tag:'action-pose', description:'Fist raised'}, 'Iron Man')
    → "action-pose Iron Man: Fist raised"

  buildImageEmbeddingText({tag:'default', description:'Red cape'}, 'Superman')
    → "Superman: Red cape"
    (tag 'default' is skipped as semantically empty)

  buildImageEmbeddingText({tag:'interior', description:'Dimly lit lab'}, 'Gotham')
    → "interior Gotham: Dimly lit lab"
```

Tags that are skipped (carry no meaningful semantic content): `default`, `establishing`, `custom`.

### Embedding Generation

**File:** `js/api.js` → `generateEmbedding(text, options)`

- **API endpoint:** `POST /embeddings`
- **Model:** Reads `embeddingModel` setting (default: `text-embedding-3-small`).
- **Dimensions:** Only includes the `dimensions` parameter (default 256) for models that support dimension reduction (`DIMENSION_REDUCTION_MODELS` set).
- **Returns:** A number array, or `null` on failure.

### When Embeddings Are Generated

Embeddings are generated (or regenerated) at **save time** in both `characters.js saveCharacter()` and `worlds.js saveWorld()`:

1. Filter valid images (those with `dataUrl`).
2. For each image with a non-empty `description`, compute `buildImageEmbeddingText(img, name)`.
3. Compare the result to the stored `img.embeddingText`:
   - If changed (new description, tag change, name change) or no existing embedding → re-generate.
4. Call `API.generateEmbedding(enrichedText)` in parallel for all images needing re-embedding.
5. Store both `img.embedding` (the vector) and `img.embeddingText` (the text that produced it).

### Embedding Status Badges

**Files:** `characters.js renderGallerySlots()`, `worlds.js renderGallerySlots()`

Each image slot in the editor displays an embedding status badge:

| Badge | CSS Class | Meaning |
|---|---|---|
| ✓ embedded (green) | `emb-valid` | Embedding exists and `embeddingText` matches current enriched text. |
| ↻ stale (yellow) | `emb-stale` | Embedding exists but `embeddingText` differs from current enriched text (tag/name/description changed since last save). |
| — not embedded (gray) | `emb-missing` | Image has a description but no embedding yet (save to generate). |

---

## Phase 4: AI Reference Generation

Users can automatically generate tagged reference image variations from a single uploaded source image.

### Character Reference Variations

**File:** `js/api.js` → `CHARACTER_REF_VARIATIONS`

| Tag | Prompt | Description |
|---|---|---|
| `front-view` | Full front view, standing upright facing viewer, neutral pose, full body, clean background | Front-facing full body reference |
| `side-view` | Side profile view, standing facing right, full body, clean background | Side profile reference |
| `back-view` | Back view, standing facing away from viewer, full body, clean background | Rear view reference |
| `close-up` | Close-up portrait, detailed face and expression, head and shoulders, clean background | Close-up face/portrait reference |
| `action-pose` | Dynamic action pose, mid-motion, energetic composition, clean background | Dynamic action pose reference |
| `expression` | Expressive portrait, showing strong emotion, detailed facial features, clean background | Emotional expression reference |

Character prompts are **reference-image-centric** — the model derives appearance from the visual reference, not from text placeholders.

### World Reference Variations

**File:** `js/api.js` → `WORLD_REF_VARIATIONS`

| Tag | Prompt Template | Description |
|---|---|---|
| `aerial` | Aerial bird's-eye view of `{name}`, `{description}`, wide panoramic perspective | Aerial panoramic view |
| `interior` | Interior view of a key location inside `{name}`, `{description}`, detailed architecture | Interior environment detail |
| `night` | Night scene of `{name}`, `{description}`, dark atmosphere with dramatic lighting | Night atmosphere reference |
| `detail` | Close-up architectural/environmental detail of `{name}`, `{description}`, texture/material focus | Close-up environment detail |

World prompts use `{name}` and `{description}` placeholders that are replaced at generation time.

### Generation Flow

**Files:** `characters.js generateReferences()`, `worlds.js generateReferences()`

1. Select the source image: the user-selected primary image, or first image with data as fallback.
2. Determine which variation tags do not already exist in the gallery.
3. Limit batch to available gallery slots (`MAX_IMAGES - existing`).
4. For each variation:
   a. Call `API.generateRefVariation(sourceDataUrl, prompt)`.
   b. `generateRefVariation` reads the user's configured `imageSize` setting for resolution.
   c. The source image is sent as `imageDataUrl` in the API request.
   d. If the API returns a URL, it is fetched and converted to a data URL.
   e. The new image is added to the editor gallery with `aiGenerated: true` and `generationPrompt` stored.
   f. Auto-captioning runs on the generated image.
5. Gallery is refreshed after each successful generation.

### Regeneration

Individual AI-generated images can be regenerated via the 🔄 button (`regenerateImage`). This re-uses the stored `generationPrompt` (or re-derives from the tag variation) and calls `generateRefVariation` again, then re-captions.

---

## Phase 5: Comic Creation Setup

**File:** `js/pages/create.js` → `startGenerating()`

When the user clicks "Generate First Page":

1. **Load characters:** Fetch all selected character records from IndexedDB.
2. **Load world:** Fetch the selected world record (if any).
3. **Collect reference images** (if `useRefImages` is enabled):
   - For each character, call `DB.migrateCharacter()` and store all images in `characterImagesByName[name]` with `primaryImageIndex`.
   - The primary image is also stored in the flat `referenceImages[]` array for legacy compatibility.
   - For the selected world, call `DB.migrateWorld()` and add all world images to `referenceImages[]` with label, tag, description, and type.
4. **Load prompt preset** (if selected): Provides custom `systemPrompt`, `temperature`, `topP`, `maxTokens`.
5. **Load image preset** (if selected): Provides `promptPrefix` for image prompts.
6. **Determine dynamic sizing:** If `dynamicImageSizes` is enabled, fetch the image model's supported sizes via `API.getModelSizes()`.
7. **Build system prompt:** Call `API.buildSystemPrompt()` (see [Phase 6](#phase-6-story-generation-text)).
8. **Build user message:** Requests the first comic page with genre and title context.
9. **Create comic record** in IndexedDB.
10. **Begin page generation** via `generatePage()`.

---

## Phase 6: Story Generation (Text)

### System Prompt Construction

**File:** `js/api.js` → `buildSystemPrompt(genre, characters, world, customSystemPrompt, options)`

The system prompt instructs the LLM to produce JSON with specific panel structure. Key sections:

1. **Base prompt:** Custom system prompt (from preset) or default genre-specific intro.
2. **JSON structure:** Defines the exact response format with `title`, `panels[]`, and `choices[]`.
3. **Panel requirements:** Each panel must have `narration`, `imagePrompt`, and `dialogue[]`. Optionally includes `imageSize` when dynamic sizing is enabled.
4. **Character naming rules** (CRITICAL section):
   - When `includeAppearanceText` is `true`: Every panel's `imagePrompt` must explicitly name every visible character with their full appearance description inline.
   - When `includeAppearanceText` is `false`: Characters must still be named (for embedding matching), but full appearance descriptions are omitted. Reference images handle visual consistency.
5. **IMAGE SIZES** (conditional): When dynamic sizing is enabled and the model supports multiple sizes, lists available sizes with composition guidance (landscape for panoramic, portrait for close-ups, square for balanced scenes).
6. **CHARACTERS section:** Lists each character with description, role, appearance (when enabled), and abilities.
7. **VISUAL CONSISTENCY RULES:** Instructs the AI to maintain character appearance across all panels. Adapts based on `includeAppearanceText`.
8. **WORLD SETTING:** Includes world name, description, details, and atmosphere.

### Story Streaming

**File:** `js/pages/create.js` → `generatePage()`

1. Trim conversation history to `contextExchanges` recent exchanges (preserves system prompt and first user message).
2. Stream the response via `API.chatCompletionStream()`, displaying tokens in real time.
3. Parse the completed response via `API.parseComicResponse()`:
   - Strips markdown code fences.
   - Extracts JSON between first `{` and last `}`.
   - On parse failure, attempts `repairTruncatedJson()` to close unclosed strings/brackets.
   - Returns structured `{ title, panels[], choices[] }`.

---

## Phase 7: Per-Panel Image Generation

**File:** `js/pages/create.js` → inside `generatePage()`

After the story text is parsed, all panels with `imagePrompt` are processed **in parallel** via `Promise.all()`.

### Step 1: Reference Image Selection — `selectBestImage()`

For each character named in the panel's `imagePrompt` (detected via `nameInPrompt()` which uses word-boundary regex matching), the system selects the best reference image from that character's gallery using a **hybrid cascading strategy**:

```
selectBestImage(charImages, panelPromptText, charName, primaryImageIndex)
│
├─ If only 1 valid image → return it
│
├─ 1. EMBEDDING MATCH (unless charRefMode === 'keyword')
│  ├─ Filter images with stored embeddings
│  ├─ Generate embedding for panel's imagePrompt text (cached per page)
│  ├─ Compute cosineSimilarity() between panel embedding and each image embedding
│  └─ Return the highest-scoring image
│  (Falls through if no embeddings available or embedding fetch fails)
│
├─ 2. KEYWORD/TAG MATCH (unless charRefMode === 'semantic')
│  ├─ For each image, check if TAG_KEYWORDS[image.tag] keywords appear in the prompt
│  ├─ Score = count of matching keywords
│  └─ Return the image with the highest score (if > 0)
│  (Falls through if no keyword matches)
│
└─ 3. PRIMARY IMAGE FALLBACK
   └─ Return image at primaryImageIndex, or first valid image if index is invalid
```

**`charRefMode` setting controls the cascade:**

| Mode | Behavior |
|---|---|
| `auto` (default) | Try embedding → keyword → primary. Full cascade. |
| `semantic` | Embedding only (skip keyword fallback). Falls directly to primary if no embeddings. |
| `keyword` | Keyword only (skip embedding). Falls to primary if no keyword match. |
| `composite` | Always builds a composite character sheet (see below). |

**TAG_KEYWORDS map** (used for keyword/tag matching):

| Tag | Keywords |
|---|---|
| `front-view` | front, facing, standing, full body, looking at |
| `side-view` | profile, side view, side-on, looking away |
| `back-view` | behind, back view, from behind, walking away, rear |
| `close-up` | close-up, closeup, face, portrait, headshot, expression, eyes |
| `action-pose` | running, jumping, flying, fighting, action, dynamic, leaping, attacking, battle |
| `alternate-outfit` | casual, civilian, disguise, formal, armor, costume change |
| `expression` | angry, sad, happy, shocked, scared, crying, laughing, smiling |
| `character-sheet` | character sheet, turnaround, model sheet, reference sheet, multiple angles, multiple poses, multi-angle, multi-pose, full rotation, 360, orthographic |

### Step 2: Build Panel Image Options — `buildPanelImageOpts()`

1. **Resolve image resolution:**
   - If `dynamicImageSizes` is enabled and the AI provided a valid `imageSize` (matches `/^\d+x\d+$/i`), use it.
   - Otherwise, use the user's configured `imageSize` setting.

2. **Identify characters in panel:** Check each character name against the panel's `imagePrompt` using `nameInPrompt()`.

3. **Select best image per character** via `selectBestImage()`.

4. **Composite sheet decision:** If multiple characters exceed the `maxRefImages` budget, or `charRefMode === 'composite'`, build a composite sheet:
   - `buildCompositeSheet()` creates a canvas grid (256px cells, max 2 columns) with each character's selected image and a labeled overlay.
   - A text legend is generated: `"Character sheet grid. top-left: Nova (action-pose). top-right: Blaze (front-view). Match each character's appearance exactly as shown in their labeled section."`
   - The composite image is sent as a single reference.

5. **Build labeled references:** Each reference includes `dataUrl`, `label` (name), `tag`, `description`, and `type` (`'character'` or `'world'`).

6. **Combine character and world references** into the panel's options object.

### Step 3: Build Enhanced Image Prompt — `buildEnhancedImagePrompt()`

1. **Sanitize the AI's imagePrompt** via `sanitizeImagePrompt()`:
   - Removes quoted dialogue (up to 200 chars).
   - Strips narrative lead-ins ("Meanwhile…", "Little did they know…", "Cut to…").
   - Strips internal states ("Thinking about…", "Feeling conflicted…").
   - Collapses whitespace and orphaned punctuation.
   - Falls back to the original prompt if sanitization removes all content.

2. **Prepend image style prefix** (if an image preset is selected or legacy `imagePromptPrefix` is set):
   ```
   "{promptPrefix}, {sanitized prompt}"
   ```

3. **Append character appearance text** (if `includeAppearanceText` is enabled):
   - For each character named in the panel's `imagePrompt` who has a non-empty `appearance` field:
     ```
     "{prompt}. Characters in scene: Nova: tall woman with silver hair, black armor; Blaze: stocky man with flame tattoos"
     ```

### Step 4: Call the Image API — `API.generateImage()`

**File:** `js/api.js` → `generateImage(prompt, options)`

1. **Collect reference images:**
   - Reads `maxRefImages` setting (default 4). Truncates if more are provided.
   - Compresses each reference via `compressDataUrl()` (max 1024px, 0.85 JPEG quality).

2. **Build reference legend** (when `labeledRefs` are provided):
   - For each labeled ref, generates a description line:
     - **Character refs:** `"Reference image 1: Nova — action-pose (character reference). Replicate this character's exact appearance, proportions, outfit, and distinguishing features precisely as shown."`
     - **World refs:** `"Reference image 2: Neo-Tokyo — neon-lit streets (world reference). Use this as an environment and style reference — match the architecture, lighting, and atmosphere."`
   - The legend is prepended to the prompt text.

3. **Build API request body:**
   ```json
   {
     "model": "<imageModel>",
     "prompt": "<legend + enhanced prompt>",
     "size": "<resolution>",
     "n": 1,
     "imageDataUrls": ["<compressed ref 1>", "<compressed ref 2>"],
     "showExplicitContent": true
   }
   ```
   The `showExplicitContent` field is only included when the setting is enabled. The `imageDataUrls` field is only included when reference images are present.

4. **Send request** to `POST /images/generations`.

5. **Handle response:**
   - URL result → fetched and converted to base64 data URL for offline storage.
   - base64 result → prefixed with `data:image/png;base64,`.
   - Stored as `panel.imageUrl`.

### Step 5: Progress Reporting

During generation, the UI displays progress:
- `"Generating images (0 / N)..."` → increments as each panel completes.
- Panels are generated in parallel for speed.

---

## Image Style Presets

**File:** `js/pages/image-presets.js`

Image style presets define reusable prompt prefixes that are prepended to every panel's image prompt when the preset is selected during comic creation.

### Preset Structure

```js
{
  id: 'unique-id',
  name: 'Watercolor',
  description: 'Soft painterly watercolor aesthetic',
  promptPrefix: 'watercolor painting, soft edges, gentle color washes, artistic, painterly',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}
```

### Seed Presets

Five built-in presets are seeded by `DB.seedDefaults()` on first run:

| Name | Prompt Prefix |
|---|---|
| Comic Book Ink | bold ink outlines, comic book art style, halftone shading, dynamic composition, vibrant colors |
| Photorealistic | photorealistic, ultra detailed, 8K resolution, cinematic lighting, hyper realistic |
| Anime / Manga | anime style, manga art, cel shading, vibrant colors, expressive characters |
| Watercolor | watercolor painting, soft edges, gentle color washes, artistic, painterly |
| 3D Render | 3D render, CGI, volumetric lighting, physically based rendering, high detail, studio quality |

### Usage in Generation

In `create.js generatePage()`:
1. The selected image preset is loaded from IndexedDB.
2. Its `promptPrefix` is passed to `buildEnhancedImagePrompt()`.
3. The prefix is prepended to the sanitized panel prompt: `"{promptPrefix}, {panel prompt}"`.
4. If no image preset is selected, the legacy `imagePromptPrefix` setting is checked as a fallback.

---

## Image Compression

**File:** `js/api.js` → `compressDataUrl(dataUrl, maxDim, quality)`

Images are compressed before being sent to the API to avoid HTTP 413 payload errors.

| Context | Max Dimension | JPEG Quality |
|---|---|---|
| Reference images in `generateImage()` | 1024px | 0.85 |
| Caption input in `generateImageCaption()` | 512px | 0.75 |

Process:
1. Load image into an `Image` element.
2. If either dimension exceeds `maxDim`, scale proportionally.
3. Draw onto a `canvas` element.
4. Export as `image/jpeg` at the given quality.
5. On error, return the original data URL unchanged.

---

## Reference Legend Construction

**File:** `js/api.js` → inside `generateImage()`

When `labeledRefs` are provided, a text legend is prepended to the image prompt to describe what each reference image represents. This helps the image model understand the purpose of each reference.

### Legend Format

For each labeled reference (up to `maxRefImages`):
```
Reference image {i}: {label}{details} ({type} reference). {instruction}
```

**Instructions by type:**

| Type | Instruction |
|---|---|
| `character` | "Replicate this character's exact appearance, proportions, outfit, and distinguishing features precisely as shown." |
| `world` | "Use this as an environment and style reference — match the architecture, lighting, and atmosphere." |
| (default) | "Use this as a visual reference." |

**Details field:**
- If the ref has a `description`, it is appended as ` — {description}`.
- Otherwise, if the ref has a non-default `tag`, it is appended as ` ({tag})`.

---

## Error Handling and Fallbacks

### Caption Failures
- `generateImageCaption()` returns `null` on any failure (no API key, non-vision model, API error).
- The description field is left empty; the user can manually enter a description or retry.
- Errors are logged via `App.logError()`.

### Embedding Failures
- `generateEmbedding()` returns `null` on failure.
- Images without embeddings fall through to keyword or primary fallback in `selectBestImage()`.
- A warning is logged when falling back.

### Image Generation Failures
- Per-panel failures are caught individually — other panels still generate.
- Error toast is shown to the user.
- The panel renders with either a placeholder gradient showing the truncated `imagePrompt` text, or no image.

### JSON Parse Failures
- `parseComicResponse()` attempts `repairTruncatedJson()` on initial parse failure.
- Repair closes unclosed string literals, removes trailing commas, and appends missing closing brackets/braces.
- If repair also fails, returns `null` and the generation is aborted with an error toast.

### Reference Image Overflow
- When total references (characters + world) exceed `maxRefImages`, the composite sheet strategy kicks in (if `charRefMode` is `composite` or the overflow is detected).
- The `generateImage()` function also truncates `imageDataUrls` to `maxRefImages` with a console warning.

### Sanitization Fallback
- If `sanitizeImagePrompt()` removes all content from a prompt, it logs a warning and returns the original unsanitized prompt.
