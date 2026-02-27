# AI Comic Creator

A fully installable Progressive Web App for creating AI-generated comic books with interactive narratives, custom characters, and detailed world-building. Powered by [NanoGPT](https://nano-gpt.com) and optimized for Android devices running Termux.

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
- Upload reference images stored locally as data URLs
- Characters are injected into the AI system prompt for consistent storytelling

### World Builder
- Design detailed story settings with name, description, era, and atmosphere
- Upload up to 3 reference images per world
- World context is fed to the AI to maintain setting consistency across pages

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

### Running in Termux (Android)

```bash
# 1. Install git and python
pkg install git python

# 2. Clone the repository
git clone https://github.com/dkylepeppers-alt/Comiccreator.git
cd Comiccreator

# 3. Start the server
chmod +x server.sh
./server.sh
```

The server starts on **http://localhost:8080** by default. Open this URL in Chrome or Brave on your device.

**Custom port:**
```bash
PORT=3000 ./server.sh
```

### Installing as a PWA

1. Open `http://localhost:8080` in Chrome or Brave
2. Tap the browser menu (three dots)
3. Select **"Install app"** or **"Add to Home screen"**
4. The app now launches as a standalone application

### Other Environments

Any static HTTP server works. The app is pure HTML/CSS/JS with zero build dependencies.

```bash
# Python
python3 -m http.server 8080

# Node.js
npx serve -s -l 8080

# PHP
php -S 0.0.0.0:8080
```

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
├── server.sh               Termux-optimized HTTP server launcher
├── generate-icons.html     Browser-based icon generator utility
│
├── css/
│   └── app.css             Complete UI (dark theme, responsive, mobile-first)
│
├── js/
│   ├── db.js               IndexedDB storage layer (6 object stores)
│   ├── api.js              NanoGPT API client (streaming SSE, image gen)
│   ├── app.js              SPA router, navigation, modals, toasts
│   │
│   └── pages/
│       ├── home.js         Dashboard with stats, recent comics, genre grid
│       ├── characters.js   Character CRUD with image upload
│       ├── worlds.js       World CRUD with multi-image upload
│       ├── create.js       Comic generation engine (setup → stream → read → branch)
│       ├── library.js      Comic viewer and PDF export
│       ├── presets.js      Prompt preset editor with sampler controls
│       └── settings.js     API config, model params, data management
│
└── icons/
    ├── icon.svg            Vector logo
    ├── icon-192.png        PWA icon (small)
    └── icon-512.png        PWA icon (large)
```

**Zero dependencies.** No npm, no bundler, no framework. Every file is hand-written vanilla HTML, CSS, and JavaScript that runs directly in the browser.

### Data Model

| Store | Key | Contents |
|-------|-----|----------|
| `characters` | `id` | Name, role, description, appearance, backstory, powers, reference image |
| `worlds` | `id` | Name, description, era, atmosphere, details, up to 3 images |
| `comics` | `id` | Title, genre, character/world/preset refs, page count, conversation history |
| `pages` | `id` (indexed by `comicId`) | Page number, panel data (narration, image prompts/URLs, dialogue), choices |
| `presets` | `id` | Name, system prompt, temperature, top-p, max tokens, penalties |
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

## License

MIT
