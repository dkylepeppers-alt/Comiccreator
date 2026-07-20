/**
 * Shared types for the image-generation engine extracted from the create page.
 * The engine never touches module-level page state directly — the create page
 * passes a GenerationContext so all mutable dependencies are explicit.
 */

/** Result of preflightImageGeneration(), cached on state for the active attempt. */
export interface ImageGenerationConfig {
  pageModelId: string;
  pageModel: any | null;
  companionModelId: string;
  companionModel: any | null;
  companionMode: string;
  imageSize: string;
  sequentialEnabled: boolean;
  warnings: string[];
}

/** Mutable state of the create page shared with the generation engine. */
export interface CreateState {
  step: 'setup' | 'generating' | 'reading';
  genre: string;
  customGenre: string;
  selectedCharacters: string[];
  selectedWorld: string | null;
  selectedPreset: string | null;
  selectedImagePreset: string | null;
  comicId: string | null;
  title: string;
  storyPrompt: string;
  pages: any[];
  pageIds: string[];
  conversationHistory: Array<{ role: string; content: any }>;
  referenceImages: any[];
  characterImagesByName: Record<string, any>;
  characters: any[];
  world: any | null;
  plannerMode: boolean;
  visualContinuity: any | null;
  initialVisualOverrides: Record<string, any>;
  isGenerating: boolean;
  generatingContext: 'initial' | 'reroll' | 'continue' | 'reimage';
  draftLoaded: boolean;
  generationProgress: any | null;
  imageGenerationConfig: ImageGenerationConfig | null;
}

/**
 * Explicit dependencies the engine needs from the hosting page.
 * `state` must be a live view (getter) — the create page reassigns its state
 * object on reset, so a captured snapshot would go stale.
 */
export interface GenerationContext {
  readonly state: CreateState;
  /** Abort signal of the current generation attempt, if any. */
  signal(): AbortSignal | undefined;
  /** Apply a new generation-progress snapshot (also refreshes progress DOM). */
  setProgress(next: any): void;
  /** User-facing notification (App.toast). */
  toast(message: string, type?: string): void;
  /** Global error log (App.logError). */
  logError(context: string, error: unknown, details?: string): void;
}
