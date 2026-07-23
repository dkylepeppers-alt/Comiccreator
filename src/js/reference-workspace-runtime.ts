import DB from './db.js';
import { createReferenceWorkspace } from './reference-workspace.js';
import { createClassificationQueue } from './references/classification-queue.js';
import { localReferenceClassifier } from './references/local-classifier.js';
import { createReferenceRepository } from './references/repository.js';
import type { ReferenceAsset } from './references/types.js';

export const referenceRepository = createReferenceRepository();

export const referenceClassificationQueue = createClassificationQueue({
  repository: referenceRepository,
  classifier: {
    classify: async (asset) => {
      const world = await DB.get(DB.STORES.worlds, asset.worldId);
      if (!world) {
        return {
          kind: 'failure' as const,
          error: { stage: 'validation' as const, code: 'missing-asset' as const, mode: 'local' as const },
        };
      }
      const characters = (await DB.getAll(DB.STORES.characters))
        .filter((character) => (character.worldId || character.linkedWorldId) === asset.worldId)
        .map(({ id, name, appearance }) => ({ id, name, appearance }));
      return localReferenceClassifier.classify({
        asset,
        world: {
          id: world.id,
          name: world.name,
          description: world.description,
        },
        characters,
        locations: await referenceRepository.listLocations(asset.worldId),
      });
    },
  },
  now: () => Date.now(),
});

export const referenceWorkspace = createReferenceWorkspace({
  repository: referenceRepository,
  queue: referenceClassificationQueue,
  listCharacters: async (worldId) =>
    (await DB.getAll(DB.STORES.characters))
      .filter((character) => (character.worldId || character.linkedWorldId) === worldId)
      .map(({ id, name }) => ({ id, name })),
  listLocations: (worldId) => referenceRepository.listLocations(worldId),
});

interface QueueLifecycle {
  run(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
}

interface VisibilityTarget extends EventTarget {
  visibilityState: string;
}

/** Start recovery after DB initialization and suspend local inference whenever the app is hidden. */
export function installReferenceQueueLifecycle(
  queue: QueueLifecycle = referenceClassificationQueue,
  documentTarget: VisibilityTarget = document,
): () => void {
  const containFailure = (operation: Promise<void>) => void operation.catch(() => undefined);
  const handleVisibility = () => {
    if (documentTarget.visibilityState === 'visible') containFailure(queue.resume());
    else queue.pause();
  };
  documentTarget.addEventListener('visibilitychange', handleVisibility);
  if (documentTarget.visibilityState === 'visible') containFailure(queue.run());
  else queue.pause();
  return () => documentTarget.removeEventListener('visibilitychange', handleVisibility);
}

let referenceEditorRestoreFocus: HTMLElement | null = null;
let referenceEditorEscapeListenerAttached = false;

export function closeReferenceEditor(): void {
  App.hideModal();
  referenceEditorRestoreFocus?.focus();
  referenceEditorRestoreFocus = null;
}

function handleReferenceEditorEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !document.querySelector('#modal-content [data-reference-editor]')) return;
  event.preventDefault();
  closeReferenceEditor();
}

/** Open the shared editor and place keyboard focus on its first decision. */
export async function openReferenceEditor(worldId: string, referenceId: string): Promise<void> {
  referenceEditorRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  App.showModal(await referenceWorkspace.renderEditor({ worldId, referenceId }));
  if (!referenceEditorEscapeListenerAttached) {
    document.addEventListener('keydown', handleReferenceEditorEscape);
    referenceEditorEscapeListenerAttached = true;
  }
  document.querySelector<HTMLElement>('#modal-content [autofocus]')?.focus();
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected image'));
    reader.readAsDataURL(file);
  });
}

export async function addUploadedReference({
  worldId,
  characterId,
  dataUrl,
  source = 'uploaded',
}: {
  worldId: string;
  characterId?: string;
  dataUrl: string;
  source?: 'uploaded' | 'generated';
}): Promise<ReferenceAsset> {
  const now = Date.now();
  const asset: ReferenceAsset = {
    id: DB.uuid(),
    worldId,
    dataUrl,
    subjectType: null,
    use: null,
    characterIds: characterId ? [characterId] : [],
    locationId: null,
    facets: {},
    description: '',
    confidence: {},
    provenance: { source, metadata: 'local' },
    classificationState: 'pending',
    acceptedAsIs: false,
    autoUse: true,
    createdAt: now,
    updatedAt: now,
  };
  await referenceRepository.putAsset(asset);
  await referenceClassificationQueue.enqueue(asset.id);
  void referenceClassificationQueue.run();
  return asset;
}
