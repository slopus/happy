import { describe, expect, it } from 'vitest';
import { ProviderUsageEventV1Schema } from '@slopus/happy-wire';
import { createClaudeTurnUsageEvent, createClaudeUsageEvent, createCodexUsageEvent } from './providerUsageAdapters';

describe('createClaudeUsageEvent', () => {
    it('uses the native message id so SDK and transcript copies are idempotent', () => {
        const base = {
            sessionId: 'happy-session-1',
            occurredAt: 1_788_000_000_000,
            messageId: 'msg_native_1',
            model: 'claude-sonnet-4-5',
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 40,
                cache_read_input_tokens: 300,
            },
        };

        const sdkEvent = createClaudeUsageEvent({ ...base, transcriptUuid: 'sdk-random-uuid' });
        const transcriptEvent = createClaudeUsageEvent({ ...base, transcriptUuid: 'transcript-uuid' });

        expect(sdkEvent).toEqual(transcriptEvent);
        expect(sdkEvent).toMatchObject({
            sourceEventId: 'happy-session-1:anthropic:msg_native_1',
            provider: 'anthropic',
            agent: 'claude',
            model: 'claude-sonnet-4-5',
            measurement: 'delta',
            tokens: {
                input: 100,
                output: 20,
                cacheRead: 300,
                cacheWrite: 40,
                reasoning: 0,
                total: 460,
            },
        });
    });

    it('falls back to the transcript uuid when the provider message id is absent', () => {
        const event = createClaudeUsageEvent({
            sessionId: 'happy-session-1',
            occurredAt: 1_788_000_000_000,
            transcriptUuid: 'transcript-uuid',
            model: null,
            usage: { input_tokens: 2, output_tokens: 3 },
        });

        expect(event.sourceEventId).toBe('happy-session-1:anthropic:transcript-uuid');
    });
});

