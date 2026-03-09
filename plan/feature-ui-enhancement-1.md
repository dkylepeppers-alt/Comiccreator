---
goal: Comprehensive UI Appearance Enhancement for AI Comic Creator PWA
version: 1.0
date_created: 2026-03-09
last_updated: 2026-03-09
owner: dkylepeppers-alt
status: 'In progress'
tags: [feature, ui, design, css, enhancement]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

This plan outlines a comprehensive set of targeted visual improvements to the AI Comic Creator PWA. The app already uses a solid dark theme with CSS variables; the goal is to elevate it with glassmorphism effects, richer animations, improved typography hierarchy, component-level polish, and a more polished home-page hero — all without altering application logic or breaking existing tests.

## 1. Requirements & Constraints

- **REQ-001**: All changes must be backwards-compatible with the existing HTML structure and JS page modules.
- **REQ-002**: No new external dependencies may be introduced (images, fonts, or JS libraries).
- **REQ-003**: Existing CSS classes must be extended, not removed, to avoid breaking dynamic rendering in page JS files.
- **REQ-004**: The app must remain fully functional (no broken layouts, no missing content).
- **REQ-005**: Accessibility focus indicators must remain visible and meet contrast requirements.
- **CON-001**: Only `css/app.css` and `js/pages/home.js` are modified; all other page JS files remain unchanged.
- **CON-002**: The `index.html` file may receive minor additions (inline style tweaks) only — no structural changes.
- **GUD-001**: Follow mobile-first design already established in the codebase.
- **GUD-002**: All new animations must respect `prefers-reduced-motion` media query already present in the CSS.
- **PAT-001**: Use existing CSS custom properties (`--accent`, `--bg-card`, etc.) as the base for all new values.

## 2. Implementation Steps

### Implementation Phase 1 — Core Theme & Visual Foundation

- GOAL-001: Enhance the CSS variable palette and add foundational visual tokens (glassmorphism, richer shadows, gradient utilities) to `css/app.css`.

| Task     | Description                                                                                                                               | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Add new CSS variables: `--glass-bg`, `--glass-border`, `--accent-subtle`, `--card-glow`, `--shadow-lg`, `--shadow-colored`               | ✅        | 2026-03-09 |
| TASK-002 | Upgrade body background to animated subtle gradient using `@keyframes bgShift` animation at 30s loop                                     | ✅        | 2026-03-09 |
| TASK-003 | Add `--transition-fast: 0.15s ease` and `--transition-base: 0.25s ease` variables for consistent timing                                  | ✅        | 2026-03-09 |
| TASK-004 | Update `.card` to add `:hover` state with accent glow and `transform: translateY(-2px)` lift effect                                      | ✅        | 2026-03-09 |
| TASK-005 | Add `.card-glass` variant using `backdrop-filter: blur(16px)` and `--glass-bg` background for hero/featured cards                        | ✅        | 2026-03-09 |

### Implementation Phase 2 — Navigation & Shell Components

- GOAL-002: Improve the topbar, sidebar, and bottom-nav visual quality.

| Task     | Description                                                                                                                                | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-006 | Topbar: Strengthen glassmorphism and add a gradient bottom border                                                                          | ✅        | 2026-03-09 |
| TASK-007 | Sidebar: Improve `.nav-link` active state with background glow                                                                             | ✅        | 2026-03-09 |
| TASK-008 | Bottom nav: Add glassmorphism and improve `.create-btn` with pulsing glow animation                                                        | ✅        | 2026-03-09 |
| TASK-009 | Add `@keyframes pulse-glow` animation for the create button                                                                                | ✅        | 2026-03-09 |

### Implementation Phase 3 — Button & Form Polish

- GOAL-003: Improve buttons, form controls, and interactive element aesthetics.

| Task     | Description                                                                                                                                | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-010 | `.btn-primary`: Replace flat color with gradient, add colored shadow, improve hover lift                                                   | ✅        | 2026-03-09 |
| TASK-011 | `.btn-secondary`: Add subtle hover background tint and smooth border transition                                                             | ✅        | 2026-03-09 |
| TASK-012 | `.btn-danger`: Add gradient background with matching shadow                                                                                 | ✅        | 2026-03-09 |
| TASK-013 | Form inputs/textareas/selects: Add `box-shadow` glow on focus                                                                              | ✅        | 2026-03-09 |
| TASK-014 | `.chip`: Improve active state with gradient background                                                                                     | ✅        | 2026-03-09 |

