import type { Metadata } from './storageTypes';

export type ProviderIconKind = 'codex' | 'claude' | 'grok' | 'kimi' | 'generic';

export type RigModelDescriptor = {
    key: string;
    id: string;
    providerId: string;
    name: string;
    providerName: string;
    providerKind: string;
    contextWindow?: number;
    serviceTiers: string[];
    thinkingLevels: string[];
    defaultThinkingLevel: string | null;
    unavailable?: boolean;
};

export type RigActivityIndicator = {
    key: 'subagents' | 'workflows' | 'processes' | 'tasks';
    count: number;
    queued?: number;
};

export function isRigMetadata(metadata: Metadata | null | undefined): boolean {
    return metadata?.client?.id === 'rig';
}

export function isRigMetadataV1(metadata: Metadata | null | undefined): boolean {
    return isRigMetadata(metadata) && (metadata?.rigMetadataVersion ?? 0) >= 1;
}

export function usesControlledSessionUi(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadata(metadata);
}

export function getProviderIconKind(kind: string | null | undefined): ProviderIconKind {
    switch (kind?.trim().toLowerCase()) {
        case 'codex': return 'codex';
        case 'claude': return 'claude';
        case 'grok': return 'grok';
        case 'kimi': return 'kimi';
        default: return 'generic';
    }
}