describe('createClaudeTurnUsageEvent', () => {
    it('keys the turn fallback on the result uuid so it never collides with message events', () => {
        const event = createClaudeTurnUsageEvent({
            sessionId: 'happy-session-1',
            occurredAt: 1_788_000_000_000,
            resultUuid: 'result-uuid-1',
            model: 'glm-4.7',
            usage: { input_tokens: 962, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        });

        expect(event).toMatchObject({
            sourceEventId: 'happy-session-1:anthropic:turn:result-uuid-1',
            provider: 'anthropic',
            agent: 'claude',
            model: 'glm-4.7',
            measurement: 'delta',
            tokens: { input: 962, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 965 },
        });
    });
});

describe('createCodexUsageEvent', () => {
    it('turns cached and reasoning subsets into exclusive token buckets', () => {
        const event = createCodexUsageEvent({
            sessionId: 'happy-session-2',
            responseId: 'response-1',
            occurredAt: 1_788_000_000_100,
            model: 'gpt-5.5',
            usage: {
                totalTokens: 150,
                inputTokens: 120,
                cachedInputTokens: 70,
                cacheWriteInputTokens: 10,
                outputTokens: 30,
                reasoningOutputTokens: 5,
            },
        });

        expect(event).toMatchObject({
            sourceEventId: 'happy-session-2:openai:response-1',
            provider: 'openai',
            agent: 'codex',
            model: 'gpt-5.5',
            measurement: 'delta',
            tokens: {
                input: 40,
                cacheRead: 70,
                cacheWrite: 10,
                output: 25,
                reasoning: 5,
                total: 150,
            },
        });
    });

    it('rejects an invalid provider total instead of silently changing it', () => {
        expect(() => createCodexUsageEvent({
            sessionId: 'happy-session-2',
            responseId: 'response-2',
            occurredAt: 1_788_000_000_100,
            model: null,
            usage: {
                totalTokens: 999,
                inputTokens: 10,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 5,
                reasoningOutputTokens: 0,
            },
        })).toThrow();
    });
});

describe('applied AI auth source reporting', () => {
    const claudeInput = {
        sessionId: 'happy-session-1',
        occurredAt: 1_788_000_000_000,
        transcriptUuid: 'transcript-uuid',
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 2, output_tokens: 3 },
    };
    const codexInput = {
        sessionId: 'happy-session-1',
        responseId: 'resp-1',
        occurredAt: 1_788_000_000_000,
        model: 'gpt-5.4',
        usage: {
            totalTokens: 10,
            inputTokens: 6,
            cachedInputTokens: 1,
            cacheWriteInputTokens: 1,
            outputTokens: 4,
            reasoningOutputTokens: 1,
        },
    };

    it('carries the source the daemon decided, not one the adapter guessed', () => {
        const env = {
            HAPPY_AI_AUTH_SOURCE: 'org-bundle',
            HAPPY_AI_AUTH_CONNECTION_VERSION: '7',
            // An organisation bundle and a person's own key are the same
            // variable; only the injected value may decide between them.
            ANTHROPIC_API_KEY: 'sk-whatever',
        };

        expect(createClaudeUsageEvent({ ...claudeInput, env }).aiAuth)
            .toEqual({ appliedSource: 'org-bundle', connectionVersion: 7 });
        expect(createClaudeTurnUsageEvent({
            sessionId: claudeInput.sessionId,
            occurredAt: claudeInput.occurredAt,
            resultUuid: 'result-uuid-1',
            usage: claudeInput.usage,
            env,
        }).aiAuth).toEqual({ appliedSource: 'org-bundle', connectionVersion: 7 });
        expect(createCodexUsageEvent({ ...codexInput, env }).aiAuth)
            .toEqual({ appliedSource: 'org-bundle', connectionVersion: 7 });
    });

    it('reports the source without a connection version when only the source was injected', () => {
        expect(createClaudeUsageEvent({
            ...claudeInput,
            env: { HAPPY_AI_AUTH_SOURCE: 'platform-glm' },
        }).aiAuth).toEqual({ appliedSource: 'platform-glm', connectionVersion: null });
    });

    it('reports nothing rather than a guess when the daemon injected no source', () => {
        // NULL and an unknown token land in the same `unknown` ledger bucket,
        // so an omitted report says exactly as much as `unknown` would — and
        // keeps an old daemon's events byte-identical to what they were.
        expect(createClaudeUsageEvent({ ...claudeInput, env: {} }).aiAuth).toBeUndefined();
        expect(createCodexUsageEvent({ ...codexInput, env: {} }).aiAuth).toBeUndefined();
    });

    it('still produces a valid event when the environment carries no source', () => {
        expect(() => ProviderUsageEventV1Schema.parse(
            createClaudeUsageEvent({ ...claudeInput, env: {} }),
        )).not.toThrow();
    });

    it('ignores an unknown token instead of forwarding it', () => {
        expect(createClaudeUsageEvent({
            ...claudeInput,
            env: { HAPPY_AI_AUTH_SOURCE: 'personal-subscription-v2' },
        }).aiAuth).toBeUndefined();
    });

    describe('an observed org deployment login (src/claude/aiAuthObservation.ts)', () => {
        it('fills in a source the daemon wrote as unknown', () => {
            // The daemon writes `unknown` for every spawn it could not place,
            // which is exactly when the run's own observation is worth reporting.
            expect(createClaudeUsageEvent({
                ...claudeInput,
                env: { HAPPY_AI_AUTH_SOURCE: 'unknown', HAPPY_AI_AUTH_CONNECTION_VERSION: '' },
                observedAiAuthSource: 'org-bundle-observed',
            }).aiAuth).toEqual({ appliedSource: 'org-bundle-observed', connectionVersion: null });
            expect(createClaudeTurnUsageEvent({
                sessionId: claudeInput.sessionId,
                occurredAt: claudeInput.occurredAt,
                resultUuid: 'result-uuid-1',
                usage: claudeInput.usage,
                env: {},
                observedAiAuthSource: 'org-bundle-observed',
            }).aiAuth).toEqual({ appliedSource: 'org-bundle-observed', connectionVersion: null });
        });

        it('never overrides a source the daemon or a managed run established', () => {
            expect(createClaudeUsageEvent({
                ...claudeInput,
                env: { HAPPY_AI_AUTH_SOURCE: 'platform-glm' },
                observedAiAuthSource: 'org-bundle-observed',
            }).aiAuth).toEqual({ appliedSource: 'platform-glm', connectionVersion: null });
        });

        it('never pairs with a connection version it was not observed under', () => {
            expect(createClaudeUsageEvent({
                ...claudeInput,
                env: { HAPPY_AI_AUTH_SOURCE: 'unknown', HAPPY_AI_AUTH_CONNECTION_VERSION: '4' },
                observedAiAuthSource: 'org-bundle-observed',
            }).aiAuth).toEqual({ appliedSource: 'unknown', connectionVersion: 4 });
        });

        it('is not something the environment can claim', () => {
            // Only the in-process observation may produce it: a value in
            // HAPPY_AI_AUTH_SOURCE would also approve an explicit selection.
            expect(createClaudeUsageEvent({
                ...claudeInput,
                env: { HAPPY_AI_AUTH_SOURCE: 'org-bundle-observed' },
            }).aiAuth).toBeUndefined();
        });
    });
});
