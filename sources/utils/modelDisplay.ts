import { ModelMode } from '@/components/PermissionModeSelector';

/**
 * Model tier classification for visual styling
 */
export type ModelTier = 'flagship' | 'balanced' | 'efficient' | 'default';

/**
 * Model display configuration
 */
export interface ModelDisplayConfig {
  /** Human-readable display name */
  name: string;
  /** Short abbreviated name for compact display */
  shortName: string;
  /** Model tier for color coding */
  tier: ModelTier;
  /** Context window size in thousands (e.g., 200 for 200K) */
  contextWindow: number;
}

/**
 * Complete model configuration map
 */
export const MODEL_CONFIGS: Record<ModelMode, ModelDisplayConfig> = {
  // Claude models
  'default': {
    name: 'Sonnet 4.5',
    shortName: 'S4.5',
    tier: 'default',
    contextWindow: 200
  },
  'adaptiveUsage': {
    name: 'Adaptive',
    shortName: 'Adapt',
    tier: 'balanced',
    contextWindow: 200
  },
  'sonnet': {
    name: 'Sonnet 3.5',
    shortName: 'S3.5',
    tier: 'balanced',
    contextWindow: 200
  },
  'opus': {
    name: 'Opus 3',
    shortName: 'Opus',
    tier: 'flagship',
    contextWindow: 200
  },

  // GPT-5 Codex models
  'gpt-5-codex-high': {
    name: 'GPT-5 Codex High',
    shortName: 'C-Hi',
    tier: 'flagship',
    contextWindow: 128
  },
  'gpt-5-codex-medium': {
    name: 'GPT-5 Codex Medium',
    shortName: 'C-Med',
    tier: 'balanced',
    contextWindow: 128
  },
  'gpt-5-codex-low': {
    name: 'GPT-5 Codex Low',
    shortName: 'C-Lo',
    tier: 'efficient',
    contextWindow: 128
  },

  // GPT-5 general models
  'gpt-5-high': {
    name: 'GPT-5 High',
    shortName: 'G-Hi',
    tier: 'flagship',
    contextWindow: 128
  },
  'gpt-5-medium': {
    name: 'GPT-5 Medium',
    shortName: 'G-Med',
    tier: 'balanced',
    contextWindow: 128
  },
  'gpt-5-low': {
    name: 'GPT-5 Low',
    shortName: 'G-Lo',
    tier: 'efficient',
    contextWindow: 128
  },
  'gpt-5-minimal': {
    name: 'GPT-5 Minimal',
    shortName: 'G-Min',
    tier: 'efficient',
    contextWindow: 128
  }
};

/**
 * Get display configuration for a model mode
 */
export function getModelConfig(mode: ModelMode | undefined): ModelDisplayConfig {
  if (!mode) {
    return MODEL_CONFIGS['default'];
  }
  return MODEL_CONFIGS[mode] || MODEL_CONFIGS['default'];
}

/**
 * Get tier-based color for model display
 */
export function getModelTierColor(tier: ModelTier, theme: any): string {
  switch (tier) {
    case 'flagship':
      return theme.colors.model?.flagship || '#7C3AED'; // Purple for flagship
    case 'balanced':
      return theme.colors.model?.balanced || '#3B82F6'; // Blue for balanced
    case 'efficient':
      return theme.colors.model?.efficient || '#10B981'; // Green for efficient
    case 'default':
      return theme.colors.textSecondary;
  }
}

/**
 * Get tier-based background color for model display
 */
export function getModelTierBackgroundColor(tier: ModelTier, theme: any): string {
  switch (tier) {
    case 'flagship':
      return theme.colors.model?.flagshipBg || 'rgba(124, 58, 237, 0.15)';
    case 'balanced':
      return theme.colors.model?.balancedBg || 'rgba(59, 130, 246, 0.15)';
    case 'efficient':
      return theme.colors.model?.efficientBg || 'rgba(16, 185, 129, 0.15)';
    case 'default':
      return theme.colors.surfaceSecondary;
  }
}
