import type { Metadata } from '@/sync/storageTypes';

export function supportsCodexFast(metadata: Metadata | null | undefined, modelCode: string | null | undefined): boolean {
    const resolvedModelCode = modelCode === 'default' ? metadata?.currentModelCode : modelCode;
    return metadata?.flavor === 'codex' && Boolean(
        metadata.models?.find((model) => model.code === resolvedModelCode)
            ?.serviceTiers?.some((tier) => tier.id === 'priority'),
    );
}
