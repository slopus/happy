import type { Metadata } from '@/sync/storageTypes';
import { hackModes } from '@/sync/modeHacks';
import { getCodeAgentDefaults } from '@/sync/agentDefaults';
import { isRetiredAgentFlavor } from '@/sync/retiredSessions';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
};

export type PermissionMode = ModeOption;
export type ModelMode = ModeOption;

export type EffortLevel = ModeOption;
export type PermissionModeKey = string;
export type ModelModeKey = string;

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | string | null | undefined;

export const DEFAULT_MODEL_LABEL = 'default model';
export const DEFAULT_EFFORT_LABEL = 'default effort';

type Translate = (key: any) => string;

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
};

const GEMINI_MODEL_FALLBACKS: ModelMode[] = [
    { key: 'gemini-3.1-pro-preview', name: 'gemini 3.1 pro', description: 'latest & most capable' },
    { key: 'gemini-3-flash-preview', name: 'gemini 3 flash', description: 'latest & fast' },
    { key: 'gemini-3.1-flash-lite-preview', name: 'gemini 3.1 flash lite', description: 'latest & fastest' },
    { key: 'gemini-2.5-pro', name: 'gemini 2.5 pro', description: 'most capable' },
    { key: 'gemini-2.5-flash', name: 'gemini 2.5 flash', description: 'fast & efficient' },
    { key: 'gemini-2.5-flash-lite', name: 'gemini 2.5 flash lite', description: 'fastest' },
];

export function mapMetadataOptions(options?: MetadataOption[] | null): ModeOption[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
    }));
}

export function getClaudePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'plan', name: translate('agentInput.permissionMode.plan'), description: null },
        { key: 'dontAsk', name: translate('agentInput.permissionMode.dontAsk'), description: null },
        { key: 'acceptEdits', name: translate('agentInput.permissionMode.acceptEdits'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: null },
    ];
}

export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.codexPermissionMode.default'), description: null },
        { key: 'read-only', name: translate('agentInput.codexPermissionMode.readOnly'), description: null },
        { key: 'acceptEdits', name: translate('agentInput.taskPermission.confirm'), description: translate('agentInput.taskPermission.confirmDescription') },
        { key: 'safe-yolo', name: translate('agentInput.taskPermission.automatic'), description: translate('agentInput.taskPermission.automaticDescription') },
        { key: 'yolo', name: translate('agentInput.taskPermission.fullAccess'), description: translate('agentInput.taskPermission.fullAccessDescription') },
    ];
}

export function getGeminiPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.geminiPermissionMode.default'), description: null },
        { key: 'yolo', name: translate('agentInput.geminiPermissionMode.yolo'), description: null },
    ];
}


export function getClaudeModelModes(): ModelMode[] {
    return [
        { key: 'default', name: DEFAULT_MODEL_LABEL, description: null },
        { key: 'opus', name: 'Opus', description: null },
        { key: 'sonnet', name: 'Sonnet', description: null },
        { key: 'haiku', name: 'Haiku', description: null },
    ];
}


const CODEX_CURRENT_MODELS: ModelMode[] = [
    { key: 'gpt-6-astra', name: 'gpt-6-astra', description: null },
    { key: 'gpt-6.1-sol', name: 'gpt-6.1-sol', description: null },
    { key: 'gpt-6-sol', name: 'gpt-6-sol', description: null },
    { key: 'gpt-6-luna', name: 'gpt-6-luna', description: null },
];

export function getCodexModelModes(): ModelMode[] {
    return [
        ...CODEX_CURRENT_MODELS,
        { key: 'gpt-5.6-sol', name: 'gpt-5.6-sol', description: null },
        { key: 'gpt-5.6-terra', name: 'gpt-5.6-terra', description: null },
        { key: 'gpt-5.6-luna', name: 'gpt-5.6-luna', description: null },
        { key: 'gpt-5.5', name: 'gpt-5.5', description: null },
        { key: 'gpt-5.4', name: 'gpt-5.4', description: null },
        { key: 'gpt-5.4-mini', name: 'gpt-5.4-mini', description: null },
        { key: 'gpt-5.3-codex-spark', name: 'gpt-5.3-codex-spark', description: null },
    ];
}

