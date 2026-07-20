import type {
  CharacterLike,
  CharacterVisualState,
  PlannedPanel,
  PreviousFrameRef,
  ReferenceManifestItem,
  WorldLike,
} from '../../visual-continuity.js';

export type ContinuityStrategy = 'sequential-page' | 'independent-panels';

export type PanelRenderState = Record<string, CharacterVisualState>;

export interface ContinuityPlanningInput {
  readonly pageModelId: string;
  /** Opaque provider metadata. The planner narrows only the capability fields it consumes. */
  readonly pageModel: unknown;
  readonly companionModelId?: string | null;
  /** Opaque provider metadata for independent panel requests. */
  readonly companionModel?: unknown;
  readonly imageSize: string;
  readonly sequentialEnabled: boolean;
  readonly panels: readonly PlannedPanel[];
  readonly renderStates: readonly PanelRenderState[];
  readonly charactersById: Readonly<Record<string, CharacterLike>>;
  readonly selectedCharacterIds: readonly string[];
  readonly world?: WorldLike | null;
  readonly referenceBudget: number | 'auto' | null | undefined;
  readonly useReferenceImages: boolean;
  readonly previousFrame?: PreviousFrameRef | null;
  readonly anchorImageIdByCharacter?: Readonly<Record<string, string | null | undefined>>;
  /** Present, including an empty array, when planning a targeted retry. */
  readonly targetPanelIndexes?: readonly number[];
  readonly stylePreset?: string;
  readonly negativePrompt?: string;
  /** Resolved preflight warnings, in display order. */
  readonly warnings?: readonly string[];
}

interface ContinuityRequestBase {
  readonly panelIndexes: readonly number[];
  readonly modelId: string;
  readonly expectedImageCount: number;
  readonly prompt: string;
  readonly imageDataUrls: readonly string[];
  readonly negativePrompt?: string;
}

export interface SequentialContinuityRequest extends ContinuityRequestBase {
  readonly id: 'page-sequence';
}

export interface PanelContinuityRequest extends ContinuityRequestBase {
  readonly id: `panel-${number}`;
  readonly panelIndexes: readonly [number];
  readonly expectedImageCount: 1;
}

export type ContinuityRequest = SequentialContinuityRequest | PanelContinuityRequest;

export interface BlockedContinuityPanel {
  readonly panelIndex: number;
  readonly required: number;
  readonly capacity: number;
}

interface ContinuityGenerationPlanBase {
  readonly pageModelId: string;
  readonly effectiveModelId: string;
  readonly imageSize: string;
  readonly requests: readonly ContinuityRequest[];
  readonly compiledPrompts: readonly string[];
  /** Panel descriptions aligned to input panel indexes; null means no request was planned. */
  readonly panelPrompts: readonly (string | null)[];
  readonly referenceManifest: readonly ReferenceManifestItem[];
  readonly warnings: readonly string[];
  readonly blockedPanels: readonly BlockedContinuityPanel[];
}

export interface SequentialContinuityGenerationPlan extends ContinuityGenerationPlanBase {
  readonly strategy: 'sequential-page';
  readonly requests: readonly SequentialContinuityRequest[];
}

export interface IndependentContinuityGenerationPlan extends ContinuityGenerationPlanBase {
  readonly strategy: 'independent-panels';
  readonly requests: readonly PanelContinuityRequest[];
}

export type ContinuityGenerationPlan = SequentialContinuityGenerationPlan | IndependentContinuityGenerationPlan;
