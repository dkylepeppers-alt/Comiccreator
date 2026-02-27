# CLAUDE.md

## Project Overview

AI Comic Creator is a vanilla JavaScript Progressive Web App (PWA) that generates AI-powered comic books with interactive narratives, custom characters, and world-building. It uses the NanoGPT API (OpenAI-compatible) for text and image generation.

## Architecture

- **No build system** — pure HTML/CSS/JS, no npm, no bundler, no transpilation
- **No server-side code** — static files served via any HTTP server
- **Storage** — IndexedDB (via `js/db.js`) for all persistent data: characters, worlds, comics, pages, presets, settings
- **API** — NanoGPT (`https://nano-gpt.com/api/v1`, OpenAI-compatible) for chat completions and image generation
- **Offline** — Service worker (`sw.js`) caches app shell; API calls bypass cache

## File Structure

```
index.html          App shell and navigation
manifest.json       PWA manifest
sw.js               Service worker (cache-first for app shell)
server.sh           Local dev server launcher
css/app.css         All styles (dark theme, mobile-first)
js/
  db.js             IndexedDB wrapper (6 object stores)
  api.js            NanoGPT API client with SSE streaming
  app.js            SPA router and navigation
  pages/
    home.js         Dashboard
    characters.js   Character CRUD
    worlds.js       World CRUD
    create.js       Comic generation engine
    library.js      Comic viewer and PDF export
    presets.js      Prompt preset editor
    settings.js     API config and data management
icons/              PWA icons (SVG + PNG)
```

## Running Locally

```bash
# Python (default)
python3 -m http.server 8080

# Or use the helper script
chmod +x server.sh && ./server.sh

# Node.js alternative
npx serve -s -l 8080
```

Open `http://localhost:8080` in a browser. No install step needed.

## Development Guidelines

### Making Changes

- Edit `.js`, `.css`, or `.html` files directly — changes take effect on browser reload
- Hard-refresh (`Ctrl+Shift+R`) to bypass the service worker cache during development
- All modules use ES2020+ syntax (no transpilation target)

### Code Style

- Vanilla JS only — no frameworks, no libraries, no CDN imports
- Use `async/await` for asynchronous code
- Keep page modules self-contained in `js/pages/`
- Follow the existing pattern: each page module exports a `render()` function called by the router in `app.js`

### Data Model

IndexedDB stores managed by `js/db.js`:

| Store | Key | Description |
|-------|-----|-------------|
| `characters` | `id` (auto) | Character profiles |
| `worlds` | `id` (auto) | World/setting profiles |
| `comics` | `id` (auto) | Comic metadata |
| `pages` | `id` (auto) | Individual comic pages |
| `presets` | `id` (auto) | Prompt presets |
| `settings` | `key` | App settings (API key, model choices) |

### API Integration

The NanoGPT API client in `js/api.js` supports:
- Streaming text via Server-Sent Events (SSE)
- Image generation (GPT-Image-1, DALL·E 3, Flux, SDXL)
- Dynamic model listing from `/models` endpoint

API key and model selections are stored in the `settings` IndexedDB store and configured in the Settings page.

### Service Worker

`sw.js` uses a cache-first strategy for the app shell. When modifying cached assets, bump the `CACHE_NAME` version constant in `sw.js` to force cache invalidation.

## No Tests

There are no automated tests. Manual QA: exercise all pages, generate a comic end-to-end, verify offline mode, and test PDF export.
