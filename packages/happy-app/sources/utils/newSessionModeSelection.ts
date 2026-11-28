import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    type ModeOption,
} from '@/components/modelModeOptions';
import {
    getCodeAgentDefaults,
    resolveAgentDefaultConfig,
    type AgentDefaultOverrides,
} from '@/sync/agentDefaults';
import type { DraftModeSelection, NewSessionAgentType } from '@/sync/persistence';
import type { Metadata } from '@/sync/storageTypes';

type ResolveSelectionKeyArgs = {
    draftKey: string | null | undefined;
    fallbackKey: string | null | undefined;
    codeDefaultKey?: string | null;
    followDraftKeys?: string[];
    followCodeDefault?: boolean;
    options: ModeOption[];
};

type ResolveEffortKeyArgs = {
    draftKey: string | null | undefined;
    fallbackKey: string | null | undefined;
    codeDefaultKey: string | null | undefined;
    options: ModeOption[];
};

export type NewSessionModeSelection = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

const identityTranslate = (key: string) => key;

function hasOption(options: ModeOption[], key: string | null | undefined): key is string {
    return !!key && options.some((option) => option.key === key);
}

function resolveSelectionKey({
    draftKey,
    fallbackKey,
    codeDefaultKey,
    followDraftKeys = [],
    followCodeDefault = false,
    options,
}: ResolveSelectionKeyArgs): string {
    const followsDefault = (
        !draftKey
        || followDraftKeys.includes(draftKey)
        || (
            followCodeDefault && !!codeDefaultKey
            && !!fallbackKey
            && draftKey === codeDefaultKey
            && draftKey !== fallbackKey
        )
    );

    if (!followsDefault && hasOption(options, draftKey)) {
        return draftKey;
    }
    if (hasOption(options, fallbackKey)) {
        return fallbackKey;
    }
    if (hasOption(options, draftKey)) {
        return draftKey;
    }
    return options[0]?.key ?? fallbackKey ?? draftKey ?? 'default';
}

function resolveEffortKey({
    draftKey,
    fallbackKey,
    codeDefaultKey,
    options,
}: ResolveEffortKeyArgs): string | null {
    if (options.length === 0) {
        return null;
    }

    const followsDefault = !draftKey || draftKey === 'default';

    if (!followsDefault && hasOption(options, draftKey)) {
        return draftKey;
    }
    if (hasOption(options, fallbackKey)) {
        return fallbackKey;
    }
    if (hasOption(options, draftKey)) {
        return draftKey;
    }
    return options.find((option) => option.key !== 'default')?.key ?? null;
}

export function resolveNewSessionModeSelection(args: {
    agent: NewSessionAgentType;
    permissionMode: string | null | undefined;
    modelMode: string | null | undefined;
    effortLevel: string | null | undefined;
    agentDefaultOverrides: AgentDefaultOverrides | null | undefined;
    modelSelection?: DraftModeSelection;
    effortSelection?: DraftModeSelection;
    modelOptions?: ModeOption[];
    effortMetadata?: Metadata | null;
}): NewSessionModeSelection {
    const { agent, permissionMode, modelMode, effortLevel, agentDefaultOverrides, effortMetadata } = args;
    const effectiveDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, agent);
    const codeDefaults = getCodeAgentDefaults(agent);
    // A stored value alone cannot distinguish old hydration from a user choice.
    // Explicit picks survive refresh until that field's configured default changes.
    const explicitModel = agent !== 'codex' || (args.modelSelection?.agent === agent
        && args.modelSelection.defaultValue === effectiveDefaults.modelMode);
    const explicitEffort = (agent !== 'codex' && (agent !== 'antigravity' || !args.effortSelection)) || (args.effortSelection?.agent === agent
        && args.effortSelection.defaultValue === effectiveDefaults.effortLevel);
    const draftModel = explicitModel ? modelMode : null;
    const draftEffort = explicitEffort ? effortLevel : null;
    const permissionOptions = getHardcodedPermissionModes(agent, identityTranslate);
    const modelOptions = args.modelOptions ?? getHardcodedModelModes(agent, identityTranslate);

    const resolvedPermissionMode = resolveSelectionKey({
        draftKey: permissionMode,
        fallbackKey: effectiveDefaults.permissionMode,
        codeDefaultKey: codeDefaults.permissionMode,
        followDraftKeys: ['default'],
        followCodeDefault: true,
        options: permissionOptions,
    });

    const resolvedModelMode = agent === 'antigravity' && draftModel && draftModel !== 'default' ? draftModel : agent === 'codex' && explicitModel && draftModel === 'default' ? 'default' : resolveSelectionKey({
        draftKey: draftModel,
        fallbackKey: agent === 'antigravity' && effectiveDefaults.modelMode === 'default' && hasOption(modelOptions,effortMetadata?.currentModelCode)
            ? effortMetadata.currentModelCode : effectiveDefaults.modelMode,
        codeDefaultKey: codeDefaults.modelMode,
        followDraftKeys: agent === 'claude' || (agent === 'codex' && explicitModel) ? [] : ['default'],
        options: modelOptions,
    });

    const antigravityEffort = explicitEffort ? effortLevel : effectiveDefaults.effortLevel;
    const effortOptions = getEffortLevelsForModel(agent, resolvedModelMode, effortMetadata);
    const explicitEffortReset = agent === 'codex' && explicitEffort && draftEffort === 'default'
        && effortOptions.some(option => option.key === 'default');
    const resolvedEffortLevel = explicitEffortReset ? 'default' : agent === 'antigravity'
        ? (!antigravityEffort || antigravityEffort === 'default' ? null : antigravityEffort)
        : resolveEffortKey({
        draftKey: draftEffort,
        fallbackKey: effectiveDefaults.effortLevel,
        codeDefaultKey: codeDefaults.effortLevel,
        options: effortOptions,
    });

    return {
        permissionMode: resolvedPermissionMode,
        modelMode: resolvedModelMode,
        effortLevel: resolvedEffortLevel,
    };
}
