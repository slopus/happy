import type { Metadata } from '@/api/types';

import type { Model, ReasoningEffort } from './codexAppServerTypes';

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
    serviceTiers?: Array<{ id: string; name: string; description?: string | null }>;
};

export type CodexSessionConfigSnapshot = {
    models?: Model[] | null;
    currentModel: string;
    currentEffort?: ReasoningEffort | null;
};

function toModelOption(model: Model): MetadataOption {
    return {
        code: model.model,
        value: model.model,
        description: model.description || null,
        serviceTiers: model.serviceTiers ?? model.service_tiers ?? [],
    };
}

function toEffortOption(effort: { reasoningEffort: ReasoningEffort; description: string }): MetadataOption {
    return {
        code: effort.reasoningEffort,
        value: effort.reasoningEffort,
        description: effort.description || null,
    };
}

export function mergeCodexSessionConfigIntoMetadata(
    metadata: Metadata,
    snapshot: CodexSessionConfigSnapshot,
): Metadata {
    const next: Metadata = { ...metadata };
    const models = snapshot.models ?? null;
    const currentModel = snapshot.currentModel;
    const currentEffort = snapshot.currentEffort;

    let selectedModel: Model | null = null;

    if (models) {
        const visibleModels = models.filter((model) => !model.hidden);
        const currentModelEntry = models.find((model) => model.model === currentModel) ?? null;
        selectedModel = currentModelEntry;

        const modelOptions = visibleModels.map(toModelOption);
        if (currentModelEntry && !modelOptions.some((option) => option.code === currentModelEntry.model)) {
            modelOptions.unshift(toModelOption(currentModelEntry));
        }

        if (modelOptions.length > 0) {
            next.models = modelOptions;
        } else {
            delete next.models;
        }
    }

    next.currentModelCode = currentModel;

    if (selectedModel) {
        next.thoughtLevels = selectedModel.supportedReasoningEfforts.map(toEffortOption);
        next.currentThoughtLevelCode = currentEffort ?? selectedModel.defaultReasoningEffort;
        return next;
    }

    if (currentEffort) {
        next.thoughtLevels = [{ code: currentEffort, value: currentEffort, description: null }];
        next.currentThoughtLevelCode = currentEffort;
        return next;
    }

    delete next.thoughtLevels;
    delete next.currentThoughtLevelCode;
    return next;
}