### Implementation Phase 4 — Page Content Components

- GOAL-004: Polish cards, list items, empty states, section headers, and genre cards.

| Task     | Description                                                                                                                                | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-015 | `.list-item`: Add hover accent bar and background tint                                                                                     | ✅        | 2026-03-09 |
| TASK-016 | `.genre-card`: Add hover gradient background tint and emoji scale animation                                                                | ✅        | 2026-03-09 |
| TASK-017 | `.empty-state`: Add floating icon animation via `@keyframes float`                                                                        | ✅        | 2026-03-09 |
| TASK-018 | `.section-title`: Add gradient text effect matching the logo style                                                                        | ✅        | 2026-03-09 |
| TASK-019 | `.tab-btn.active`: Add subtle bottom-border glow                                                                                          | ✅        | 2026-03-09 |

### Implementation Phase 5 — Home Page Hero Enhancement

- GOAL-005: Upgrade the home page hero section and stats cards in `js/pages/home.js`.

| Task     | Description                                                                                                                                | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-020 | Add comic-book style decorative icon above the hero title                                                                                  | ✅        | 2026-03-09 |
| TASK-021 | Stats cards: Add emoji icons and improve layout with `card-glass` class                                                                    | ✅        | 2026-03-09 |
| TASK-022 | Quick Start card: Use `card-glass` class for hero-style visual distinction                                                                 | ✅        | 2026-03-09 |

### Implementation Phase 6 — Modal, Toast & Utility Improvements

- GOAL-006: Improve overlay components and animations.

| Task     | Description                                                                                                                                | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-023 | Modal: Add `@keyframes modalSlideIn` entrance animation, accent top border                                                                 | ✅        | 2026-03-09 |
| TASK-024 | Toast: Improve with left-color accent bar per type, improved `toastIn` animation                                                           | ✅        | 2026-03-09 |
| TASK-025 | Spinner: Add glow shadow effect                                                                                                            | ✅        | 2026-03-09 |

## 3. Alternatives

- **ALT-001**: Full redesign with a new CSS framework (Tailwind, Bootstrap) — rejected because the app is pure vanilla JS with no build step.
- **ALT-002**: Light/dark mode toggle — rejected because the dark theme is a core brand identity of the app.
- **ALT-003**: Replacing the Bangers font — rejected because Bangers is already imported and used consistently in comic panels.

## 4. Dependencies

- **DEP-001**: `css/app.css` — the only stylesheet; all changes are additive extensions.
- **DEP-002**: `js/pages/home.js` — minimal HTML string changes to the hero section.
- **DEP-003**: Google Fonts CDN (Bangers) — already present, no change needed.

## 5. Files

- **FILE-001**: `css/app.css` — primary file; all CSS enhancements added here.
- **FILE-002**: `js/pages/home.js` — minor hero section and stats card HTML string updates.

## 6. Testing

- **TEST-001**: Run `npm run lint` to verify no ESLint violations are introduced.
- **TEST-002**: Run `npm run check-syntax` to verify no JS syntax errors.
- **TEST-003**: Run `npm test` to verify all unit tests pass (no functional regressions).
- **TEST-004**: Visually inspect all pages in a browser to confirm layouts render correctly.
- **TEST-005**: Verify `prefers-reduced-motion` media query correctly disables all new animations.

## 7. Risks & Assumptions

- **RISK-001**: `backdrop-filter` may not be supported in all browsers; the app already uses it so this is acceptable progressive enhancement.
- **RISK-002**: Animated body background gradient may increase GPU usage on low-end devices; mitigated by 30s loop and `prefers-reduced-motion` override.
- **ASSUMPTION-001**: All page JS files render HTML into `#content` using string templates; CSS class changes are purely additive.
- **ASSUMPTION-002**: The app is used primarily on mobile; all enhancements target 375px width first.

## 8. Related Specifications / Further Reading

- [MDN — backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)
- [MDN — CSS Custom Properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [Web.dev — Reduced Motion](https://web.dev/prefers-reduced-motion/)