export function getGeminiModelModes(): ModelMode[] {
    return GEMINI_MODEL_FALLBACKS;
}

export function getOpenClawPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: null },
    ];
}

export function getOpenCodePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
    ];
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    if (isRetiredAgentFlavor(flavor)) return [];
    if (flavor === 'antigravity') return [{ key: 'default', name: translate('agentInput.permissionMode.default'), description: null }];
    if (flavor === 'codex') {
        return getCodexPermissionModes(translate);
    }
    if (flavor === 'gemini') {
        return getGeminiPermissionModes(translate);
    }
    if (flavor === 'opencode') {
        return getOpenCodePermissionModes(translate);
    }
    if (flavor === 'openclaw') {
        return getOpenClawPermissionModes(translate);
    }
    return getClaudePermissionModes(translate);
}

export function getOpenClawModelModes(): ModelMode[] {
    return [
        { key: 'default', name: DEFAULT_MODEL_LABEL, description: null },
    ];
}

export function getOpenCodeModelModes(): ModelMode[] {
    return [
        { key: 'default', name: DEFAULT_MODEL_LABEL, description: null },
        { key: 'sub2api/gpt-5.5', name: 'sub2api gpt-5.5', description: 'local codex proxy' },
        { key: 'deepseek/deepseek-v4-pro', name: 'deepseek v4 pro', description: 'most capable' },
        { key: 'deepseek/deepseek-v4-flash', name: 'deepseek v4 flash', description: 'fast' },
        { key: 'deepseek/deepseek-chat', name: 'deepseek chat', description: null },
        { key: 'deepseek/deepseek-reasoner', name: 'deepseek reasoner', description: 'reasoning' },
    ];
}

export function getHardcodedModelModes(flavor: AgentFlavor, _translate: Translate): ModelMode[] {
    if (isRetiredAgentFlavor(flavor)) return [];
    if (flavor === 'antigravity') return [{ key: 'default', name: DEFAULT_MODEL_LABEL, description: null }];
    if (flavor === 'codex') {
        return getCodexModelModes();
    }
    if (flavor === 'gemini') {
        return getGeminiModelModes();
    }
    if (flavor === 'opencode') {
        return getOpenCodeModelModes();
    }
    if (flavor === 'openclaw') {
        return getOpenClawModelModes();
    }
    return getClaudeModelModes();
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
): ModelMode[] {
    if (isRetiredAgentFlavor(flavor)) return [];
    const metadataModels = mapMetadataOptions(metadata?.models);
    if (metadataModels.length > 0) {
        return flavor === 'codex' ? metadataModels.filter(model => model.key !== 'default') : metadataModels;
    }
    return getHardcodedModelModes(flavor, translate);
}

// A catalog belongs to this session's connection. Never add models from another
// provider or a hardcoded newer release: visibility does not establish support.
export function getSuggestedModelModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
): ModelMode[] {
    return getAvailableModels(flavor, metadata, translate);
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
): PermissionMode[] {
    if (isRetiredAgentFlavor(flavor)) return [];
    if (flavor === 'claude' || flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode' || flavor === 'openclaw') {
        return hackModes(getHardcodedPermissionModes(flavor, translate));
    }

    const metadataModes = mapMetadataOptions(metadata?.operatingModes);
    if (metadataModes.length > 0) {
        return hackModes(metadataModes);
    }

    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return null;
}

export function getDefaultModelKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).modelMode;
}

export function getDefaultPermissionModeKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).permissionMode;
}

// Effort levels per agent type

export function getClaudeEffortLevels(): EffortLevel[] {
    return [
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'xhigh', name: 'xhigh' },
        { key: 'max', name: 'max' },
    ];
}

export function getCodexEffortLevels(): EffortLevel[] {
    return [
        { key: 'default', name: DEFAULT_EFFORT_LABEL },
        { key: 'minimal', name: 'minimal' },
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'xhigh', name: 'xhigh' },
        { key: 'max', name: 'max' },
        { key: 'ultra', name: 'ultra' },
    ];
}

