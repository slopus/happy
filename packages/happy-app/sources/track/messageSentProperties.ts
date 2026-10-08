import type { Metadata } from '@/sync/storageTypes';
import type { MessageModeMeta } from '@/sync/messageMeta';
import { isRigMetadata } from '@/sync/rig';

/**
 * The part of `message_sent` every Happy client sends under the same names:
 * phone, web, and desktop. Keep in step with the desktop's copy in happy-desktop,
 * packages/happy-desktop-analytics/src/analyticsCatalog.ts.
 */
export type MessageSentSharedProperties = {
    /** The app the message was sent from. */
    client: MessageSentClient;
    /** What the message went to; null when the session does not say. */
    target: MessageSentTarget | null;
    /** A system bot's key, such as `chief_of_staff`; null for user bots, other sessions, and old metadata. */
    bot_system_key: string | null;
    /** 0 for a top-level or bot session, 1 for a subtask, and so on; null when the session does not say. */
    task_depth: number | null;
    /** Which program runs the session: Happy Agent or the Happy CLI. */
    session_client: 'happy_agent' | 'cli' | null;
    happy_agent_version: string | null;
    /**
     * The model sent with the message; null when the agent's own default applies.
     * Happy Agent model ids are vendor-qualified (`anthropic/opus-5`); the CLI's are
     * its own names (`claude-opus-5`, `gpt-5.6-sol`).
     */
    model: string | null;
    /**
     * The provider's configured type, e.g. claude, codex, grok, bedrock; never the
     * account id. Passed through as published; null when the session names none.
     */
    model_provider_kind: string | null;
    /**
     * Tells provider accounts apart without naming them: a 12-hex-char BLAKE2b of the
     * account id, keyed by `deriveKey(secret, 'Happy Coder', ['analytics', 'provider-account'])`.
     * Stable per user and account, unjoinable across users; null without a Happy Agent account.
     */
    provider_account_hash: string | null;
    /** The model's own effort level as sent: `off`, `low`, `medium`, `high`, `xhigh`, `max`... */
    effort: string | null;
    /** The computer's OS; null when neither the session nor its machine says. */
    agent_os: AgentOs | null;
};

export type MessageSentClient = 'ios' | 'android' | 'web' | 'desktop';
export type MessageSentTarget = 'chief_of_staff' | 'bot' | 'session';
export type AgentOs = 'mac' | 'win' | 'linux' | 'other';

/** The Tauri desktop app runs the web build, so it reports `web` unless told otherwise. */
export function messageSentClient(platformOs: string, inTauri: boolean): MessageSentClient {
    if (platformOs === 'ios' || platformOs === 'android') return platformOs;
    return inTauri ? 'desktop' : 'web';
}

/**
 * Session details for `message_sent`, read from what the phone already has:
 * the session metadata, its machine's platform, and the mode it sent with the
 * message. Nothing here is reported by Happy Agent itself.
 */
export function messageSentSessionProperties(
    client: MessageSentClient,
    metadata: Metadata | null | undefined,
    mode: MessageModeMeta | null | undefined,
    machinePlatform?: string | null,
    hashProviderAccount?: (providerId: string) => string,
): MessageSentSharedProperties {
    const isHappyAgent = isRigMetadata(metadata);
    const providerId = isHappyAgent ? nonEmpty(mode?.modelProviderId) ?? nonEmpty(metadata?.provider?.id) : null;
    const depth = metadata?.depth;
    return {
        client,
        target: messageSentTarget(metadata),
        bot_system_key: typeof metadata?.bot?.systemKey === 'string' ? metadata.bot.systemKey : null,
        task_depth: typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? depth : null,
        session_client: isHappyAgent ? 'happy_agent' : metadata ? 'cli' : null,
        happy_agent_version: isHappyAgent ? metadata?.client?.version ?? null : null,
        model: mode?.model ?? null,
        model_provider_kind: isHappyAgent ? resolveProviderKind(metadata, mode?.modelProviderId) : null,
        provider_account_hash: providerId && hashProviderAccount ? hashProviderAccount(providerId) : null,
        effort: mode?.effort ?? null,
        agent_os: agentOs(metadata?.os) ?? agentOs(machinePlatform),
    };
}

/**
 * A bot's conversation carries `metadata.bot`. Which bot is the Chief of Staff
 * is known only by its `systemKey`, which older Happy Agents leave off; their bot
 * conversations report null rather than a guess.
 */
function messageSentTarget(metadata: Metadata | null | undefined): MessageSentTarget | null {
    if (!metadata) return null;
    const bot = metadata.bot;
    if (!bot) return 'session';
    if (bot.systemKey === undefined) return null;
    return bot.systemKey === 'chief_of_staff' ? 'chief_of_staff' : 'bot';
}

/** Happy Agent writes the session OS as `darwin 25.6.0`, the CLI as bare `darwin`. */
function agentOs(value: string | null | undefined): AgentOs | null {
    const platform = value?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!platform) return null;
    if (platform === 'darwin') return 'mac';
    if (platform === 'win32') return 'win';
    if (platform === 'linux') return 'linux';
    return 'other';
}

/**
 * The kind exactly as Happy Agent published it. Reads the raw metadata rather than
 * `getRigModels`, which fills a missing kind with `custom` for display.
 */
function resolveProviderKind(metadata: Metadata | null | undefined, providerId: string | undefined): string | null {
    if (!providerId) return null;
    const model = metadata?.models?.find((model) => (model.provider?.id ?? model.providerId) === providerId);
    return nonEmpty(model?.provider?.kind)
        ?? nonEmpty(model?.providerKind)
        ?? nonEmpty(metadata?.providers?.find((provider) => provider.id === providerId)?.kind)
        ?? (metadata?.provider?.id === providerId ? nonEmpty(metadata.provider.kind) : null);
}

function nonEmpty(value: string | null | undefined): string | null {
    return value?.trim() ? value : null;
}
