# AI Comic Creator

A fully installable Progressive Web App for creating AI-generated comic books with interactive narratives, custom characters, and detailed world-building. Powered by [NanoGPT](https://nano-gpt.com).

**Live demo (GitHub Pages):** [https://dkylepeppers-alt.github.io/Comiccreator/](https://dkylepeppers-alt.github.io/Comiccreator/)

---

## Features

### Comic Generation
- **AI-Powered Stories** — Multi-turn streaming text generation produces structured comic pages with narration, dialogue, and visual descriptions
- **Interactive Narratives** — Each page ends with 2–3 branching choices that shape the story, or write your own custom direction
- **AI Artwork** — Optional per-panel image generation using models like GPT-Image-1, DALL·E 3, Flux, or Stable Diffusion XL
- **9 Built-in Genres** — Classic Horror, Superhero Action, Dark Sci-Fi, High Fantasy, Neon Noir Detective, Wasteland Apocalypse, Comedy, Teen Drama, plus a fully Custom genre option

### Character Builder
- Create heroes, sidekicks, villains, antiheroes, mentors, and support characters
- Define name, description, appearance, backstory, and powers/abilities
- Upload up to 20 reference images per character; tag each as front-view, side-view, close-up, action-pose, and more
- AI auto-captioning and semantic embeddings enable per-panel reference image selection
- Characters are injected into the AI system prompt for consistent storytelling

### World Builder
- Design detailed story settings with name, description, era, and atmosphere
- Upload up to 20 reference images per world with aerial, interior, night, and detail variation tags
- World context is fed to the AI to maintain setting consistency across pages

### Image Style Presets
- Create reusable art-style prompt prefixes (e.g., "watercolor illustration, soft colors, hand-drawn")
- Select an image style preset at generation time to apply a consistent visual style across all panels
- Includes built-in defaults such as Comic Book Ink, Photorealistic, Anime / Manga, Watercolor, and 3D Render styles

### Prompt Presets & Advanced Controls
- **Preset System** — Save reusable configurations with custom system prompts and sampler parameters
- **Per-Session Overrides** — Temperature, Top-P, and Max Tokens sliders directly on the creation page
- **Sampler Parameters** — Temperature (0–2), Top-P (0–1), Max Tokens (256–8192), Frequency Penalty (0–2), Presence Penalty (0–2)
- **3 Default Presets** — Balanced (temp 0.7), Creative (temp 1.0), Precise (temp 0.3)

### Export & Storage
- **PDF Export** — Print-optimized HTML with cover page, proper pagination, and dialogue bubbles
- **JSON Backup** — Export/import all data (characters, worlds, comics, presets)
- **IndexedDB** — All data stored locally in the browser for privacy and offline access
- **Offline Support** — Service worker caches the entire app shell for use without a network connection

### PWA
- Installable as a standalone app on Android, iOS, and desktop
- Portrait orientation, dark theme, maskable icons
- Full-screen standalone display mode

---

## Quick Start

### GitHub Pages (no install required)

The app is deployed at **[https://dkylepeppers-alt.github.io/Comiccreator/](https://dkylepeppers-alt.github.io/Comiccreator/)**.

Open the URL in Chrome or Brave, enter your NanoGPT API key in Settings, and start creating comics. You can install it as a PWA directly from the browser.

> **Subpath note:** The app is served from `/Comiccreator/` on GitHub Pages. The service worker and manifest are configured for this subpath automatically — no manual changes are needed.

### Running locally (developers)

Any static HTTP server works. The app is pure HTML/CSS/JS with zero build dependencies.

```bash
# Python
python3 -m http.server 8080

# Node.js
npx serve -s -l 8080

# PHP
php -S 0.0.0.0:8080
```

Then open `http://localhost:8080` in Chrome or Brave.

> **Testing locally vs. GitHub Pages:** When running locally, `sw.js` is served from `/sw.js` so `BASE_PATH` is `""` and all assets are cached with absolute root paths (e.g. `/index.html`). On GitHub Pages, `sw.js` is served from `/Comiccreator/sw.js` so `BASE_PATH` is `/Comiccreator` and assets are cached with subpath-prefixed URLs. The same `sw.js` file handles both cases automatically.

### Installing as a PWA

1. Open the app URL in Chrome or Brave
2. Tap the browser menu (three dots)
3. Select **"Install app"** or **"Add to Home screen"**
4. The app now launches as a standalone application

---

## Updating

The app on GitHub Pages is updated automatically on every push to the default branch. After a new version is deployed:

1. Open the app in your browser
2. Go to **Settings → App Updates → Check for Updates** to see if a newer version is available
3. If an update is found, click **"Reload & Apply Update"** — this clears the service worker cache and reloads the page

After a hard-refresh (`Ctrl+Shift+R`) or clearing site data, your browser will load the latest version from GitHub Pages.

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Browser shows old version after update | Hard-refresh (`Ctrl+Shift+R`), or clear browser site data for the app URL |
| `Check for Updates` fails in-app | Ensure you have internet access; the check fetches from GitHub |

---

## Configuration

On first launch you'll be directed to **Settings**. The only required configuration is your NanoGPT API key.

### API Key

1. Create an account at [nano-gpt.com](https://nano-gpt.com)
2. Generate an API key from the dashboard
3. Paste it into **Settings → NanoGPT API Key**

### Available Models

| Category | Models |
|----------|--------|
| **Text** | `gpt-4o-mini`, `gpt-4o`, `gpt-4.1-mini`, `gpt-4.1-nano`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `deepseek-chat`, `deepseek-reasoner`, `gemini-2.0-flash`, `gemini-2.5-pro-preview-05-06`, `llama-3.3-70b`, `mistral-large-latest` |
| **Image** | `gpt-image-1`, `dall-e-3`, `flux-1.1-pro`, `stable-diffusion-xl` |

Image generation can be disabled in Settings to save API credits (text-only comics).

### Image Sizes

`1024x1024` (default) · `1024x1792` · `1792x1024` · `512x512`

---

## Architecture

```
Comiccreator/
├── index.html              Main app shell
├── manifest.json           PWA manifest
├── sw.js                   Service worker (offline caching)
├── version.json            App version metadata
├── generate-icons.html     Browser-based icon generator utility
│
├── css/
│   └── app.css             Complete UI (dark theme, responsive, mobile-first)
│
├── js/
│   ├── utils.js            Shared helpers (escHtml, timeAgo, GENRES, cosineSimilarity, etc.)
│   ├── db.js               IndexedDB storage layer (7 object stores)
│   ├── api.js              NanoGPT API client (streaming SSE, image gen, embeddings, captions)
│   ├── app.js              SPA router, navigation, modals, toasts
│   │
│   └── pages/
│       ├── home.js         Dashboard with stats, recent comics, genre grid
│       ├── characters.js   Character CRUD with multi-image upload (up to 20 per character)
│       ├── worlds.js       World CRUD with multi-image upload (up to 20 per world)
│       ├── create.js       Comic generation engine (setup → stream → read → branch)
│       ├── library.js      Comic viewer and PDF export
│       ├── presets.js      Prompt preset editor with sampler controls
│       ├── image-presets.js  Image style preset editor (art-style prompt prefixes)
│       └── settings.js     API config, model params, data management
│
└── icons/
    ├── icon.svg            Vector logo
    ├── icon-192.png        PWA icon (small)
    └── icon-512.png        PWA icon (large)
```

### Data Model

| Store | Key | Contents |
|-------|-----|----------|
| `characters` | `id` | Name, role, description, appearance, backstory, powers, reference images array (up to 20) |
| `worlds` | `id` | Name, description, era, atmosphere, details, reference images array (up to 20) |
| `comics` | `id` | Title, genre, character/world/preset refs, page count, conversation history |
| `pages` | `id` (indexed by `comicId`) | Page number, panel data (narration, image prompts/URLs, dialogue), choices |
| `presets` | `id` | Name, system prompt, temperature, top-p, max tokens, penalties |
| `imagePresets` | `id` | Name, description, prompt prefix (art-style string prepended to every panel image prompt) |
| `settings` | `key` | API key, model selections, default parameters |

### Service Worker Strategy

| Request Type | Strategy | Fallback |
|-------------|----------|----------|
| Static assets (app shell) | Cache-first | Network fetch + cache |
| NanoGPT API calls | Network only | Error message |
| Navigation (offline) | Cache-first | Cached `index.html` |

---

## Comic Generation Flow

```
┌─────────────────────────────────────────────────┐
│  1. SETUP                                       │
│  Select genre → Pick characters → Choose world  │
│  Select preset → Enter title & opening prompt   │
│  (Optional: override sampler parameters)        │
└──────────────────────┬──────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────┐
│  2. GENERATE                                    │
│  System prompt built with full context          │
│  Streamed response from NanoGPT API (SSE)       │
│  JSON parsed into panels with dialogue/narration│
│  AI images generated per panel (if enabled)     │
│  Page saved to IndexedDB                        │
└──────────────────────┬──────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────┐
│  3. READ & CHOOSE                               │
│  Comic page displayed with panels and dialogue  │
│  Reader picks from 2-3 AI-generated choices     │
│  Or writes a custom story direction             │
│  Conversation history maintained for coherence  │
└──────────────────────┬──────────────────────────┘
                       ▼
              ┌────────┴────────┐
              │  Continue?      │
              │  Yes → Step 2   │
              │  No  → Finish   │
              └─────────────────┘
```

Each generated page follows this JSON structure:

```json
{
  "title": "The Dark Awakening",
  "panels": [
    {
      "narration": "The city slept beneath a fractured sky...",
      "imagePrompt": "A dark cityscape at night with neon signs reflecting off wet streets, cyberpunk style, wide angle shot",
      "dialogue": [
        { "speaker": "Nova", "text": "Something's wrong. I can feel it." },
        { "speaker": "Kai", "text": "You always say that before things get interesting." }
      ]
    }
  ],
  "choices": [
    { "text": "Investigate the disturbance at the old factory", "summary": "Action-oriented path" },
    { "text": "Return to headquarters for backup", "summary": "Cautious approach" }
  ]
}
```

---

## Offline Behavior

The service worker pre-caches the entire application shell on first visit. After that:

- **App navigation** works fully offline
- **Previously generated comics** are readable offline (stored in IndexedDB)
- **Downloaded images** persist offline (stored as data URLs)
- **New comic generation** requires a network connection (API calls)
- **Settings and data management** work offline

---

## Data Management

### Export

**Settings → Export All Data** saves a JSON file containing all characters, worlds, comics, pages, and presets. Images are included as base64 data URLs.

### Import

**Settings → Import Data** merges a previously exported JSON file into the current database. Existing items with the same IDs are overwritten.

### Clear

**Settings → Clear All Data** permanently deletes everything. This action requires confirmation and cannot be undone.

---

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome / Brave (Android) | Full support, PWA install |
| Firefox (Android) | Full support, PWA install |
| Chrome (Desktop) | Full support, PWA install |
| Safari (iOS 16.4+) | Full support, Add to Home Screen |
| Edge | Full support, PWA install |

Requires a browser with support for:
- IndexedDB
- Service Workers
- Fetch API with ReadableStream (for SSE streaming)
- ES2020+ (optional chaining, nullish coalescing)

---

## Contributing

### Version Management

**Every merge to `Main` must include a version bump.** This keeps the service worker cache in sync and ensures users always receive the latest assets.

The version appears in **five places** that must all match. Use the bump script to update them atomically:

```bash
bash scripts/bump-version.sh patch   # e.g. 1.6.30 → 1.6.31
bash scripts/bump-version.sh minor   # e.g. 1.6.30 → 1.7.0
bash scripts/bump-version.sh major   # e.g. 1.6.30 → 2.0.0
```

If you must update manually, change all five locations:

1. **`version.json`** — increment the version number and update the date:
   ```json
   {
     "version": "1.6.31",
     "updated": "2026-03-09"
   }
   ```

2. **`sw.js`** — set `CACHE_NAME` to match:
   ```js
   const CACHE_NAME = 'comic-creator-v1.6.31';
   ```

3. **`js/pages/settings.js`** — set `APP_VERSION` to match:
   ```js
   const APP_VERSION = '1.6.31';
   ```

4. **`index.html`** — update the sidebar footer:
   ```html
   <small>v1.6.31 &middot; PWA</small>
   ```

5. **`package.json`** — set `"version"` to match:
   ```json
   "version": "1.6.31"
   ```

> **Versioning convention:** Use [semantic versioning](https://semver.org/) — `MAJOR.MINOR.PATCH`.
> Increment `PATCH` for bug fixes, `MINOR` for new features, `MAJOR` for breaking changes.

Keeping `CACHE_NAME` and `APP_VERSION` in sync with `version.json` ensures the service worker invalidates the old cache on next load, forcing browsers to fetch updated assets. The Settings page uses `APP_VERSION` to display the current version number.

On every push to `Main`, `.github/workflows/auto-bump.yml` automatically runs a patch bump and pushes the result, so manual bumps are only needed before merging features that warrant a minor or major increment.

---

### GitHub Pages Deployment

The app is automatically deployed to GitHub Pages via `.github/workflows/deploy-pages.yml` on every push to the `Main` branch or via manual `workflow_dispatch`. The workflow uses the official GitHub Pages actions:

- `actions/configure-pages` — configures the Pages environment
- `actions/upload-pages-artifact` — uploads only the runtime site assets (HTML, CSS, JS, icons, SW, manifest)
- `actions/deploy-pages` — publishes the artifact

The deployed URL is: **https://dkylepeppers-alt.github.io/Comiccreator/**

**Subpath caveats:**
- `manifest.json` uses `"start_url": "./"` (relative) so it resolves correctly under `/Comiccreator/`.
- `sw.js` computes `BASE_PATH` from `new URL(self.registration.scope).pathname` at runtime, so all cached asset URLs are automatically prefixed with `/Comiccreator` on GitHub Pages and with `""` when running locally.
- `.nojekyll` at the repo root prevents GitHub Pages from treating underscore-prefixed files specially.
- After a new deployment, users may need to hard-refresh (`Ctrl+Shift+R`) or clear site data to force the service worker to pick up the new cache version.

### CI Workflows

| Workflow | Trigger | Steps |
|----------|---------|-------|
| `tests.yml` | Push / PR (all branches) | `npm ci` → `check-syntax` → `lint` → `npm test` |
| `playwright.yml` | Push / PR (all branches) | Install Chromium → `npm run test:e2e`; uploads report artifact |
| `auto-bump.yml` | Push to `Main` (non-bot) | Runs `bump-version.sh patch`, commits, pushes |
| `deploy-pages.yml` | Push to `Main` / manual | Deploys static assets to GitHub Pages |
| `release.yml` | Manual `workflow_dispatch` | Runs all checks → bumps version → tags → creates GitHub Release |
| `security.yml` | Weekly schedule / manual | `npm audit --audit-level=high` |

---

## License

MIT
