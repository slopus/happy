/** Claude-owned model catalogs and lossless session selection metadata. */
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Metadata } from '@/api/types';

type CatalogModel = NonNullable<Metadata['models']>[number] & {
    id?: string;
    thinkingLevels?: string[];
};

/** Local and bundled CLIs can resolve the same family alias differently. */
function stableModelCode(model: ModelInfo): string {
    // Only concrete family aliases are interchangeable with their resolved ID.
    // Default, opusplan and opaque provider IDs can have additional semantics.
    if (!model.resolvedModel || !/^(opus|sonnet|haiku|fable)(\[1m\])?$/.test(model.value)) {
        return model.value;
    }
    const suffix = model.value.endsWith('[1m]') && !model.resolvedModel.endsWith('[1m]') ? '[1m]' : '';
    return model.resolvedModel + suffix;
}

export function applyClaudeModelCatalog(
    metadata: Metadata,
    catalog?: readonly ModelInfo[],
    currentModelCode = metadata.currentModelCode,
): Metadata {
    const selected = catalog?.find(model => model.value === currentModelCode);
    if (selected) currentModelCode = stableModelCode(selected);
    const models: CatalogModel[] = catalog
        ? Array.from(new Map(catalog.filter(model => model.value.trim()).map(model => {
            const code = stableModelCode(model);
            // Native menu rows may omit subtitles. Use the SDK's own concise
            // versioned name when supplied, rather than hiding it behind "Opus".
            const descriptionName = model.description.split(' · ')[0];
            const displayName = code !== model.value && model.description.includes(' · ')
                && descriptionName.startsWith(model.displayName) && descriptionName.length < 80
                ? descriptionName : model.displayName;
            return [code, {
                code,
                value: displayName,
                description: model.description,
                ...(model.resolvedModel ? { id: model.resolvedModel } : {}),
                ...(model.supportedEffortLevels ? { thinkingLevels: [...model.supportedEffortLevels] } : {}),
            }];
        })).values())
        : [...(metadata.models ?? [])];

    // Explicit IDs (including [1m]) and custom provider models remain selectable
    // even when a different runtime's catalog does not advertise them.
    if (currentModelCode && !models.some(model => model.code === currentModelCode)) {
        const matchingAlias = models.find(model => model.id === currentModelCode);
        models.push({
            code: currentModelCode,
            value: currentModelCode,
            description: matchingAlias?.description ?? null,
        });
    }
    return { ...metadata, models, ...(currentModelCode ? { currentModelCode } : {}) };
}

/** Retain a requested context suffix only when the observed model agrees. */
export function resolveClaudeModelCode(
    requestedModel: string | undefined,
    observedModel: string,
): string {
    if (requestedModel && requestedModel !== 'default') {
        if (requestedModel === observedModel || requestedModel.replace(/\[1m\]$/, '') === observedModel) {
            return requestedModel;
        }
    }
    return observedModel;
}
