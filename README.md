# AI Comic Creator

## CI Status

[![Tests](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/tests.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/tests.yml)
[![Playwright E2E Tests](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/playwright.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/playwright.yml)
[![Deploy to GitHub Pages](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/deploy-pages.yml)
[![Security Audit](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/security.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/security.yml)
[![CodeQL Analysis](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/dkylepeppers-alt/Comiccreator/actions/workflows/codeql-analysis.yml)

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

<!-- AUTO-GENERATED-CONTENT:START (DIRECTORY_TREE) -->
```
Comiccreator/
.editorconfig
.github
    actions
        setup-node-env
            action.yml
        setup-playwright
            action.yml
    agents
        Anotherplanner.agent.md
        Bugfixer.agent.md
        Docs-agent.agent.md
        Readme.agent.md
        architect-innovator.md
        ci-optimizer.agent.md
        gem-browser-tester.agent.md
        gem-devops.agent.md
        gem-documentation-writer.agent.md
        gem-implementer.agent.md
        gem-orchestrator.agent.md
        gem-planner.agent.md
        gem-researcher.agent.md
        gem-reviewer.agent.md
        my-agent.agent.md
        upgrade-actions-implementer.agent.md
    copilot-instructions.md
    copilot-mcp.json
    dependabot.yml
    labeler.yml
    workflows
        auto-merge-dependabot.yml
        ci-metrics.yml
        codeql-analysis.yml
        deploy-pages.yml
        playwright.yml
        post-merge.yml
        pr-labeler.yml
        release.yml
        security-pr.yml
        security.yml
        stale.yml
        tests.yml
.gitignore
.prettierrc
README.md
TEST_COVERAGE_ANALYSIS.md
docs
    image-generation-pipeline.md
    plan
        feature-ui-enhancement-1
            plan.yaml
eslint.config.js
generate-icons.html
index.html
package-lock.json
package.json
plan
    feature-reference-image-prompts-world-tags-1.md
    upgrade-actions-automation-1.md
playwright.config.js
public
    .nojekyll
    icons
        icon-192.png
        icon-512.png
        icon.svg
    manifest.json
    version.json
scripts
    bump-version.sh
    check-actions.sh
    install-hooks.sh
    pre-commit-version-check.sh
    update-docs.sh
    validate-workflows.sh
src
    css
        app.css
    js
        api.ts
        app.ts
        db.ts
        global.d.ts
        pages
            characters.ts
            create.ts
            home.ts
            image-presets.ts
            library.ts
            presets.ts
            settings.ts
            worlds.ts
        utils.ts
test
    api-integration.test.js
    api-pure.test.js
    config-integrity.test.js
    db.test.js
    e2e
        smoke.spec.js
    pure-functions.test.js
    utils.test.js
tsconfig.json
vite.config.js
vitest.config.ts
```
<!-- AUTO-GENERATED-CONTENT:END (DIRECTORY_TREE) -->

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

### Auto-Updating Documentation

Sections of this README wrapped in `<!-- AUTO-GENERATED-CONTENT:START (NAME) -->` / `<!-- AUTO-GENERATED-CONTENT:END (NAME) -->` comments are regenerated automatically. On every push to `Main`, `.github/workflows/auto-update-docs.yml` runs `scripts/update-docs.sh` and commits any changes. The currently auto-generated sections are:

- **Architecture directory tree** — reflects the actual file structure of the repository
- **CI Workflows table** — lists all workflow files with their triggers and names
- **Agent roster** — lists all Copilot agent definitions with their names and descriptions

To regenerate locally:

```bash
bash scripts/update-docs.sh   # or: npm run update-docs
```

The script is idempotent — running it multiple times with no file changes produces the same output.

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

<!-- AUTO-GENERATED-CONTENT:START (WORKFLOWS_TABLE) -->
| Workflow | Trigger | Description |
|----------|---------|-------------|
| `auto-merge-dependabot.yml` | pull_request | Auto Merge Dependabot |
| `ci-metrics.yml` | schedule, workflow_dispatch | CI Metrics |
| `codeql-analysis.yml` | push, pull_request | CodeQL Analysis |
| `deploy-pages.yml` | push, workflow_dispatch | Deploy to GitHub Pages |
| `playwright.yml` | push, pull_request | Playwright E2E Tests |
| `post-merge.yml` | push | Post-Merge Pipeline |
| `pr-labeler.yml` | pull_request | PR Labeler |
| `release.yml` | workflow_dispatch | Release |
| `security-pr.yml` | pull_request | Security PR Check |
| `security.yml` | schedule, workflow_dispatch | Security Audit |
| `stale.yml` | schedule | Stale Issues and PRs |
| `tests.yml` | push, pull_request | Tests |
<!-- AUTO-GENERATED-CONTENT:END (WORKFLOWS_TABLE) -->

### Copilot Agents

<!-- AUTO-GENERATED-CONTENT:START (AGENT_ROSTER) -->
| Agent | Name | Description |
|-------|------|-------------|
| `Anotherplanner` | Implementation Plan Generation Mode | Generate an implementation plan for new features or refactoring existing code. |
| `Bugfixer` | bug-fix-teammate | Identifies critical bugs in your project and implements targeted fixes with working code |
| `Docs-agent` | repo-docs-specialist | Repository documentation specialist for writing and maintaining clear instructional, reference, and configuration documents that coding agents can follow reliably. |
| `Readme` | readme-specialist | Specialized agent for creating and improving README files and project documentation |
| `ci-optimizer` | ci-optimizer | CI/CD pipeline optimization specialist — analyzes run times, suggests caching, validates security |
| `gem-browser-tester` | gem-browser-tester | Automates E2E scenarios with Chrome DevTools MCP, Playwright, Agent Browser. UI/UX validation using browser automation tools and visual verification techniques |
| `gem-devops` | gem-devops | Manages containers, CI/CD pipelines, and infrastructure deployment |
| `gem-documentation-writer` | gem-documentation-writer | Generates technical docs, diagrams, maintains code-documentation parity |
| `gem-implementer` | gem-implementer | Executes TDD code changes, ensures verification, maintains quality |
| `gem-orchestrator` | gem-orchestrator | Team Lead - Coordinates multi-agent workflows with energetic announcements, delegates tasks, synthesizes results via runSubagent |
| `gem-planner` | gem-planner | Creates DAG-based plans with pre-mortem analysis and task decomposition from research findings |
| `gem-researcher` | gem-researcher | Research specialist: gathers codebase context, identifies relevant files/patterns, returns structured findings |
| `gem-reviewer` | gem-reviewer | Security gatekeeper for critical tasks—OWASP, secrets, compliance |
| `my-agent` | planning-specialist | Specialized planning agent focused on turning goals into clear, structured execution plans for coding agents. Produces implementation plans, task breakdowns, sequencing, dependency maps, milestone outlines, risk notes, and decision frameworks with an emphasis on clarity, feasibility, and repository-grounded actionability. |
| `upgrade-actions-implementer` | upgrade-actions-implementer | Expert implementer for plan/upgrade-actions-automation-1.md — verifies completed phases and executes remaining CI/CD, tooling, and frontend modernization upgrades |
<!-- AUTO-GENERATED-CONTENT:END (AGENT_ROSTER) -->

---

## License

MIT
