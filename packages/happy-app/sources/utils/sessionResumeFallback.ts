import type { Metadata } from '@/sync/storageTypes';

export type SessionResumeFallback = {
    directory: string;
    agent: 'claude' | 'codex';
    agentSessionId: string;
};

export function getSessionResumeFallback(
    metadata: Metadata | null | undefined,
): SessionResumeFallback | undefined {
    if (!metadata?.path) {
        return undefined;
    }

    const isCodex = (metadata.flavor === undefined || metadata.flavor === null)
        ? Boolean(metadata.codexThreadId)
        : metadata.flavor === 'codex'
        || metadata.flavor === 'openai'
        || metadata.flavor === 'gpt';
    if (isCodex && metadata.codexThreadId) {
        return {
            directory: metadata.path,
            agent: 'codex',
            agentSessionId: metadata.codexThreadId,
        };
    }
    if (metadata.claudeSessionId) {
        return {
            directory: metadata.path,
            agent: 'claude',
            agentSessionId: metadata.claudeSessionId,
        };
    }
    return undefined;
}
