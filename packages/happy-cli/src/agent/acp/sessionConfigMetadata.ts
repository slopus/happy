import type { Metadata } from '@/api/types';
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';

type SupportedCategory = 'mode' | 'model' | 'thought_level';

const SUPPORTED_CATEGORIES = new Set<SupportedCategory>(['mode', 'model', 'thought_level']);

type MetadataOption = {
  code: string;
  value: string;
  description?: string | null;
};

export type AcpSessionConfigSnapshot = {
  configOptions?: SessionConfigOption[] | null;
  modes?: SessionModeState | null;
  models?: SessionModelState | null;
  currentModeId?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isOptionValue(value: unknown): value is { value: string; name: string; description?: string | null } {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.value === 'string' && typeof value.name === 'string';
}

function isOptionGroup(value: unknown): value is { options: unknown[] } {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.options);
}

function flattenConfigSelectOptions(options: unknown): MetadataOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  const flattened: MetadataOption[] = [];

  for (const entry of options) {
    if (isOptionValue(entry)) {
      flattened.push({
        code: entry.value,
        value: entry.name,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      });
      continue;
    }

    if (isOptionGroup(entry)) {
      for (const grouped of entry.options) {
        if (!isOptionValue(grouped)) {
          continue;
        }
        flattened.push({
          code: grouped.value,
          value: grouped.name,
          ...(grouped.description !== undefined ? { description: grouped.description } : {}),
        });
      }
    }
  }

  return flattened;
}

function findConfigOptionByCategory(
  configOptions: SessionConfigOption[],
  category: SupportedCategory,
): SessionConfigOption | null {
  for (const option of configOptions) {
    if (option.type !== 'select') {
      continue;
    }
    if (option.category !== category) {
      continue;
    }
    return option;
  }
  return null;
}

function applyConfigCategory(
  metadata: Metadata,
  option: SessionConfigOption | null,
  kind: SupportedCategory,
): void {
  if (!option) {
    if (kind === 'model') {
      delete metadata.models;
      delete metadata.currentModelCode;
    } else if (kind === 'mode') {
      delete metadata.operatingModes;
      delete metadata.currentOperatingModeCode;
    } else if (kind === 'thought_level') {
      delete metadata.thoughtLevels;
      delete metadata.currentThoughtLevelCode;
    }
    return;
  }

  const values = flattenConfigSelectOptions(option.options);
  const currentCode = option.currentValue;

  if (kind === 'model') {
    metadata.models = values;
    metadata.currentModelCode = currentCode;
    return;
  }

  if (kind === 'mode') {
    metadata.operatingModes = values;
    metadata.currentOperatingModeCode = currentCode;
    return;
  }

  metadata.thoughtLevels = values;
  metadata.currentThoughtLevelCode = currentCode;
}

export function extractConfigOptionsFromPayload(payload: unknown): SessionConfigOption[] | null {
  if (Array.isArray(payload)) {
    return payload as SessionConfigOption[];
  }
  if (isRecord(payload) && Array.isArray(payload.configOptions)) {
    return payload.configOptions as SessionConfigOption[];
  }
  return null;
}

export function extractModeStateFromPayload(payload: unknown): SessionModeState | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (!Array.isArray(payload.availableModes)) {
    return null;
  }
  if (typeof payload.currentModeId !== 'string') {
    return null;
  }
  return payload as SessionModeState;
}

export function extractModelStateFromPayload(payload: unknown): SessionModelState | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (!Array.isArray(payload.availableModels)) {
    return null;
  }
  if (typeof payload.currentModelId !== 'string') {
    return null;
  }
  return payload as SessionModelState;
}

export function extractCurrentModeIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (typeof payload.currentModeId !== 'string') {
    return null;
  }
  return payload.currentModeId;
}

export function mergeAcpSessionConfigIntoMetadata(metadata: Metadata, snapshot: AcpSessionConfigSnapshot): Metadata {
  const next: Metadata = { ...metadata };

  let hasModeFromConfig = false;
  let hasModelFromConfig = false;

  if (Array.isArray(snapshot.configOptions)) {
    const filtered = snapshot.configOptions.filter(
      (option) => option.type === 'select' && typeof option.category === 'string' && SUPPORTED_CATEGORIES.has(option.category as SupportedCategory),
    );

    const modeOption = findConfigOptionByCategory(filtered, 'mode');
    const modelOption = findConfigOptionByCategory(filtered, 'model');
    const thoughtLevelOption = findConfigOptionByCategory(filtered, 'thought_level');

    hasModeFromConfig = modeOption !== null;
    hasModelFromConfig = modelOption !== null;

    applyConfigCategory(next, modeOption, 'mode');
    applyConfigCategory(next, modelOption, 'model');
    if (metadata.flavor === 'antigravity' && next.models) {
      next.models = next.models.map(model => {
        const prior = metadata.models?.find(item => item.code === model.code)?.supportedEffortLevels;
        const levels = model.code === modelOption?.currentValue
          ? flattenConfigSelectOptions(thoughtLevelOption?.options).map(level => level.code) : prior;
        return levels === undefined ? model : { ...model, supportedEffortLevels: levels };
      });
    }
    applyConfigCategory(next, thoughtLevelOption, 'thought_level');
  }

  if (!hasModelFromConfig && snapshot.models) {
    next.models = snapshot.models.availableModels.map((model) => ({
      code: model.modelId,
      value: model.name,
      ...(model.description !== undefined ? { description: model.description } : {}),
    }));
    next.currentModelCode = snapshot.models.currentModelId;
  }

  if (!hasModeFromConfig && snapshot.modes) {
    next.operatingModes = snapshot.modes.availableModes.map((mode) => ({
      code: mode.id,
      value: mode.name,
      ...(mode.description !== undefined ? { description: mode.description } : {}),
    }));
    next.currentOperatingModeCode = snapshot.modes.currentModeId;
  }

  if (snapshot.currentModeId) {
    next.currentOperatingModeCode = snapshot.currentModeId;
  }

  return next;
}

/** agy advertises legacy base-effort IDs alongside categorized configOptions.
 * Use those actual IDs only to seed unobserved model ranges; the current
 * model's configOptions remain authoritative and are revalidated before use.
 */
export function mergeAntigravityLegacyEfforts(metadata: Metadata, legacy: SessionModelState): Metadata {
  if (metadata.flavor !== 'antigravity' || !metadata.models) return metadata;
  return { ...metadata, models: metadata.models.map(model => {
    const levels = model.code === metadata.currentModelCode && metadata.thoughtLevels
      ? metadata.thoughtLevels.map(level => level.code)
      : model.supportedEffortLevels ?? legacy.availableModels.flatMap(variant => {
        const prefix = `${model.code}-`;
        if (!variant.modelId.startsWith(prefix)) return [];
        const effort = variant.modelId.slice(prefix.length);
        return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? [effort] : [];
      });
    return levels.length || model.supportedEffortLevels !== undefined || (model.code === metadata.currentModelCode && metadata.thoughtLevels)
      ? { ...model, supportedEffortLevels: [...new Set(levels)] } : model;
  }) };
}
