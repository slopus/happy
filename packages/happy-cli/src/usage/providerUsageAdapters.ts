import {
    ProviderUsageEventV1Schema,
    type AiAuthReportV1,
    type ProviderUsageEventV1,
} from '@slopus/happy-wire';
import { readAiAuthConnectionVersion, resolveAppliedAiAuthSource } from './aiAuthSource';
import type { ObservedAiAuthSource } from '@/claude/aiAuthObservation';

type ClaudeUsage = {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
};

type CodexUsage = {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
};

/**
 * The environment the run was launched with, as an argument.
 *
 * Defaults to `process.env` because the three call sites (apiSession, runCodex)
 * all report from inside the launched child and none of them has anything else
 * to pass; tests inject instead of mutating a global.
 */
type UsageEventEnvironment = Record<string, string | undefined>;

/**
 * What the daemon wrote down at spawn — never re-derived here.
 *
 * An organisation bundle and a person's own key arrive as the same
 * `ANTHROPIC_API_KEY`; only the layer that applied the credential can tell
 * them apart, so this reads its decision and adds no fingerprint of its own.
 *
 * Returns `undefined` when nothing was established. The ledger folds a NULL
 * column and an unrecognised token into the same `unknown` bucket, so an
 * omitted report says exactly as much as a written `unknown` would, while
 * keeping the event identical to what a daemon without this field produces.
 *
 * `observed` is the run's own observation (src/claude/aiAuthObservation.ts),
 * handed in by the caller rather than read from the environment. It only fills
 * a gap: anything the daemon or a managed run established wins.
 */
function aiAuthReport(
    env: UsageEventEnvironment,
    observed?: ObservedAiAuthSource,
): AiAuthReportV1 | undefined {
    const appliedSource = resolveAppliedAiAuthSource({ env });
    const connectionVersion = readAiAuthConnectionVersion(env);
    if (appliedSource === 'unknown' && connectionVersion === null) {
        return observed ? { appliedSource: observed, connectionVersion: null } : undefined;
    }
    return { appliedSource, connectionVersion };
}

function normalizedModel(model: string | null | undefined): string | null {
    const value = model?.trim();
    return value ? value : null;
}

export function createClaudeUsageEvent(input: {
    sessionId: string;
    occurredAt: number;
    messageId?: string | null;
    transcriptUuid: string;
    model?: string | null;
    usage: ClaudeUsage;
    env?: UsageEventEnvironment;
    observedAiAuthSource?: ObservedAiAuthSource;
}): ProviderUsageEventV1 {
    const providerEventId = input.messageId?.trim() || input.transcriptUuid.trim();
    const cacheRead = input.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = input.usage.cache_creation_input_tokens ?? 0;
    const total = input.usage.input_tokens + input.usage.output_tokens + cacheRead + cacheWrite;

    return ProviderUsageEventV1Schema.parse({
        source: 'happy-cli',
        sourceEventId: `${input.sessionId}:anthropic:${providerEventId}`,
        schemaVersion: 1,
        occurredAt: input.occurredAt,
        sessionId: input.sessionId,
        provider: 'anthropic',
        agent: 'claude',
        model: normalizedModel(input.model),
        measurement: 'delta',
        tokens: {
            input: input.usage.input_tokens,
            output: input.usage.output_tokens,
            cacheRead,
            cacheWrite,
            reasoning: 0,
            total,
        },
        cost: null,
        quality: 'exact',
        aiAuth: aiAuthReport(input.env ?? process.env, input.observedAiAuthSource),
    });
}

/**
 * 턴 종료 result 기준 보정 이벤트 (src/usage/claudeTurnUsage.ts 참조). id 는 result uuid 로
 * 만들어 assistant 메시지 이벤트와 절대 겹치지 않고, 같은 result 가 두 번 전달돼도 idempotent 하다.
 */
export function createClaudeTurnUsageEvent(input: {
    sessionId: string;
    occurredAt: number;
    resultUuid: string;
    model?: string | null;
    usage: ClaudeUsage;
    env?: UsageEventEnvironment;
    observedAiAuthSource?: ObservedAiAuthSource;
}): ProviderUsageEventV1 {
    return createClaudeUsageEvent({
        sessionId: input.sessionId,
        occurredAt: input.occurredAt,
        messageId: `turn:${input.resultUuid.trim()}`,
        transcriptUuid: input.resultUuid,
        model: input.model,
        usage: input.usage,
        env: input.env,
        observedAiAuthSource: input.observedAiAuthSource,
    });
}

export function createCodexUsageEvent(input: {
    sessionId: string;
    responseId: string;
    occurredAt: number;
    model?: string | null;
    usage: CodexUsage;
    env?: UsageEventEnvironment;
}): ProviderUsageEventV1 {
    const exclusiveInput = input.usage.inputTokens
        - input.usage.cachedInputTokens
        - input.usage.cacheWriteInputTokens;
    const exclusiveOutput = input.usage.outputTokens - input.usage.reasoningOutputTokens;

    return ProviderUsageEventV1Schema.parse({
        source: 'happy-cli',
        sourceEventId: `${input.sessionId}:openai:${input.responseId.trim()}`,
        schemaVersion: 1,
        occurredAt: input.occurredAt,
        sessionId: input.sessionId,
        provider: 'openai',
        agent: 'codex',
        model: normalizedModel(input.model),
        measurement: 'delta',
        tokens: {
            input: exclusiveInput,
            output: exclusiveOutput,
            cacheRead: input.usage.cachedInputTokens,
            cacheWrite: input.usage.cacheWriteInputTokens,
            reasoning: input.usage.reasoningOutputTokens,
            total: input.usage.totalTokens,
        },
        cost: null,
        quality: 'exact',
        aiAuth: aiAuthReport(input.env ?? process.env),
    });
}
