---
goal: Improve reference image prompts, expand world image tags, and enhance character-world context
version: 1.0
date_created: 2026-03-09
last_updated: 2026-03-09
owner: Copilot
status: 'Completed'
tags: [feature, ux, image-generation, world-builder]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan improves the default image prompts used by the reference image generator, expands the world image tag vocabulary to include specific interior and exterior sub-tags, and strengthens the character-world visual relationship in the comic creation system prompt.

## 1. Requirements & Constraints

- **REQ-001**: `WORLD_REF_VARIATIONS` prompts in `js/api.js` must be more descriptive and generate more useful reference images for comic world-building.
- **REQ-002**: World image tags must include specific interior sub-tags (e.g., `interior-living-room`, `interior-kitchen`, `interior-bathroom`) and exterior sub-tags (e.g., `exterior-street`, `exterior-entrance`).
- **REQ-003**: The character-world link in the system prompt must explicitly instruct the LLM to name specific interior/exterior spaces and blend character presence with the world's visual identity.
- **REQ-004**: All tags used in `WORLD_REF_VARIATIONS` must also exist in the `IMAGE_TAGS` array in `js/pages/worlds.js` (enforced by repository convention).
- **CON-001**: No new npm dependencies may be added.
- **CON-002**: All 147 existing unit tests must continue to pass.
- **CON-003**: ESLint must report zero errors (existing warnings are acceptable).
- **PAT-001**: Follow the existing array-of-objects pattern for variation definitions (`tag`, `prompt`, `desc`, optional `key`).

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Expand `IMAGE_TAGS` in `js/pages/worlds.js` and update `WORLD_REF_VARIATIONS` in `js/api.js`.

| Task     | Description                                                                                                                                                          | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Add specific interior sub-tags to `IMAGE_TAGS` in `js/pages/worlds.js`                                                                                              | done      | 2026-03-09 |
| TASK-002 | Add specific exterior sub-tags to `IMAGE_TAGS` in `js/pages/worlds.js`                                                                                              | done      | 2026-03-09 |
| TASK-003 | Replace the 4-entry `WORLD_REF_VARIATIONS` in `js/api.js` with a 12-entry version with improved prompts                                                             | done      | 2026-03-09 |

### Implementation Phase 2

- GOAL-002: Expand `CHARACTER_WORLD_VARIATIONS` and improve `buildSystemPrompt` for stronger character-world context.

| Task     | Description                                                                                                                                                          | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-004 | Add two new entries to `CHARACTER_WORLD_VARIATIONS` in `js/api.js`: close-up portrait and interior scene                                                            | done      | 2026-03-09 |
| TASK-005 | Extend the `world` block in `buildSystemPrompt` with `WORLD VISUAL RULES` instructions                                                                              | done      | 2026-03-09 |

### Implementation Phase 3

- GOAL-003: Verify tag consistency and run tests.

| Task     | Description                                                                                          | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-006 | Verify all `WORLD_REF_VARIATIONS` tags exist in `IMAGE_TAGS`                                         | done      | 2026-03-09 |
| TASK-007 | Run `npm test` — all 147 tests pass                                                                  | done      | 2026-03-09 |
| TASK-008 | Run `npm run check-syntax` and `npm run lint` — zero errors                                          | done      | 2026-03-09 |

## 3. Alternatives

- **ALT-001**: Add a free-text "location type" field to the world editor instead of expanding the tag enum — rejected because it adds UI complexity and doesn't give the dropdown-based gallery filter the structured values it needs.
- **ALT-002**: Generate variation prompts dynamically on the fly using the AI — rejected because it introduces latency and the static definitions are easier to maintain.

## 4. Dependencies

- **DEP-001**: `js/api.js` — `WORLD_REF_VARIATIONS`, `CHARACTER_WORLD_VARIATIONS`, `buildSystemPrompt`
- **DEP-002**: `js/pages/worlds.js` — `IMAGE_TAGS`, `generateReferences()`, gallery filter dropdown

## 5. Files

- **FILE-001**: `js/api.js` — Updated `WORLD_REF_VARIATIONS` (4 to 12 entries), expanded `CHARACTER_WORLD_VARIATIONS` (2 to 4 entries), enriched `buildSystemPrompt` world block with `WORLD VISUAL RULES`.
- **FILE-002**: `js/pages/worlds.js` — Expanded `IMAGE_TAGS` (10 to 24 tags) with specific interior and exterior sub-tags.
- **FILE-003**: `plan/feature-reference-image-prompts-world-tags-1.md` — This implementation plan.

## 6. Testing

- **TEST-001**: All existing 147 unit tests pass without modification.
- **TEST-002**: Tag consistency verified programmatically: every tag in `WORLD_REF_VARIATIONS` exists in `IMAGE_TAGS`.

## 7. Risks & Assumptions

- **RISK-001**: The expanded `IMAGE_TAGS` list makes the tag dropdown longer — mitigated by keeping the list logically ordered (general to specific).
- **ASSUMPTION-001**: The LLM used for comic generation will follow the new `WORLD VISUAL RULES` instructions when a world is selected.
- **ASSUMPTION-002**: The image generation model will produce meaningfully different outputs for the new, more specific `WORLD_REF_VARIATIONS` prompts compared to the old generic ones.

## 8. Related Specifications / Further Reading

- Repository memory: "Tags used in WORLD_REF_VARIATIONS (api.js) must also appear in the IMAGE_TAGS array in worlds.js"
- Repository memory: "Reference image generation uses inline dropdown panels (.gen-ref-dropdown) injected after toolbar, not App.showModal()"
