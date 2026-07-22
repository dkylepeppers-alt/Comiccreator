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