export function getHardcodedEffortLevels(flavor: AgentFlavor): EffortLevel[] {
    if (flavor === 'claude') return getClaudeEffortLevels();
    if (flavor === 'codex') return getCodexEffortLevels();
    return [];
}

export function getDefaultEffortKey(flavor: AgentFlavor): string | null {
    return getCodeAgentDefaults(flavor).effortLevel;
}

// Per-model effort: returns effort levels for a specific model, or empty if the model has no effort
export function getEffortLevelsForModel(flavor: AgentFlavor, modelKey: string, metadata?: Metadata | null): EffortLevel[] {
    if (flavor === 'antigravity') {
        if (metadata?.currentModelCode === modelKey) return mapMetadataOptions(metadata.thoughtLevels);
        return (metadata?.models?.find(model => model.code === modelKey)?.supportedEffortLevels ?? []).map(key => ({ key, name: key }));
    }
    if (flavor === 'claude') {
        const levels = metadata?.models?.find(model => model.code === modelKey)?.supportedEffortLevels;
        if (levels) return levels.map(key => ({ key, name: key }));
        return getClaudeEffortLevels();
    }
    if (flavor === 'codex') {
        // Another model's current effort catalog does not describe this model.
        // Keep the current Sol/Luna fallback through Ultra until its own catalog arrives.
        if ((modelKey === 'gpt-6.1-sol' || modelKey === 'gpt-6-sol' || modelKey === 'gpt-6-luna')
            && (metadata?.currentModelCode !== modelKey || !metadata.thoughtLevels?.length)) {
            return [
                { key: 'default', name: DEFAULT_EFFORT_LABEL, description: null },
                ...['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((key) => ({ key, name: key })),
            ];
        }
        const metadataEfforts = mapMetadataOptions(metadata?.thoughtLevels);
        if (metadataEfforts.length > 0) {
            return [
                { key: 'default', name: DEFAULT_EFFORT_LABEL, description: null },
                ...metadataEfforts.filter((level) => level.key !== 'default'),
            ];
        }
        return getCodexEffortLevels();
    }
    return [];
}

// A model switch can retain an effort from the previous model in session state.
// Keep picker and outbound metadata consistent without rewriting that state.
export function normalizeModelEffortKey(
    flavor: AgentFlavor,
    modelKey: string,
    effortKey: string | null | undefined,
    metadata?: Metadata | null,
): string | null | undefined {
    if (flavor === 'claude') {
        const supported = metadata?.models?.find(model => model.code === modelKey)?.supportedEffortLevels;
        if (!supported) return effortKey;
        if (!supported.length) return null;
        return effortKey && supported.includes(effortKey) ? effortKey : supported.includes('medium') ? 'medium' : supported[0];
    }
    if (flavor === 'antigravity') {
        const levels = getEffortLevelsForModel(flavor, modelKey, metadata);
        if (effortKey && levels.some(level => level.key === effortKey)) return effortKey;
        const current = metadata?.currentModelCode === modelKey ? metadata.currentThoughtLevelCode : null;
        return current && levels.some(level => level.key === current) ? current : null;
    }
    if (flavor !== 'codex') return effortKey;
    const levels = getEffortLevelsForModel(flavor, modelKey, metadata).filter((level) => level.key !== 'default');
    const fallback = levels.find((level) => level.key === 'medium')?.key ?? levels[0]?.key ?? null;
    if (effortKey === 'default' || !effortKey) return fallback;
    const hasRelevantCatalog = metadata?.currentModelCode === modelKey && !!metadata.thoughtLevels?.length;
    if (!hasRelevantCatalog && !['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'].includes(modelKey)) return effortKey;
    return levels.some((level) => level.key === effortKey) ? effortKey : fallback;
}

// Default effort for a model — highest the model allows
export function getDefaultEffortKeyForModel(flavor: AgentFlavor, modelKey: string): string | null {
    const levels = getEffortLevelsForModel(flavor, modelKey);
    if (levels.length === 0) return null;
    return getCodeAgentDefaults(flavor).effortLevel ?? levels[0].key;
}

export function getSupportsWorktree(flavor: AgentFlavor): boolean {
    if (isRetiredAgentFlavor(flavor) || flavor === 'openclaw') return false;
    return true;
}
