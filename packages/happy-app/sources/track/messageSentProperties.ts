import type { Metadata } from '@/sync/storageTypes';
import type { MessageModeMeta } from '@/sync/messageMeta';
import { getRigModels, isRigMetadata } from '@/sync/rig';

export type MessageSentSessionProperties = {
    /** Which program runs the session: Happy Agent or the Happy CLI. */
    session_client: 'happy_agent' | 'cli' | null;
    happy_agent_version: string | null;
    /** The model sent with the message; null when the agent's own default applies. */
    model: string | null;
    /** Provider kind (codex, claude, grok, custom...), never the provider's own name. */
    model_provider_kind: string | null;
    effort: string | null;
};

/**
 * Session details for `message_sent`, read from what the phone already has:
 * the session metadata and the mode it sent with the message. Nothing here is
 * reported by Happy Agent itself.
 */
export function messageSentSessionProperties(
    metadata: Metadata | null | undefined,
    mode: MessageModeMeta | null | undefined,
): MessageSentSessionProperties {
    const isHappyAgent = isRigMetadata(metadata);
    return {
        session_client: isHappyAgent ? 'happy_agent' : metadata ? 'cli' : null,
        happy_agent_version: isHappyAgent ? metadata?.client?.version ?? null : null,
        model: mode?.model ?? null,
        model_provider_kind: isHappyAgent ? resolveProviderKind(metadata, mode?.modelProviderId) : null,
        effort: mode?.effort ?? null,
    };
}

function resolveProviderKind(metadata: Metadata | null | undefined, providerId: string | undefined): string | null {
    if (!providerId) return null;
    return getRigModels(metadata).find((model) => model.providerId === providerId)?.providerKind
        ?? metadata?.providers?.find((provider) => provider.id === providerId)?.kind
        ?? (metadata?.provider?.id === providerId ? metadata.provider.kind : null)
        ?? 'custom';
}
