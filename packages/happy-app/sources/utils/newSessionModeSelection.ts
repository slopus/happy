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
import type { NewSessionAgentType } from '@/sync/persistence';
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
    modelOptions?: ModeOption[];
    effortMetadata?: Metadata | null;
}): NewSessionModeSelection {
    const { agent, permissionMode, modelMode, effortLevel, agentDefaultOverrides, effortMetadata } = args;
    const effectiveDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, agent);
    const codeDefaults = getCodeAgentDefaults(agent);
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

    const resolvedModelMode = resolveSelectionKey({
        draftKey: modelMode,
        fallbackKey: effectiveDefaults.modelMode,
        codeDefaultKey: codeDefaults.modelMode,
        followDraftKeys: ['default'],
        options: modelOptions,
    });

    const effortOptions = getEffortLevelsForModel(agent, resolvedModelMode, effortMetadata);
    const resolvedEffortLevel = resolveEffortKey({
        draftKey: effortLevel,
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
