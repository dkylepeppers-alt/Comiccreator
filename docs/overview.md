# AI Comic Creator — App Overview

AI Comic Creator is a fully installable Progressive Web App (PWA) for generating AI-powered comic books entirely in the browser. It combines interactive branching narratives, per-panel AI artwork, and flexible character and world builders — with no backend server required. All user data lives locally in the browser; the app works offline after the first install (AI API calls require an internet connection).

---

## What It Does

- **Generates structured comic pages** from natural-language prompts, streaming text via the NanoGPT API in real time.
- **Branches the story** — each page ends with 2–3 choices that shape the next page, or the creator can write a custom direction.
- **Renders per-panel AI artwork** using NanoGPT (supports gpt-image-1, dall-e-3, flux, stable-diffusion-xl, and others).
- **Exports finished comics** as paginated PDFs with a cover page, narration, and dialogue bubbles.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **9 Genre Templates** | Horror, Superhero, Sci-Fi, Fantasy, Detective, Apocalypse, Comedy, Drama, Custom |
| **Character Builder** | Name, appearance, backstory, powers; up to 20 reference images with AI auto-captions and semantic embeddings |
| **World Builder** | Setting, era, atmosphere; up to 20 reference images with variation tags (aerial, interior, night, detail) |
| **Image Style Presets** | Reusable art-style prompt prefixes — Comic Book Ink, Photorealistic, Anime/Manga, Watercolor, 3D Render, and custom |
| **Prompt Presets** | Saved LLM configurations (system prompt + sampler settings); 3 built-in defaults (Balanced, Creative, Precise) |
| **Privacy-first Storage** | All data stored locally in IndexedDB; nothing leaves the browser except NanoGPT API calls |
| **Offline Access** | Workbox service worker caches the full app shell after the first load |
| **JSON Backup** | Export or import all data (characters, worlds, comics, pages, presets, imagePresets, settings) from the Settings page |

---

## How It Works

1. **Install** — open in a modern browser or install as a standalone PWA on desktop or mobile.
2. **Configure** — enter your NanoGPT API key in **Settings** and choose text/image models.
3. **Build characters** — use **Character Builder** to define characters and optionally upload reference images.
4. **Build a world** — use **World Builder** to describe the setting and optionally upload reference images.
5. **Start a comic** — on **Create Comic**, pick a genre, select characters and world, choose a prompt preset and image style, then click **Generate**.
6. **Read and branch** — each page streams in with narration, dialogue, panel artwork, and 2–3 branching choices; pick one to continue.
7. **Export** — find the finished comic in **My Comics** and export it as a PDF.

---

## Architecture

AI Comic Creator is a **frontend-only single-page application** — no backend, no server-side database. Everything runs in the browser.

- **Build & PWA** — Vite bundles TypeScript source; `vite-plugin-pwa` (Workbox) generates the service worker. Static assets are served cache-first; NanoGPT API calls are network-only.
- **SPA Router** — `App.navigate(page, param)` swaps the `#content` div's innerHTML. No external framework.
- **Storage (`db.ts`)** — A thin IndexedDB wrapper manages 7 object stores: characters, worlds, comics, pages, presets, imagePresets, and settings.
- **AI integration (`api.ts`)** — Streaming SSE chat completions, image generation, text embeddings, and vision captioning via the NanoGPT API.

For a detailed walkthrough of how reference images flow from upload to rendered panel, see [Image Generation Pipeline](./image-generation-pipeline.md).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Build tool | Vite |
| Language | TypeScript (ES modules) |
| PWA / Service Worker | vite-plugin-pwa (Workbox) |
| Storage | IndexedDB (browser-native) |
| AI API | NanoGPT (chat, image gen, embeddings) |
| Unit tests | Vitest + fake-indexeddb |
| E2E tests | Playwright |
| CSS | Vanilla CSS (dark theme, mobile-first) |

---

## See Also

- [Image Generation Pipeline](./image-generation-pipeline.md) — Deep dive: upload → auto-caption → embeddings → per-panel selection → prompt assembly → API call.
- [Test Coverage Analysis](../TEST_COVERAGE_ANALYSIS.md) — Current unit and E2E test coverage summary.
