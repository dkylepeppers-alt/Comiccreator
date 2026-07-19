import type { ImageModel } from './api.js';

export type CompanionMode = 'auto' | 'same' | 'custom';

export interface CompanionSettings {
  mode: CompanionMode;
  configuredModelId: string;
  migrated: boolean;
}

const AUTO_COMPANIONS: Record<string, string> = {
  'seedream-v4.5-sequential': 'seedream-v4.5',
};

export function migrateCompanionSettings(mode: unknown, configuredModelId: unknown): CompanionSettings {
  const configured = typeof configuredModelId === 'string' ? configuredModelId.trim() : '';
  if (mode === 'auto' || mode === 'same' || mode === 'custom') {
    return { mode, configuredModelId: configured, migrated: false };
  }
  return { mode: configured ? 'custom' : 'auto', configuredModelId: configured, migrated: true };
}

export function resolveCompanionModel(options: {
  pageModelId: string;
  mode: CompanionMode;
  configuredModelId?: string;
  models: ImageModel[];
}): { modelId: string; warning?: string; error?: string } {
  const available = new Set(options.models.map((model) => model.id));
  if (options.mode === 'same') return { modelId: options.pageModelId };
  if (options.mode === 'custom') {
    const custom = options.configuredModelId?.trim();
    if (!custom) return { modelId: options.pageModelId, error: 'Choose a custom single-image companion model.' };
    if (!available.has(custom)) {
      return { modelId: custom, error: `The custom companion model "${custom}" is not available.` };
    }
    return { modelId: custom };
  }
  const recommended = AUTO_COMPANIONS[options.pageModelId];
  if (!recommended) return { modelId: options.pageModelId };
  if (available.has(recommended)) return { modelId: recommended };
  return {
    modelId: options.pageModelId,
    warning: `The recommended companion ${recommended} is unavailable; independent requests will use ${options.pageModelId}.`,
  };
}

export function selectCompatibleImageSize(options: {
  savedSize: string;
  pageModel?: ImageModel | null;
  companionModel?: ImageModel | null;
  sequentialEnabled: boolean;
}): { size: string; corrected: boolean; sequentialEnabled: boolean; warning?: string } {
  const pageSizes = options.pageModel?.sizes?.filter(Boolean) || [];
  const companionSizes = options.companionModel?.sizes?.filter(Boolean) || [];
  if (!options.sequentialEnabled) {
    const requiredSizes = companionSizes.length ? companionSizes : pageSizes;
    if (!requiredSizes.length || requiredSizes.includes(options.savedSize)) {
      return { size: options.savedSize, corrected: false, sequentialEnabled: false };
    }
    const preferred = requiredSizes.includes('1920x1920') ? '1920x1920' : requiredSizes[0];
    return {
      size: preferred,
      corrected: true,
      sequentialEnabled: false,
      warning: `Image size changed from ${options.savedSize} to ${preferred} because the independent-panel model does not support the saved size.`,
    };
  }
  const intersection =
    pageSizes.length && companionSizes.length
      ? pageSizes.filter((size) => companionSizes.includes(size))
      : pageSizes.length
        ? pageSizes
        : companionSizes;
  if (intersection.length === 0) {
    if (pageSizes.length && companionSizes.length) {
      const preferred = companionSizes.includes('1920x1920') ? '1920x1920' : companionSizes[0];
      return {
        size: preferred,
        corrected: preferred !== options.savedSize,
        sequentialEnabled: false,
        warning: `The page and companion models have no common image size; sequential batching is disabled for this attempt and independent panels will use ${preferred}.`,
      };
    }
    return { size: options.savedSize, corrected: false, sequentialEnabled: options.sequentialEnabled };
  }
  if (intersection.includes(options.savedSize)) {
    return { size: options.savedSize, corrected: false, sequentialEnabled: options.sequentialEnabled };
  }
  const preferred = intersection.includes('1920x1920') ? '1920x1920' : intersection[0];
  return {
    size: preferred,
    corrected: true,
    sequentialEnabled: options.sequentialEnabled,
    warning: `Image size changed from ${options.savedSize} to ${preferred} because the selected route does not support the saved size.`,
  };
}
