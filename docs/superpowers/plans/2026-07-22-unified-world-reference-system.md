# Unified World Reference System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate character/world galleries and legacy selection modes with one world-owned, locally classified, deterministic reference system used by every new panel-generation path.

**Architecture:** Add a strict `references/` core for canonical types, schema validation, migration, classification jobs, and deterministic resolution. IndexedDB stores locations, assets, and jobs separately; world and character pages become views over one repository. Both continuity and independent-panel generation consume the same `PanelReferenceRequest` and resolver.

**Tech Stack:** TypeScript ES modules, Vitest, IndexedDB, Vite, Capacitor 7, Android Java, ML Kit GenAI Prompt API `1.0.0-beta2`.

## Global Constraints

- The world is the parent; every editable character and reference belongs to exactly one world.
- All automatic image classification runs on-device. Do not add a remote, keyword, filename, legacy-tag, or embedding fallback.
- Hidden assets are excluded from automatic selection but remain manually selectable.
- Existing comics are read-only; new comics use reference schema version 2.
- Remove `tag`, `referenceKey`, `locationKey`, embeddings, and character/world-specific classification from canonical records and normal runtime paths.
- Do not add an old/new behavior switch or manually bump the application version.
- Use two-space indentation, single quotes, semicolons, trailing commas, and focused modules.
- Preserve the 60% line and 55% branch coverage floors.
- Execute in a worktree created with `superpowers:using-git-worktrees`; do not stage the existing `.impeccable/` directory from the source checkout.

---

## File Structure

**Create**

- `src/js/references/types.ts` — canonical domain and request/result types.
- `src/js/references/schema.ts` — controlled vocabularies, parser, validation, and display labels.
- `src/js/references/repository.ts` — the only normal persistence API for locations, assets, and jobs.
- `src/js/references/legacy-migration.ts` — one-way migration planning and execution.
- `src/js/references/comic-access.ts` — legacy-comic read-only guards.
- `src/js/references/local-classifier.ts` — TypeScript bridge, prompt construction, and response parsing.
- `src/js/references/classification-queue.ts` — durable, resumable job runner.
- `src/js/references/resolver.ts` — pure deterministic panel resolver.
- `src/js/reference-workspace.ts` — shared world/character reference UI.
- `android/app/src/main/java/com/dkylepeppers/comiccreator/LocalReferenceClassifierPlugin.java` — on-device multimodal Gemini Nano bridge.
- Unit tests mirroring each pure/service module.

**Modify**

- `src/js/db.ts`, `tsconfig.core.json` — stores, indexes, transactions, and strict-core coverage.
- `src/js/visual-continuity.ts`, `src/js/api-parsing.ts`, `src/js/prompt-building.ts` — stable IDs and reference requests.
- `src/js/generation/continuity/types.ts`, `src/js/generation/continuity/build-plan.ts` — shared resolver integration.
- `src/js/generation/image-engine.ts` — independent-panel integration and legacy selector removal.
- `src/js/pages/worlds.ts`, `src/js/pages/characters.ts`, `src/js/pages/create.ts`, `src/js/pages/library.ts`, `src/js/pages/settings.ts` — hierarchy, workspace, guards, and settings cleanup.
- `src/js/settings/backup-import.ts`, `src/js/entity-gallery.ts`, `src/js/api.ts`, `src/js/utils.ts`, `src/css/app.css` — versioned transfer and legacy removal.
- `android/app/build.gradle`, `android/app/src/main/java/com/dkylepeppers/comiccreator/MainActivity.java`, `package.json`, `package-lock.json` — native classifier wiring and obsolete plugin removal.

---

### Task 1: Canonical Reference Types and Schema

**Files:**

- Create: `src/js/references/types.ts`
- Create: `src/js/references/schema.ts`
- Create: `test/reference-schema.test.ts`
- Modify: `tsconfig.core.json`

**Interfaces:**

- Produces: `ReferenceAsset`, `WorldLocation`, `ClassificationJob`, `PanelReferenceRequest`, `ReferenceManifestItem`, `parseReferenceClassification()`, and `formatReferenceLabel()`.

- [ ] **Step 1: Write the failing schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { formatReferenceLabel, parseReferenceClassification } from '../src/js/references/schema.js';

