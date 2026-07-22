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

export type ClassificationState = 'pending' | 'ready' | 'needs-review' | 'could-not-classify';
export type ClassificationJobStatus = 'pending' | 'running' | 'complete' | 'failed';
export type ClassificationStage = 'plugin' | 'decode' | 'inference' | 'parse' | 'validation';
export type ClassificationErrorCode =
  | 'plugin-unavailable'
  | 'decode-failed'
  | 'inference-failed'
  | 'invalid-json'
  | 'invalid-schema'
  | 'low-confidence'
  | 'unmatched-entity-links'
  | 'manual-metadata'
  | 'missing-asset'
  | 'busy';
export type ClassificationWaitingReason = 'model-unavailable' | 'model-downloading' | 'app-background' | 'quota-busy';

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
  /** Editable names retained when a model's entity link is not in the current roster. */
  proposedCharacterNames?: string[];
  proposedLocationName?: string | null;
  provenance: {
    source: 'uploaded' | 'generated' | 'migrated';
    metadata: 'local' | 'manual' | 'accepted';
  };
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
  proposedCharacterNames?: string[];
  proposedLocationName?: string | null;
}

export type ReferenceClassificationDraft = ReferenceClassification;

export interface ClassificationErrorDetails {
  stage: ClassificationStage;
  code: ClassificationErrorCode;
  mode?: 'local';
  message?: string;
  retryDelayMs?: number;
  validationReason?: string;
  queueState?: ClassificationJobStatus;
}

export type ClassificationOutcome =
  | {
      kind: 'classified';
      classification: ReferenceClassificationDraft;
      state?: Extract<ClassificationState, 'ready' | 'needs-review'>;
      validationReason?: string;
    }
  | { kind: 'waiting'; reason: ClassificationWaitingReason; retryDelayMs: number }
  | { kind: 'failure'; error: ClassificationErrorDetails };

export interface ClassificationDiagnostic {
  id: string;
  assetId: string;
  worldId: string;
  createdAt: number;
  queueState?: ClassificationJobStatus;
  error: ClassificationErrorDetails;
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
  retryAt?: number;
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