export function qualifyRigModelKey(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`;
}

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function getRigModels(metadata: Metadata | null | undefined): RigModelDescriptor[] {
    if (!isRigMetadata(metadata)) return [];

    const result: RigModelDescriptor[] = [];
    for (const model of metadata?.models ?? []) {
        const providerId = nonEmpty(model.provider?.id)
            ?? nonEmpty(model.providerId)
            ?? null;
        const id = nonEmpty(model.id) ?? nonEmpty(model.code);
        if (!providerId || !id) continue;

        result.push({
            key: qualifyRigModelKey(providerId, id),
            id,
            providerId,
            name: nonEmpty(model.name) ?? nonEmpty(model.value) ?? id,
            providerName: nonEmpty(model.provider?.name)
                ?? nonEmpty(model.providerName)
                ?? providerId,
            providerKind: nonEmpty(model.provider?.kind)
                ?? nonEmpty(model.providerKind)
                ?? 'custom',
            contextWindow: model.contextWindow,
            serviceTiers: model.serviceTiers ?? [],
            thinkingLevels: model.thinkingLevels ?? [],
            defaultThinkingLevel: nonEmpty(model.defaultThinkingLevel),
        });
    }
    return result;
}

export function getRigSelectedModelPair(metadata: Metadata | null | undefined): { providerId: string; id: string } | null {
    if (!isRigMetadata(metadata)) return null;
    const providerId = nonEmpty(metadata?.currentModelProviderId)
        ?? nonEmpty(metadata?.model?.providerId);
    const id = nonEmpty(metadata?.currentModelCode)
        ?? nonEmpty(metadata?.model?.id);
    return providerId && id ? { providerId, id } : null;
}

export function getRigSelectedModelKey(metadata: Metadata | null | undefined): string | null {
    const pair = getRigSelectedModelPair(metadata);
    return pair ? qualifyRigModelKey(pair.providerId, pair.id) : null;
}

export function getRigCurrentModel(metadata: Metadata | null | undefined): RigModelDescriptor | null {
    const selected = getRigSelectedModelPair(metadata);
    if (!selected) return null;
    const key = qualifyRigModelKey(selected.providerId, selected.id);
    return getRigModels(metadata).find((model) => model.key === key) ?? {
        key,
        id: selected.id,
        providerId: selected.providerId,
        name: selected.id,
        providerName: metadata?.provider?.id === selected.providerId
            ? metadata.provider.name
            : metadata?.providers?.find((provider) => provider.id === selected.providerId)?.name ?? selected.providerId,
        providerKind: metadata?.provider?.id === selected.providerId
            ? metadata.provider.kind
            : metadata?.providers?.find((provider) => provider.id === selected.providerId)?.kind ?? 'custom',
        serviceTiers: [],
        thinkingLevels: [],
        defaultThinkingLevel: null,
        unavailable: true,
    };
}

export function getRigIdentity(metadata: Metadata | null | undefined): {
    clientName: string;
    clientVersion: string | null;
    providerName: string;
    providerKind: ProviderIconKind;
    modelName: string | null;
} | null {
    if (!isRigMetadata(metadata)) return null;
    const currentModel = getRigCurrentModel(metadata);
    return {
        clientName: nonEmpty(metadata?.client?.name) ?? 'Rig',
        clientVersion: nonEmpty(metadata?.client?.version),
        providerName: nonEmpty(metadata?.provider?.name)
            ?? currentModel?.providerName
            ?? nonEmpty(metadata?.flavor)
            ?? 'Provider',
        providerKind: getProviderIconKind(metadata?.provider?.kind ?? currentModel?.providerKind),
        modelName: currentModel?.name ?? nonEmpty(metadata?.currentModelCode),
    };
}

export function rigHasRpcMethod(metadata: Metadata | null | undefined, method: string): boolean {
    return !isRigMetadataV1(metadata) || metadata?.capabilities?.rpcMethods.includes(method) === true;
}

export function rigCanAbort(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata)
        || (metadata?.capabilities?.abort === true && rigHasRpcMethod(metadata, 'abort'));
}

export function rigCanUseAttachments(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata) || metadata?.capabilities?.attachments.enabled === true;
}

export function rigCanReadFiles(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata)
        || (metadata?.capabilities?.files.read === true && rigHasRpcMethod(metadata, 'readFile'));
}

export function rigCanBrowseFiles(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata)
        || (metadata?.capabilities?.files.browse === true && rigCanReadFiles(metadata));
}

export function rigCanWriteFiles(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata)
        || (metadata?.capabilities?.files.write === true && rigHasRpcMethod(metadata, 'writeFile'));
}

export function rigCanSearchFiles(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata)
        || (metadata?.capabilities?.files.search === true && rigHasRpcMethod(metadata, 'ripgrep'));
}

export function rigCanUseShell(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata)
        || (metadata?.capabilities?.shell === true && rigHasRpcMethod(metadata, 'bash'));
}

export function getRigActivityIndicators(metadata: Metadata | null | undefined): RigActivityIndicator[] {
    if (!isRigMetadata(metadata) || !metadata?.activity) return [];
    const indicators: RigActivityIndicator[] = [];
    const { activity } = metadata;
    if (activity.subagents.running > 0 || activity.subagents.queued > 0) {
        indicators.push({ key: 'subagents', count: activity.subagents.running, queued: activity.subagents.queued });
    }
    if (activity.workflows.running > 0) {
        indicators.push({ key: 'workflows', count: activity.workflows.running });
    }
    if (activity.processes.running > 0) {
        indicators.push({ key: 'processes', count: activity.processes.running });
    }
    const activeTasks = activity.tasks.pending + activity.tasks.inProgress;
    if (activeTasks > 0) {
        indicators.push({ key: 'tasks', count: activity.tasks.inProgress, queued: activity.tasks.pending });
    }
    return indicators;
}

export function getRigReasoningLevels(metadata: Metadata | null | undefined, modelKey: string | null | undefined): string[] {
    if (!isRigMetadata(metadata)) return [];
    const model = getRigModels(metadata).find((candidate) => candidate.key === modelKey);
    if (model?.thinkingLevels.length) return model.thinkingLevels;
    if (metadata?.reasoning?.levels.length) return metadata.reasoning.levels;
    return (metadata?.thoughtLevels ?? []).map((level) => level.code);
}

export function getRigReasoningSelection(metadata: Metadata | null | undefined, modelKey: string | null | undefined): string | null {
    if (!isRigMetadata(metadata)) return null;
    const levels = getRigReasoningLevels(metadata, modelKey);
    const explicit = metadata?.reasoning?.current ?? metadata?.currentThoughtLevelCode ?? null;
    if (explicit && levels.includes(explicit)) return explicit;
    const modelDefault = getRigModels(metadata).find((candidate) => candidate.key === modelKey)?.defaultThinkingLevel;
    return modelDefault && levels.includes(modelDefault) ? modelDefault : null;
}

export function isRigModelSelectionEnabled(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata)
        || (metadata?.session?.modelLocked !== true && metadata?.capabilities?.modelSelection !== false);
}

export function isRigReasoningSelectionEnabled(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata) || metadata?.capabilities?.reasoningSelection !== false;
}

export function isRigPermissionSelectionEnabled(metadata: Metadata | null | undefined): boolean {
    return !isRigMetadataV1(metadata) || metadata?.capabilities?.permissionModeSelection !== false;
}