describe('reference classification schema', () => {
  const roster = { worldId: 'w1', characterIds: new Set(['mara', 'theo']), locationIds: new Set(['yard']) };

  it('accepts a useful interaction classification', () => {
    const value = parseReferenceClassification(
      {
        subjectType: 'interaction',
        use: 'relationship',
        characterIds: ['mara', 'theo'],
        locationId: 'yard',
        facets: { framing: 'medium', interactionType: 'conversation', spatialArrangement: 'face-to-face' },
        description: 'Mara and Theo talk in the courtyard.',
      },
      roster,
    );
    expect(value?.characterIds).toEqual(['mara', 'theo']);
    expect(
      formatReferenceLabel(value!, {
        characterNames: { mara: 'Mara', theo: 'Theo' },
        locationNames: { yard: 'Castle courtyard' },
      }),
    ).toBe('Interaction / Mara + Theo / Relationship / Medium');
  });

  it('rejects unknown entity IDs and controlled values', () => {
    expect(
      parseReferenceClassification(
        { subjectType: 'character', use: 'identity', characterIds: ['ghost'], facets: {} },
        roster,
      ),
    ).toBeNull();
    expect(
      parseReferenceClassification(
        { subjectType: 'location', use: 'establishing', characterIds: [], facets: { framing: 'random' } },
        roster,
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npx vitest run test/reference-schema.test.ts`

Expected: FAIL because `src/js/references/schema.ts` does not exist.

- [ ] **Step 3: Implement the canonical types and strict parser**

```ts
export type ReferenceSubjectType = 'character' | 'location' | 'interaction' | 'prop' | 'style';
export type ReferenceUse =
  | 'identity'
  | 'appearance'
  | 'expression'
  | 'pose'
  | 'action'
  | 'establishing'
  | 'spatial'
  | 'landmark'
  | 'detail'
  | 'relationship'
  | 'design'
  | 'state'
  | 'rendering';
export type ClassificationState = 'pending' | 'ready' | 'needs-review';
export type ClassificationJobStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface ReferenceFacets {
  framing?:
    | 'extreme-close-up'
    | 'close-up'
    | 'medium-close-up'
    | 'medium'
    | 'three-quarter'
    | 'full-body'
    | 'wide'
    | 'establishing'
    | 'detail';
  cameraElevation?: 'eye-level' | 'high' | 'low' | 'overhead' | 'aerial' | 'ground-level';
  viewDirection?: 'front' | 'three-quarter-front' | 'left-profile' | 'right-profile' | 'three-quarter-rear' | 'rear';
  identityCoverage?: 'face' | 'upper-body' | 'full-body';
  spaceType?: 'interior' | 'exterior' | 'threshold';
  timeOfDay?: 'dawn' | 'morning' | 'midday' | 'afternoon' | 'dusk' | 'night';
  interactionType?: string;
  spatialArrangement?: string;
  lighting?: string;
  visibility?: string;
  appearanceState?: string;
  expression?: string;
  pose?: string;
  activity?: string;
  weather?: string;
  season?: string;
  physicalContact?: string;
  screenPositions?: Record<string, string>;
  heldProps?: string[];
}

export interface ReferenceAsset {
  id: string;
  worldId: string;
  dataUrl: string;
  thumbnailDataUrl?: string;
  subjectType: ReferenceSubjectType | null;
  use: ReferenceUse | null;
  characterIds: string[];
  locationId?: string | null;
  facets: ReferenceFacets;
  description: string;
  confidence: Partial<Record<'subject' | 'links' | 'use' | 'facets', number>>;
  provenance: { source: 'uploaded' | 'generated' | 'migrated'; metadata: 'local' | 'manual' | 'accepted' };
  classificationState: ClassificationState;
  acceptedAsIs: boolean;
  autoUse: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ReferenceClassification {
  subjectType: ReferenceSubjectType;
  use: ReferenceUse;
  characterIds: string[];
  locationId: string | null;
  facets: ReferenceFacets;
  description: string;
  confidence: ReferenceAsset['confidence'];
}

export interface WorldLocation {
  id: string;
  worldId: string;
  name: string;
  description?: string;
  aliases: string[];
  preferredReferenceId?: string | null;
}

export interface ClassificationJob {
  id: string;
  assetId: string;
  worldId: string;
  status: ClassificationJobStatus;
  attemptCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PanelReferenceRequest {
  worldId: string;
  characterIds: string[];
  locationId: string | null;
  characterStates: Record<string, string>;
  interaction: { participantIds: string[]; type: string } | null;
  facets: ReferenceFacets;
  propNames: string[];
}

export interface ReferenceManifestItem {
  index: number;
  role: 'identity' | 'appearance' | 'location' | 'interaction' | 'prop' | 'style' | 'previous-frame';
  label: string;
  imageId?: string;
  characterIds?: string[];
  worldId?: string;
  locationId?: string;
  sourcePageId?: string;
  sourcePanelIndex?: number;
}
```

Implement exact subject/use compatibility, controlled facet sets, duplicate-ID removal, roster validation, confidence range validation, and `formatReferenceLabel(classification, labels)` in `schema.ts`. Define the test-local roster and label fixtures shown above. Add `src/js/references/**/*.ts` to `tsconfig.core.json`.

- [ ] **Step 4: Run schema tests and strict typecheck**

Run: `npx vitest run test/reference-schema.test.ts && npm run typecheck:core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/js/references/types.ts src/js/references/schema.ts test/reference-schema.test.ts tsconfig.core.json
git commit -m "feat: define canonical reference schema"
```

---

### Task 2: IndexedDB Stores and Reference Repository

**Files:**

- Create: `src/js/references/repository.ts`
- Create: `test/reference-repository.test.ts`
- Modify: `src/js/db.ts`
- Modify: `test/db.test.js`

**Interfaces:**

- Consumes: `ReferenceAsset`, `WorldLocation`, `ClassificationJob` from Task 1.
- Produces: `ReferenceRepository` with `listByWorld`, `listByCharacter`, `putAsset`, `setAutoUse`, `unlinkCharacter`, `deleteAsset`, and job/location methods.

```ts
export interface ReferenceRepository {
  getAsset(id: string): Promise<ReferenceAsset | undefined>;
  listByWorld(worldId: string): Promise<ReferenceAsset[]>;
  listByCharacter(worldId: string, characterId: string): Promise<ReferenceAsset[]>;
  putAsset(asset: ReferenceAsset): Promise<void>;
  setAutoUse(id: string, autoUse: boolean): Promise<void>;
  unlinkCharacter(id: string, characterId: string): Promise<void>;
  deleteAsset(id: string): Promise<void>;
  getJobByAsset(assetId: string): Promise<ClassificationJob | undefined>;
  listJobs(): Promise<ClassificationJob[]>;
  putJob(job: ClassificationJob): Promise<void>;
  putAssetAndJob(asset: ReferenceAsset, job: ClassificationJob): Promise<void>;
  listLocations(worldId: string): Promise<WorldLocation[]>;
  putLocation(location: WorldLocation): Promise<void>;
}
```

- [ ] **Step 1: Write failing repository and database-upgrade tests**

```ts
it('lists a shared interaction from either child without duplicating it', async () => {
  await repo.putAsset(asset({ id: 'r1', worldId: 'w1', characterIds: ['mara', 'theo'] }));
  expect((await repo.listByCharacter('w1', 'mara')).map((item) => item.id)).toEqual(['r1']);
  expect((await repo.listByCharacter('w1', 'theo')).map((item) => item.id)).toEqual(['r1']);
});

it('hides without deleting and clears dangling preferred IDs on delete', async () => {
  await repo.setAutoUse('r1', false);
  expect((await repo.getAsset('r1'))?.autoUse).toBe(false);
  await repo.deleteAsset('r1');
  expect(await repo.getAsset('r1')).toBeUndefined();
  expect((await deps.getCharacter('mara'))?.preferredIdentityReferenceId).toBeNull();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/reference-repository.test.ts test/db.test.js`

Expected: FAIL because the new stores and repository do not exist.

- [ ] **Step 3: Add DB version 5 and implement the repository**

```ts
const DB_VERSION = 5;
const STORES = {
  characters: 'characters',
  worlds: 'worlds',
  locations: 'locations',
  referenceAssets: 'referenceAssets',
  classificationJobs: 'classificationJobs',
  comics: 'comics',
  pages: 'pages',
  presets: 'presets',
  imagePresets: 'imagePresets',
  settings: 'settings',
} as const;
```

Create `locations.worldId`, `referenceAssets.worldId`, `referenceAssets.characterIds` (`multiEntry: true`), `referenceAssets.locationId`, `referenceAssets.classificationState`, `classificationJobs.status`, and unique `classificationJobs.assetId` indexes. Implement asset deletion and unlinking as multi-store transactions that also clear preferred IDs and mark ambiguous shared assets `needs-review`. Keep all normal reference access behind `createReferenceRepository(dependencies)` so tests can use in-memory dependencies.

- [ ] **Step 4: Run repository, DB, and strict-core tests**

Run: `npx vitest run test/reference-repository.test.ts test/db.test.js && npm run typecheck:core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/js/db.ts src/js/references/repository.ts test/reference-repository.test.ts test/db.test.js
git commit -m "feat: add world reference persistence"
```

---

### Task 3: One-Way Legacy Migration and Read-Only Comics

**Files:**

- Create: `src/js/references/legacy-migration.ts`
- Create: `src/js/references/comic-access.ts`
- Create: `test/reference-migration.test.ts`
- Create: `test/comic-access.test.ts`
- Modify: `src/js/db.ts`

**Interfaces:**

- Produces: `planLegacyMigration(input): LegacyMigrationPlan`, `runLegacyMigration(plan, assignments, dependencies)`, `isComicReadOnly(comic)`, and `assertComicWritable(comic)`.

```ts
export interface LegacyMigrationPlan {
  assignments: Record<string, string>;
  unresolved: Array<{ characterId: string; candidateWorldIds: string[] }>;
  worldImageCount: number;
  characterImageCount: number;
}
```

- [ ] **Step 1: Write failing ownership and comic-guard tests**

```ts
it('auto-assigns one-world characters and requests ambiguous assignments', () => {
  const plan = planLegacyMigration({
    worlds: [{ id: 'w1' }, { id: 'w2' }],
    characters: [
      { id: 'solo', images: [] },
      { id: 'shared', images: [] },
    ],
    comics: [
      { id: 'c1', worldId: 'w1', characterIds: ['solo', 'shared'] },
      { id: 'c2', worldId: 'w2', characterIds: ['shared'] },
    ],
  });
  expect(plan.assignments.solo).toBe('w1');
  expect(plan.unresolved).toEqual([{ characterId: 'shared', candidateWorldIds: ['w1', 'w2'] }]);
});

it('rejects mutation for legacy comics', () => {
  expect(() => assertComicWritable({ id: 'old' })).toThrow('This comic is read-only');
  expect(() => assertComicWritable({ id: 'new', referenceSchemaVersion: 2 })).not.toThrow();
});
```

- [ ] **Step 2: Run tests and verify missing exports**

Run: `npx vitest run test/reference-migration.test.ts test/comic-access.test.ts`

Expected: FAIL because migration and access modules do not exist.

- [ ] **Step 3: Implement resumable conversion**

```ts
export function isComicReadOnly(comic: { referenceSchemaVersion?: number } | null | undefined): boolean {
  return Boolean(comic) && comic!.referenceSchemaVersion !== 2;
}

export function assertComicWritable(comic: { referenceSchemaVersion?: number } | null | undefined): void {
  if (isComicReadOnly(comic)) throw new Error('This comic is read-only');
}
```

`runLegacyMigration` must create the new asset and pending job before removing each embedded source image, strip legacy fields instead of copying them, discard embeddings, preserve the original image bytes, and persist progress after every item. Missing/multiple parent worlds remain unresolved until the user supplies one selection. Existing comics receive `referenceSchemaVersion: 1`; only newly created comics receive version 2.

- [ ] **Step 4: Run migration, normalization, and DB tests**

Run: `npx vitest run test/reference-migration.test.ts test/comic-access.test.ts test/db-normalization.test.js test/db.test.js`

Expected: PASS, including interruption/resume and byte-preservation cases.

- [ ] **Step 5: Commit**

```bash
git add src/js/db.ts src/js/references/legacy-migration.ts src/js/references/comic-access.ts test/reference-migration.test.ts test/comic-access.test.ts
git commit -m "feat: migrate references into world ownership"
```

---

### Task 4: Native Multimodal Local Classifier Bridge

**Files:**

- Create: `android/app/src/main/java/com/dkylepeppers/comiccreator/LocalReferenceClassifierPlugin.java`
- Create: `src/js/references/local-classifier.ts`
- Create: `test/local-reference-classifier.test.ts`
- Modify: `android/app/build.gradle`
- Modify: `android/app/src/main/java/com/dkylepeppers/comiccreator/MainActivity.java`
- Modify: `package.json`, `package-lock.json`
- Delete: `src/js/local-llm-classifier.ts`
- Delete: `test/local-llm-classifier.test.ts`

**Interfaces:**

- Produces: `LocalReferenceClassifier.getAvailability()`, `download()`, and `classify({ asset, world, characters, locations })`.

```ts
export interface ClassificationInput {
  asset: ReferenceAsset;
  world: { id: string; name: string; description?: string };
  characters: Array<{ id: string; name: string; appearance?: string }>;
  locations: WorldLocation[];
}
```

- [ ] **Step 1: Write failing bridge/parser tests**

```ts
it('sends image bytes and the stable-ID roster to the native model', async () => {
  const plugin = {
    classify: vi.fn().mockResolvedValue({ text: validJson }),
    getAvailability: vi.fn().mockResolvedValue({ status: 'available' }),
    download: vi.fn(),
  };
  const classifier = createLocalReferenceClassifier(plugin);
  const result = await classifier.classify({ asset, world, characters: [mara], locations: [yard] });
  expect(plugin.classify).toHaveBeenCalledWith(
    expect.objectContaining({ dataUrl: asset.dataUrl, prompt: expect.stringContaining('"id":"mara"') }),
  );
  expect(result?.characterIds).toEqual(['mara']);
});

it('returns null for unsupported devices or invalid JSON', async () => {
  const classifier = createLocalReferenceClassifier(unavailablePlugin);
  expect(await classifier.classify({ asset, world, characters: [], locations: [] })).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run test/local-reference-classifier.test.ts`

Expected: FAIL because the bridge module does not exist.

- [ ] **Step 3: Implement the Android plugin and TypeScript adapter**

Add `implementation("com.google.mlkit:genai-prompt:1.0.0-beta2")` using the official [ML Kit multimodal Prompt API](https://developers.google.com/ml-kit/genai/prompt/android/get-started). Register `LocalReferenceClassifierPlugin` from `MainActivity`. The plugin must decode the data URL into a `Bitmap`, call Gemini Nano with one `ImagePart` and one `TextPart`, and return the raw response text. It exposes availability/download states and never performs network inference.

```ts
interface NativeClassifierPlugin {
  getAvailability(): Promise<{ status: 'unavailable' | 'downloadable' | 'downloading' | 'available' }>;
  download(): Promise<void>;
  classify(options: { dataUrl: string; prompt: string }): Promise<{ text: string }>;
}

export function createLocalReferenceClassifier(plugin: NativeClassifierPlugin) {
  return {
    getAvailability: () => plugin.getAvailability(),
    download: () => plugin.download(),
    classify: async (input: ClassificationInput) => {
      if ((await plugin.getAvailability()).status !== 'available') return null;
      const response = await plugin.classify({
        dataUrl: input.asset.dataUrl,
        prompt: buildClassificationPrompt(input),
      });
      return parseReferenceClassification(JSON.parse(response.text), rosterFrom(input));
    },
  };
}
```

Remove `@capacitor/local-llm`; it is text-only in the installed version and no longer has consumers.

- [ ] **Step 4: Run classifier tests and Android compilation**

Run: `npx vitest run test/local-reference-classifier.test.ts && npm run build && npx cap sync android && (cd android && ./gradlew compileDebugJavaWithJavac)`

Expected: PASS. On hosts without Android SDK, record the exact Gradle environment failure and require CI/device validation before completion.

- [ ] **Step 5: Commit**

```bash
git add android/app/build.gradle android/app/src/main/java/com/dkylepeppers/comiccreator/LocalReferenceClassifierPlugin.java android/app/src/main/java/com/dkylepeppers/comiccreator/MainActivity.java src/js/references/local-classifier.ts test/local-reference-classifier.test.ts package.json package-lock.json
git rm src/js/local-llm-classifier.ts test/local-llm-classifier.test.ts
git commit -m "feat: classify reference images on device"
```

---

### Task 5: Durable Classification Queue

**Files:**

- Create: `src/js/references/classification-queue.ts`
- Create: `test/reference-classification-queue.test.ts`
- Modify: `src/js/references/repository.ts`
- Delete: `src/js/reference-classification-service.ts`

**Interfaces:**

- Consumes: repository and local classifier.
- Produces: `createClassificationQueue({ repository, classifier, now })` with `enqueue`, `run`, `pause`, `retry`, `acceptAsIs`, `reclassify`, and `getProgress`.

```ts
export interface ClassificationQueue {
  enqueue(assetId: string): Promise<void>;
  run(): Promise<void>;
  pause(): void;
  retry(assetId: string): Promise<void>;
  acceptAsIs(assetId: string): Promise<void>;
  reclassify(assetId: string): Promise<void>;
  getProgress(): Promise<ClassificationProgress>;
}
```

- [ ] **Step 1: Write failing queue-state tests**

```ts
it('resumes pending jobs and commits validated metadata atomically', async () => {
  await queue.enqueue('r1');
  await queue.run();
  expect((await repo.getAsset('r1'))?.classificationState).toBe('ready');
  expect((await repo.getJobByAsset('r1'))?.status).toBe('complete');
});

it('keeps failures reviewable and supports accept as-is', async () => {
  classifier.classify.mockResolvedValueOnce(null);
  await queue.enqueue('r1');
  await queue.run();
  expect((await repo.getAsset('r1'))?.classificationState).toBe('needs-review');
  await queue.acceptAsIs('r1');
  expect(await repo.getAsset('r1')).toMatchObject({ acceptedAsIs: true, autoUse: true });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/reference-classification-queue.test.ts`

Expected: FAIL because the queue does not exist.

- [ ] **Step 3: Implement the single-worker durable state machine**

```ts
export interface ClassificationProgress {
  total: number;
  pending: number;
  running: number;
  complete: number;
  failed: number;
  paused: boolean;
}

export function isAutomaticallyEligible(asset: ReferenceAsset): boolean {
  return asset.autoUse && (asset.classificationState === 'ready' || asset.acceptedAsIs);
}
```

Persist every transition (`pending -> running -> complete|failed`), reset interrupted `running` jobs to `pending` on startup, process one job at a time, and update asset metadata plus job state in one transaction. Manual edits set provenance to `manual`; reclassification may not overwrite manual fields unless explicitly confirmed.

- [ ] **Step 4: Run queue and repository tests**

Run: `npx vitest run test/reference-classification-queue.test.ts test/reference-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/js/references/classification-queue.ts src/js/references/repository.ts test/reference-classification-queue.test.ts
git rm src/js/reference-classification-service.ts
git commit -m "feat: add resumable reference classification"
```

---

### Task 6: Deterministic Panel Reference Resolver

**Files:**

- Create: `src/js/references/resolver.ts`
- Create: `test/reference-resolver.test.ts`

**Interfaces:**

- Consumes: `PanelReferenceRequest`, `ReferenceAsset`, preferred IDs, previous-frame reference, and budget.
- Produces: `resolvePanelReferences(input): ReferenceResolution`.

```ts
export interface ResolvePanelReferencesInput {
  request: PanelReferenceRequest;
  assets: ReferenceAsset[];
  budget: number;
  preferredReferenceIds?: Record<string, string>;
  pinnedReferenceIds?: Record<string, string>;
  manualReferenceIds?: string[];
  previousFrame?: { dataUrl: string; sourcePageId?: string; sourcePanelIndex?: number } | null;
}

export interface ReferenceResolution {
  manifest: ReferenceManifestItem[];
  dataUrls: string[];
  missing: Array<{ role: ReferenceManifestItem['role']; id: string }>;
  warnings: string[];
  error?: { type: 'capacity'; required: number; budget: number; detail: string };
}
```

- [ ] **Step 1: Write the resolver decision matrix**

```ts
it('selects identity, exact state, location, and shared interaction in role order', () => {
  const result = resolvePanelReferences(
    fixture({
      request: {
        worldId: 'w1',
        characterIds: ['mara', 'theo'],
        locationId: 'yard',
        interaction: { participantIds: ['mara', 'theo'], type: 'conversation' },
        facets: { framing: 'medium', timeOfDay: 'night' },
        characterStates: { mara: 'red-coat' },
      },
    }),
  );
  expect(result.manifest.map((item) => item.role)).toEqual([
    'identity',
    'identity',
    'appearance',
    'location',
    'interaction',
  ]);
});

it('excludes hidden and unaccepted review assets but permits explicit manual IDs', () => {
  expect(resolvePanelReferences(fixture({ hidden: true })).manifest).toEqual([]);
  expect(resolvePanelReferences(fixture({ hidden: true, manualReferenceIds: ['r1'] })).manifest[0].imageId).toBe('r1');
});

it('never crosses worlds or silently substitutes a missing location', () => {
  const result = resolvePanelReferences(fixture({ requestWorldId: 'w1', assetWorldId: 'w2', locationId: 'missing' }));
  expect(result.manifest).toEqual([]);
  expect(result.missing).toContainEqual({ role: 'location', id: 'missing' });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/reference-resolver.test.ts`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement filtering, tuple scoring, budgets, and manifest roles**

```ts
type ManifestRole = 'identity' | 'appearance' | 'location' | 'interaction' | 'prop' | 'style' | 'previous-frame';
type CandidateScore = readonly [
  entity: number,
  use: number,
  matching: number,
  negativeConflicts: number,
  preferred: number,
  id: string,
];

export function compareCandidateScores(a: CandidateScore, b: CandidateScore): number {
  for (let index = 0; index < 5; index++) if (a[index] !== b[index]) return Number(b[index]) - Number(a[index]);
  return String(a[5]).localeCompare(String(b[5]));
}
```

Exact world/entity links are mandatory. Score exact use, matching facets, negative conflicts, preferred/pinned IDs, then stable ID. Return explicit `missing` and capacity errors; never fall back to an unrelated asset.

- [ ] **Step 4: Run resolver tests repeatedly for determinism**

Run: `npx vitest run test/reference-resolver.test.ts`

Expected: PASS with identical ordering in every run.

- [ ] **Step 5: Commit**

```bash
git add src/js/references/resolver.ts test/reference-resolver.test.ts
git commit -m "feat: resolve panel references deterministically"
```

---

### Task 7: Structured Planner and Continuity Integration

**Files:**

- Modify: `src/js/visual-continuity.ts`
- Modify: `src/js/api-parsing.ts`
- Modify: `src/js/prompt-building.ts`
- Modify: `src/js/generation/continuity/types.ts`
- Modify: `src/js/generation/continuity/build-plan.ts`
- Modify: `test/visual-continuity.test.js`
- Modify: `test/continuity-pipeline.test.ts`
- Modify: `test/api-pure.test.js`

**Interfaces:**

- Consumes: Task 6 `resolvePanelReferences`.
- Produces: planned panels with `locationId`, structured character requirements, and reference manifests including `appearance` and `interaction`.

- [ ] **Step 1: Replace key-based planner tests with stable-ID requests**

```ts
expect(parsed.panels[0].visual).toMatchObject({
  locationId: 'yard',
  characters: [{ characterId: 'mara', appearanceState: 'red-coat', action: 'talking' }],
  interaction: { participantIds: ['mara', 'theo'], type: 'conversation' },
});
expect(plan.referenceManifest.map((item) => item.role)).toContain('interaction');
expect(plan.referenceManifest.some((item) => 'referenceKey' in item)).toBe(false);
```

- [ ] **Step 2: Run focused planner tests and verify failures**

Run: `npx vitest run test/api-pure.test.js test/visual-continuity.test.js test/continuity-pipeline.test.ts`

Expected: FAIL on the old `locationKey`, `referenceKey`, and `variant` contracts.

- [ ] **Step 3: Replace allocator inputs with `PanelReferenceRequest`**

```ts
export interface PlannedPanelCharacter {
  characterId: string;
  appearanceState?: string | null;
  action: string;
  pose: string;
  expression: string;
}

export interface PlannedPanelVisual {
  locationId: string | null;
  environment: string;
  framing?: string;
  cameraElevation?: string;
  lighting: string;
  characters: PlannedPanelCharacter[];
  interaction?: { participantIds: string[]; type: string } | null;
  keyProps: string[];
}
```

Update parsing/validation prompts to emit stable IDs and allowed facet values. Replace `allocateReferences`, `orderedCharacterReferences`, and location-key fallback logic with the shared resolver. Extend `buildReferenceMap` and compiled panel descriptions for `appearance` and `interaction`. Retain capacity errors, request ordering, cancellation, and previous-frame behavior.

- [ ] **Step 4: Run continuity tests and strict core**

Run: `npx vitest run test/api-pure.test.js test/visual-continuity.test.js test/continuity-pipeline.test.ts && npm run typecheck:core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/js/visual-continuity.ts src/js/api-parsing.ts src/js/prompt-building.ts src/js/generation/continuity/types.ts src/js/generation/continuity/build-plan.ts test/api-pure.test.js test/visual-continuity.test.js test/continuity-pipeline.test.ts
git commit -m "feat: wire structured references into continuity"
```

---

### Task 8: Independent Generation Integration and Embedding Removal

**Files:**

- Modify: `src/js/generation/image-engine.ts`
- Modify: `src/js/pages/create.ts`
- Modify: `src/js/api.ts`
- Modify: `src/js/utils.ts`
- Modify: `src/js/entity-gallery.ts`
- Modify: `test/api-images.test.js`
- Modify: `test/pure-functions.test.js`
- Modify: `test/utils.test.js`

**Interfaces:**

- Consumes: repository and resolver from Tasks 2 and 6.
- Produces: one selection path for independent panels; no embedding API or legacy modes.

- [ ] **Step 1: Add failing parity and removal tests**

```ts
it('uses the shared resolver for independent panel generation', async () => {
  await generatePanelImages(contextWithResolver(resolvePanelReferences));
  expect(resolvePanelReferences).toHaveBeenCalledWith(
    expect.objectContaining({ request: expect.objectContaining({ worldId: 'w1' }) }),
  );
});

it('exports no embedding helper or legacy selector', async () => {
  expect(API.generateEmbedding).toBeUndefined();
  expect(Utils.buildImageEmbeddingText).toBeUndefined();
});
```

- [ ] **Step 2: Run focused tests and verify old behavior fails them**

Run: `npx vitest run test/api-images.test.js test/pure-functions.test.js test/utils.test.js`

Expected: FAIL while `selectBestImage`, `charRefMode`, and embedding exports remain.

- [ ] **Step 3: Route independent panels through the shared resolver**

```ts
const resolution = resolvePanelReferences({
  request: panel.referenceRequest,
  assets: await referenceRepository.listByWorld(panel.referenceRequest.worldId),
  budget: maxRefImages,
  pinnedReferenceIds: comic.visualContinuity?.pinnedReferenceIds || {},
  manualReferenceIds: panel.manualReferenceIds || [],
  previousFrame,
});
```

Use `resolution.dataUrls` and its manifest in `buildPanelImageOpts`. Delete `selectBestImage`, prompt-embedding cache, tag keywords, `charRefMode`, `generateEmbedding`, `EmbeddingOptions`, `buildImageEmbeddingText`, gallery embedding-on-save, stale badges, and all embedding fields from `ImageRef`. Preserve image request and progress behavior.

- [ ] **Step 4: Run generation tests, typechecks, and build**

Run: `npx vitest run test/api-images.test.js test/pure-functions.test.js test/utils.test.js test/continuity-pipeline.test.ts && npm run typecheck && npm run typecheck:core && npm run build`

Expected: PASS with no embedding API call in test spies.

- [ ] **Step 5: Commit**

```bash
git add src/js/generation/image-engine.ts src/js/pages/create.ts src/js/api.ts src/js/utils.ts src/js/entity-gallery.ts test/api-images.test.js test/pure-functions.test.js test/utils.test.js
git commit -m "feat: unify panel reference selection"
```

---

### Task 9: World-Owned Reference Workspace and Hierarchy UI

**Files:**

- Create: `src/js/reference-workspace.ts`
- Create: `test/reference-workspace.test.ts`
- Modify: `src/js/pages/worlds.ts`
- Modify: `src/js/pages/characters.ts`
- Modify: `src/js/pages/create.ts`
- Modify: `src/css/app.css`
- Modify: `test/e2e/smoke.spec.js`

**Interfaces:**

- Consumes: repository and classification queue.
- Produces: `createReferenceWorkspace({ worldId, characterId? })` and world-filtered character creation/selection.

- [ ] **Step 1: Write failing renderer/action tests**

```ts
it('renders a simple card and filters child views from the same records', async () => {
  const workspace = createReferenceWorkspace(deps);
  const html = await workspace.render({ worldId: 'w1', characterId: 'mara', filter: 'all' });
  expect(html).toContain('Character / Mara / Identity / Front');
  expect(html).toContain('data-action="review-reference"');
  expect(html).toContain('data-action="hide-reference"');
  expect(html).not.toContain('<select');
});

it('hides, accepts, and manually selects through repository commands', async () => {
  await workspace.handleAction({ action: 'hide-reference', referenceId: 'r1' });
  expect(repo.setAutoUse).toHaveBeenCalledWith('r1', false);
});
```

- [ ] **Step 2: Run UI unit tests and verify failure**

Run: `npx vitest run test/reference-workspace.test.ts`

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Implement the shared workspace and parent-first navigation**

```ts
export type ReferenceFilter = 'all' | 'world' | 'characters' | 'interactions' | 'needs-review' | 'hidden';

function referenceCard(asset: ReferenceAsset, label: string): string {
  return `<article class="reference-card" data-reference-id="${escHtml(asset.id)}">
    <button class="reference-preview" data-action="preview-reference" aria-label="Preview ${escHtml(label)}"><img src="${escHtml(asset.thumbnailDataUrl || asset.dataUrl)}" alt="${escHtml(label)}"></button>
    <p class="reference-label">${escHtml(label)}</p>
    <span class="reference-status">${escHtml(asset.classificationState)}</span>
    <button data-action="review-reference">Review</button>
    <button data-action="${asset.autoUse ? 'hide' : 'unhide'}-reference">${asset.autoUse ? 'Hide' : 'Unhide'}</button>
  </article>`;
}
```

Worlds render Locations, Characters, and References. Character creation requires `worldId`; character pages query by `(worldId, characterId)`. Replace both legacy gallery editors with the workspace filters, Review Metadata drawer, Upload/Generate actions, progress panel, Show hidden, Accept as-is, Retry, Pause, and manual panel picker. Create-page character choices are limited to the selected world.

- [ ] **Step 4: Run UI tests and browser smoke workflow**

Run: `npx vitest run test/reference-workspace.test.ts test/page-actions.test.ts && npm run build && npm run test:e2e -- --grep "world references|read-only comic"`

Expected: PASS. If local browser libraries are unavailable, retain unit/build evidence and require the CI E2E result.

- [ ] **Step 5: Commit**

```bash
git add src/js/reference-workspace.ts src/js/pages/worlds.ts src/js/pages/characters.ts src/js/pages/create.ts src/css/app.css test/reference-workspace.test.ts test/e2e/smoke.spec.js
git commit -m "feat: add world reference workspace"
```

---

### Task 10: Migration UI, Read-Only Guards, Backups, and Settings Cleanup

**Files:**

- Modify: `src/js/pages/library.ts`
- Modify: `src/js/pages/create.ts`
- Modify: `src/js/pages/settings.ts`
- Modify: `src/js/settings/backup-import.ts`
- Modify: `src/js/export-actions.ts`
- Modify: `test/backup-import.test.ts`
- Modify: `test/settings-model-render.test.ts`
- Modify: `test/page-actions.test.ts`
- Modify: `test/e2e/smoke.spec.js`

**Interfaces:**

- Consumes: migration, comic guards, repository, and queue.
- Produces: backup schema version 2 and visible migration/classification progress.

- [ ] **Step 1: Write failing backup and read-only integration tests**

```ts
it('exports only schema version 2 canonical collections', async () => {
  const payload = await buildBackup(deps);
  expect(payload.schemaVersion).toBe(2);
  expect(payload).toHaveProperty('referenceAssets');
  expect(JSON.stringify(payload)).not.toMatch(/embedding|referenceKey|locationKey|"tag"/);
});

it('converts an unversioned backup before writing canonical stores', async () => {
  const payload = parseBackup(JSON.stringify(legacyFixture));
  await importBackup(payload, deps);
  expect(deps.put).toHaveBeenCalledWith('referenceAssets', expect.objectContaining({ worldId: 'w1' }));
});

it('blocks reroll for a legacy comic at the command boundary', async () => {
  await expect(rerollLegacyComic()).rejects.toThrow('This comic is read-only');
});
```

- [ ] **Step 2: Run tests and verify failures**

Run: `npx vitest run test/backup-import.test.ts test/settings-model-render.test.ts test/page-actions.test.ts`

Expected: FAIL while backups are unversioned and legacy actions/settings remain.

- [ ] **Step 3: Implement versioned transfer and all mutation guards**

```ts
export interface BackupPayloadV2 {
  schemaVersion: 2;
  worlds: readonly BackupRecord[];
  locations: readonly BackupRecord[];
  characters: readonly BackupRecord[];
  referenceAssets: readonly BackupRecord[];
  classificationJobs: readonly BackupRecord[];
  comics: readonly BackupRecord[];
  pages: readonly BackupRecord[];
  presets: readonly BackupRecord[];
  imagePresets: readonly BackupRecord[];
  exportedAt: string;
}
```

Make import transactional after full validation; route unversioned input through the isolated migration converter. Add read-only badges and allow only View, Export, and Delete for legacy comics. Guard continuation, generate, reroll, retry, and page-write services with `assertComicWritable`. Show unresolved parent assignments and durable progress. Remove embedding model, reference mode, reference budget override, stale refresh, and old classifier controls; retain only local classifier availability/download/progress.

- [ ] **Step 4: Run backup, settings, library, and E2E tests**

Run: `npx vitest run test/backup-import.test.ts test/settings-model-render.test.ts test/page-actions.test.ts test/reference-migration.test.ts && npm run test:e2e -- --grep "read-only comic|migration progress"`

Expected: PASS or, for unavailable browser dependencies, a documented environment failure with all unit tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/js/pages/library.ts src/js/pages/create.ts src/js/pages/settings.ts src/js/settings/backup-import.ts src/js/export-actions.ts test/backup-import.test.ts test/settings-model-render.test.ts test/page-actions.test.ts test/e2e/smoke.spec.js
git commit -m "feat: complete unified reference migration"
```

---

### Task 11: Remove Legacy Modules and Run Whole-System Verification

**Files:**

- Delete: `src/js/reference-metadata.ts`
- Delete: `src/js/entity-gallery.ts` after Task 9 removes its final consumers
- Delete: `test/reference-metadata.test.ts`
- Modify: any remaining imports found by the explicit scans below
- Modify: `docs/superpowers/specs/2026-07-22-unified-world-reference-system-design.md` only if implementation revealed a factual correction; do not broaden scope.

**Interfaces:**

- Produces: no legacy runtime symbols and a fully verified branch.

- [ ] **Step 1: Add the final forbidden-symbol integrity test**

```js
import fs from 'node:fs';
import path from 'node:path';

function sourceFilesContaining(pattern, dir = 'src/js') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesContaining(pattern, item);
    if (!/\.[jt]s$/.test(entry.name) || item.endsWith('references/legacy-migration.ts')) return [];
    return fs.readFileSync(item, 'utf8').includes(pattern) ? [item] : [];
  });
}

it('contains no legacy reference runtime symbols', () => {
  const forbidden = [
    'charRefMode',
    'embeddingText',
    'buildImageEmbeddingText',
    'referenceKey',
    'locationKey',
    'referenceClassifications',
  ];
  for (const symbol of forbidden) expect(sourceFilesContaining(symbol)).toEqual([]);
});
```

Place this check in `test/config-integrity.test.js`, scoped to `src/js/` and excluding the isolated legacy migration decoder where old input property names are intentionally read.

- [ ] **Step 2: Run the integrity test and remove every reported normal-runtime use**

Run: `npx vitest run test/config-integrity.test.js`

Expected: FAIL until legacy modules/imports/settings are removed, then PASS.

- [ ] **Step 3: Delete obsolete modules and complete type cleanup**

```bash
git rm src/js/reference-metadata.ts src/js/entity-gallery.ts test/reference-metadata.test.ts
rg -n "charRefMode|embeddingModel|embeddingText|buildImageEmbeddingText|referenceKey|locationKey|referenceClassifications|TAG_KEYWORDS" src/js test
```

Expected: only deliberate old-shape reads inside `references/legacy-migration.ts` and its fixtures. Remove obsolete `ImageRef` reference metadata, gallery configuration hooks, generation variation keys, and dead settings before proceeding.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
npm run typecheck:core
npm run typecheck
npm test
npm run coverage
npm run lint
npm run format:check
npm run build
npm run test:e2e
npx cap sync android
cd android && ./gradlew assembleDebug
```

Expected: all available checks pass; coverage remains at least 60% lines and 55% branches. Do not claim Android or E2E success if the environment prevents those commands from running.

- [ ] **Step 5: Request review, fix findings, re-run affected checks, and commit**

```bash
git add src test android package.json package-lock.json docs/superpowers/specs/2026-07-22-unified-world-reference-system-design.md
git commit -m "refactor: remove legacy reference system"
```

Use `superpowers:requesting-code-review`. Resolve every confirmed finding, rerun the smallest affected test set plus the complete static checks, and finish with `superpowers:verification-before-completion`.
