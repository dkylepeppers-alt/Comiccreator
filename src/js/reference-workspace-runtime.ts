import API from './api.js';
import DB from './db.js';
import { createReferenceWorkspace } from './reference-workspace.js';
import { createClassificationQueue } from './references/classification-queue.js';
import { createClassifierRouter } from './references/classifier-router.js';
import type { ClassifierOrder } from './references/classifier-router.js';
import { createCloudReferenceClassifier } from './references/cloud-classifier.js';
import { localReferenceClassifier } from './references/local-classifier.js';
import { createReferenceRepository } from './references/repository.js';
import { readGenerateReferenceDialog, renderGenerateReferenceDialog } from './reference-generation-dialog.js';
import type { ReferenceAsset } from './references/types.js';

export const referenceRepository = createReferenceRepository();

export const cloudReferenceClassifier = createCloudReferenceClassifier({
  classifyImage: (dataUrl, prompt) => API.classifyReferenceImage(dataUrl, prompt),
  isConfigured: () => API.canClassifyReferenceImages(),
});

const VALID_ORDERS: ClassifierOrder[] = ['cloud', 'local', 'local-then-cloud'];

/** Cloud is the default on both the PWA and Android; it is multimodal and far more accurate. */
export async function getClassifierOrder(): Promise<ClassifierOrder> {
  const stored = await DB.getSetting<ClassifierOrder>('classificationBackend', 'cloud');
  return VALID_ORDERS.includes(stored as ClassifierOrder) ? (stored as ClassifierOrder) : 'cloud';
}

export const referenceClassifier = createClassifierRouter({
  cloud: cloudReferenceClassifier,
  local: localReferenceClassifier,
  getOrder: getClassifierOrder,
});

/** True when any backend the current order permits can classify right now. */
export async function isAnyClassifierAvailable(): Promise<boolean> {
  const order = await getClassifierOrder();
  const backends =
    order === 'local' ? [localReferenceClassifier] : [cloudReferenceClassifier, localReferenceClassifier];
  for (const backend of backends) {
    try {
      if ((await backend.getAvailability()).status === 'available') return true;
    } catch {
      /* treat an availability error as unavailable and keep checking */
    }
  }
  return false;
}

export const referenceClassificationQueue = createClassificationQueue({
  repository: referenceRepository,
  classifier: {
    classify: async (asset) => {
      const world = await DB.get(DB.STORES.worlds, asset.worldId);
      if (!world) {
        return {
          kind: 'failure' as const,
          error: { stage: 'validation' as const, code: 'missing-asset' as const },
        };
      }
      const characters = (await DB.getAll(DB.STORES.characters))
        .filter((character) => (character.worldId || character.linkedWorldId) === asset.worldId)
        .map(({ id, name, appearance }) => ({ id, name, appearance }));
      return referenceClassifier.classify({
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

let generateReferenceWorldId: string | null = null;

/**
 * Open the shared "Generate reference" dialog for a world. The user picks the
 * target character and which existing reference images to send to the model.
 */
export async function openGenerateReferenceDialog({
  worldId,
  characterId = null,
}: {
  worldId: string;
  characterId?: string | null;
}): Promise<void> {
  const [world, allCharacters, references] = await Promise.all([
    DB.get(DB.STORES.worlds, worldId),
    DB.getAll(DB.STORES.characters),
    referenceRepository.listByWorld(worldId),
  ]);
  if (!world) return;
  generateReferenceWorldId = worldId;
  const characters = allCharacters
    .filter((character) => (character.worldId || character.linkedWorldId) === worldId)
    .map(({ id, name }) => ({ id, name }));
  App.showModal(
    renderGenerateReferenceDialog({
      worldName: world.name,
      characters,
      references,
      defaultCharacterId: characterId,
    }),
  );
  document.querySelector<HTMLElement>('#modal-content [autofocus]')?.focus();
}

/** Submit handler for the dialog; generates the image and stores it as a new reference. */
export async function submitGenerateReference(): Promise<void> {
  const worldId = generateReferenceWorldId;
  const root = document.getElementById('modal-content');
  if (!worldId || !root) return;
  const { prompt, characterId, referenceIds } = readGenerateReferenceDialog(root);
  if (!prompt) return App.toast('Describe the reference to generate', 'error');
  const submit = root.querySelector<HTMLButtonElement>('[data-generate-ref-submit]');
  if (submit?.disabled) return;
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Generating…';
  }
  try {
    const sources = await Promise.all(referenceIds.map((id) => referenceRepository.getAsset(id)));
    const imageDataUrls = sources.map((asset) => asset?.dataUrl).filter((dataUrl): dataUrl is string => !!dataUrl);
    const dataUrl = await API.generateRefVariation(null, prompt, { imageDataUrls });
    if (!dataUrl) return App.toast('Reference generation failed', 'error');
    await addUploadedReference({
      worldId,
      characterId: characterId || undefined,
      dataUrl,
      source: 'generated',
    });
    generateReferenceWorldId = null;
    App.hideModal();
    App.toast('Generated reference added', 'success');
    App.refreshPage();
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Generate';
    }
  }
}
