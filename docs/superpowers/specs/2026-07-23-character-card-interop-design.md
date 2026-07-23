# Character Card Interoperability — Research Notes

## Status

**Research only. Not approved, not scheduled.** Written 2026-07-23 to answer whether AI Comic Creator should
adopt "a variation of the V3 character card" for character transfer. No implementation is planned from this
document; it exists so the decision can be made later with the tradeoffs already mapped.

## Why this came up

The app already has a native character transfer format in `src/js/character-transfer.ts`:

```ts
{ schemaVersion: 3, character: canonicalCharacter, references: canonicalReferences }
```

`buildCharacterExport()`, `planCharacterImport()`, and `commitCharacterImport()` handle export, dry-run preview,
and commit. It works, but it is private to this app: nothing else can read it, and users cannot bring characters
in from the wider ecosystem (SillyTavern, chub, MegaNova Character Studio). The question is whether the
character-card standard is a better shape for that boundary.

## What the formats actually are

**CCv2** (`chara_card_v2`) — the interchange baseline. Six core fields: `name`, `description`, `personality`,
`scenario`, `first_mes`, `mes_example`. Only `name` and `first_mes` are mandatory. Everything nests under `data`.

**CCv3** (`chara_card_v3`, `spec_version` `"3.0"`) — a superset of V2 in the same `{spec, spec_version, data}`
envelope. Adds `assets`, `nickname`, `creator_notes_multilingual`, `source`, `group_only_greetings`,
`creation_date`/`modification_date`, and `character_book`.

**CHARX** — the V3 zip container: `card.json` at the root, assets under `assets/{type}/images/` (also
`audio/`, `video/`, `l2d/`, `3d/`, `fonts/`, `code/`, `other/`). Referenced from `assets[].uri` via the
`embeded://` scheme — note the single 'm', which is in the spec and is a common source of silent breakage.

**CAK** (MegaNova Character Asset Kit) — *not a standard*. It is one tool's zip layout:
`character.json` + `avatar.png` + `images/` + `lorebooks/` + `manifest.json`, where `character.json` is CCv3.
It is a reshuffle of the same idea as CHARX with a bundle manifest bolted on.

**PNG embedding** — cards ship as PNGs with the JSON base64-encoded in a `chara` tEXt chunk; V3 additionally
writes a `ccv3` chunk. This is how most cards are actually distributed.

## The honest assessment

CCv3 is a **roleplay-chat** format. `personality`, `scenario`, `first_mes`, `mes_example`, `alternate_greetings`,
`group_only_greetings`, `post_history_instructions` are dialogue-engine fields with no meaning in a comic
generator. Adopting CCv3 wholesale means carrying dead weight and inviting users to fill in fields the app
ignores.

Three pieces, however, are a genuinely good fit:

### 1. `assets[]` — the actual prize

```json
{ "type": "icon", "uri": "embeded://assets/icon/images/mara-front.png", "name": "identity-front", "ext": "png" }
```

Required properties: `type`, `uri`, `name`, `ext`. URI schemes: `http(s)://`, `data:`, `embeded://`, and
`ccdefault:`. Custom types are permitted when prefixed `x_`.

This maps nearly 1:1 onto `ReferenceAsset` in `src/js/references/types.ts`. The `x_` prefix is the sanctioned
way to carry comic-specific subject types (`x_interaction`, `x_location`, `x_prop`, `x_style`) without
breaking spec compliance.

### 2. `data.extensions` — where the real data lives

The spec reserves `extensions` for application-specific data and requires implementations to preserve it on
round-trip. Everything this app cares about — `subjectType`, `use`, `facets`, `characterIds`, `confidence`,
`classificationState`, `provenance`, visual-continuity anchors — belongs under `data.extensions.comiccreator`.
That keeps a card readable by other tools while losing nothing here.

### 3. The `{spec, spec_version, data}` envelope

A versioned container matching the discipline the app already uses (`referenceSchemaVersion`, backup
`schemaVersion`, `character-transfer` `schemaVersion: 3`).

`character_book` is a weaker match. Lorebook entries are keyword-triggered text injections; the nearest
analogue here is `WorldLocation` with its `aliases` acting like lorebook `keys`. Usable, but it is a loose
mapping and not a reason to adopt the format on its own.

## Two structural mismatches that must be decided first

**1. A card holds one character; this app's parent is the World.**

Post-unification, the world owns locations, characters, and the reference library
(`docs/superpowers/specs/2026-07-22-unified-world-reference-system-design.md`). A single character card cannot
represent a world. Any real adoption therefore needs two levels:

- a `.charx` per character — the interop unit, readable by other tools
- a world bundle — N cards + locations + world-level references + a manifest, the actual backup/transfer unit

CAK's `manifest.json` idea earns its place at the world level, not the character level.

**2. Interaction references belong to several characters at once.**

A shared interaction asset links to every depicted character. Exporting one character cannot cleanly own it.
Options, none free:

- omit interaction assets from single-character exports (lossy, simplest, recommended)
- duplicate them into each card (bloats bundles, creates divergent copies on re-import)
- reference them by `https://` URI (requires hosting the app does not have — it is fully client-side)

## Practical cost

**No zip library is in the project today.** Two halves:

- *Writing* a zip is cheap: PNG/JPEG are already compressed, so a STORE-only (uncompressed) writer is roughly
  60 lines with zero new dependencies.
- *Reading* CHARX/CAK on import is the harder half and likely justifies `fflate` (~10 KB), the smallest
  credible option.

**PNG tEXt chunk embedding** is separable and optional — roughly 80 lines (CRC32 + chunk splice), no
dependency. It is how cards are actually shared in the wild, so it matters more for *import* than export.

**Keep this separate from the app backup.** `src/js/settings/backup-import.ts` answers "restore all my data".
Cards answer "share one character". Conflating them makes both worse — a backup must be lossless and total, a
card must be portable and partial.

## Recommendation if this is ever picked up

Adopt a **CCv3-compatible profile**, not CCv3 itself:

- Emit CHARX layout (not CAK), because CHARX is what other tools read.
- `card.json` is a valid `chara_card_v3`, with `name`/`description` filled best-effort from the character's
  name and appearance so the card opens meaningfully elsewhere, and chat-only fields left empty.
- Every reference image becomes an `assets[]` entry with `embeded://` URIs and `x_`-prefixed custom types.
- All comic-specific data under `data.extensions.comiccreator`.
- Import accepts CCv2 JSON, CCv3 JSON, CHARX, CAK, and PNG cards; the existing
  `planCharacterImport()` dry-run/preview flow in `src/js/character-transfer.ts` is the right seam to hang
  format detection on.

**Suggested phasing** — import first. It delivers value immediately (users can bring characters in), requires
no zip *writer*, and validates the whole mapping against real third-party cards before the app commits to
emitting the format. Export is the reversible half and can follow once the mapping is proven.

## Open questions

- Which of the three interaction-asset options above is acceptable, given that lossy is the simplest?
- Does the world bundle replace, or sit beside, the existing `schemaVersion: 3` character transfer format?
- Is `fflate` an acceptable first runtime dependency for a project that currently ships five?
