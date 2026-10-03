import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import {
    buildReconnectSessionEnvironment,
    consumeReconnectSessionEnvironment,
    decodeReconnectSessionSnapshot,
    encodeReconnectSessionSnapshot,
    hasReliableResumeBaseline,
    readReconnectSessionEnvironment,
    resolveResumeBaselineSeq,
} from './reconnectSessionEnv';

function makeMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/workspace/project/.aplus/worktrees/bright-gecko-bldm',
        host: 'aiden-desktop',
        homeDir: '/home/aiden',
        happyHomeDir: '/home/aiden/.happy_remote',
        happyLibDir: '/opt/happy',
        happyToolsDir: '/opt/happy/tools',
        flavor: 'codex',
        codexThreadId: 'thread-1',
        summary: {
            text: '로그가 보이지 않는 원인 분석',
            updatedAt: 1_753_000_000_000,
        },
        promptSuggestion: {
            text: '수정 계획을 세워줘',
            provider: 'codex',
            updatedAt: 1_753_000_000_001,
        },
        ...overrides,
    };
}

describe('reconnect session environment snapshot', () => {
    it('round-trips the latest metadata and versions without dropping unknown fields', () => {
        const metadata = {
            ...makeMetadata(),
            futureProviderState: {
                mode: 'new-contract',
                nested: { preserved: true },
            },
        } as Metadata;

        const encoded = encodeReconnectSessionSnapshot({
            metadata,
            seq: 102,
            metadataVersion: 4,
            agentStateVersion: 7,
        });

        expect(decodeReconnectSessionSnapshot(encoded)).toEqual({
            metadata,
            seq: 102,
            metadataVersion: 4,
            agentStateVersion: 7,
        });
    });

    it('rejects malformed reconnect snapshots before a child can update metadata', () => {
        const malformed = Buffer.from(JSON.stringify({ metadata: null, seq: -1 })).toString('base64');

        expect(() => decodeReconnectSessionSnapshot(malformed)).toThrow(/invalid reconnect session snapshot/i);
    });

    it('rejects a snapshot that would make the child environment unsafe to spawn', () => {
        const metadata = makeMetadata({
            summary: {
                text: 'x'.repeat(140 * 1024),
                updatedAt: 1,
            },
        });

        expect(() => encodeReconnectSessionSnapshot({
            metadata,
            seq: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
        })).toThrow(/too large/i);
    });

    it('builds one consistent child snapshot from the freshest server versions', () => {
        const env = buildReconnectSessionEnvironment({
            sessionId: 'happy-session-1',
            encryption: {
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
                seq: 100,
                metadataVersion: 3,
                agentStateVersion: 8,
            },
            serverSnapshot: {
                metadata: makeMetadata(),
                seq: 102,
                metadataVersion: 4,
                agentStateVersion: 7,
            },
        });

        expect(env.HAPPY_RECONNECT_SESSION_ID).toBe('happy-session-1');
        expect(env.HAPPY_RECONNECT_ENCRYPTION_VARIANT).toBe('legacy');
        expect(decodeReconnectSessionSnapshot(env.HAPPY_RECONNECT_SNAPSHOT)).toEqual({
            metadata: makeMetadata(),
            seq: 102,
            metadataVersion: 4,
            agentStateVersion: 8,
        });
    });

    it('prefers an explicit baselineSeq over the server head so unprocessed messages replay', () => {
        const env = buildReconnectSessionEnvironment({
            sessionId: 'happy-session-1',
            encryption: {
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
                seq: 600,
                metadataVersion: 3,
                agentStateVersion: 8,
            },
            serverSnapshot: {
                metadata: makeMetadata(),
                seq: 678,
                metadataVersion: 4,
                agentStateVersion: 7,
            },
            baselineSeq: 621,
        });

        expect(decodeReconnectSessionSnapshot(env.HAPPY_RECONNECT_SNAPSHOT).seq).toBe(621);
    });

    it('fails closed when the daemon cannot fetch the latest server snapshot', () => {
        expect(() => buildReconnectSessionEnvironment({
            sessionId: 'happy-session-1',
            encryption: {
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
                seq: 100,
                metadataVersion: 3,
                agentStateVersion: 8,
            },
            serverSnapshot: null,
        })).toThrow(/cannot safely resume/i);
    });

    it('restores the server metadata as the reconnect client starting document', () => {
        const metadata = makeMetadata();
        const snapshot = encodeReconnectSessionSnapshot({
            metadata,
            seq: 102,
            metadataVersion: 4,
            agentStateVersion: 7,
        });

        expect(readReconnectSessionEnvironment({
            HAPPY_RECONNECT_SESSION_ID: 'happy-session-1',
            HAPPY_RECONNECT_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32)).toString('base64'),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy',
            HAPPY_RECONNECT_SNAPSHOT: snapshot,
        })).toEqual({
            id: 'happy-session-1',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata,
            seq: 102,
            metadataVersion: 4,
            agentStateVersion: 7,
        });
    });

    it('rejects a partial reconnect environment instead of rebuilding stale metadata', () => {
        expect(() => readReconnectSessionEnvironment({
            HAPPY_RECONNECT_SESSION_ID: 'happy-session-1',
            HAPPY_RECONNECT_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32)).toString('base64'),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy',
        })).toThrow(/incomplete reconnect environment/i);
    });
});

// 2026-08-05 incident: resuming with the server-head seq as the skip baseline
// silently discarded messages that arrived while the session had no process
// (user input included), so the resumed child sat idle until the empty-reaper
// killed it. The baseline must be the last seq the previous child actually
// delivered to the agent loop, falling back to the old head-based behavior
// only when no such report exists (older CLI / lost record).
describe('resolveResumeBaselineSeq', () => {
    it('uses the reported processed seq so dead-period messages are delivered on resume', () => {
        expect(resolveResumeBaselineSeq({
            reportedSeq: 621,
            webhookSeq: 600,
            serverSeq: 678,
        })).toBe(621);
    });

    // A daemon restart loses the live runtime report but keeps the persisted
    // one; the resume must still baseline at the delivered seq.
    it('falls back to the persisted seq when the live runtime report is gone', () => {
        expect(resolveResumeBaselineSeq({
            persistedSeq: 621,
            webhookSeq: 600,
            serverSeq: 678,
        })).toBe(621);
    });

    it('prefers the live runtime report over the persisted one', () => {
        expect(resolveResumeBaselineSeq({
            reportedSeq: 640,
            persistedSeq: 621,
            webhookSeq: 600,
            serverSeq: 678,
        })).toBe(640);
    });

    // The tracked webhook seq is NOT an "already processed" marker: a previous
    // resume attempt rewrites it to the server head via applyServerSessionSnapshot.
    // Treating it as a floor would re-swallow exactly the messages this baseline
    // exists to deliver, so a real report always wins outright.
    it('trusts the reported seq over a webhook seq poisoned by an earlier resume', () => {
        expect(resolveResumeBaselineSeq({
            reportedSeq: 621,
            webhookSeq: 678,
            serverSeq: 678,
        })).toBe(621);
    });

    it('falls back to the server head when no processed seq was ever reported', () => {
        expect(resolveResumeBaselineSeq({
            webhookSeq: 600,
            serverSeq: 678,
        })).toBe(678);
    });

    it('falls back to the webhook seq when the server snapshot has no seq', () => {
        expect(resolveResumeBaselineSeq({
            webhookSeq: 600,
        })).toBe(600);
    });
});

describe('hasReliableResumeBaseline', () => {
    it('requires a runtime or persisted processed seq for every same-session reconnect', () => {
        expect(hasReliableResumeBaseline({
            reportedSeq: undefined,
            persistedSeq: undefined,
        })).toBe(false);
        expect(hasReliableResumeBaseline({
            reportedSeq: 0,
            persistedSeq: undefined,
        })).toBe(true);
        expect(hasReliableResumeBaseline({
            reportedSeq: undefined,
            persistedSeq: 621,
        })).toBe(true);
    });
});

// aplus-dev-studio specs/e2ee-machine-control-boundary R10 — the reconnect key is
// the session's data key. Left in process.env, every tool the agent starts
// inherits it, and anything that prints its environment hands it to the LLM.
describe('consumeReconnectSessionEnvironment', () => {
    const snapshot = () => encodeReconnectSessionSnapshot({
        metadata: makeMetadata(),
        seq: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
    });

    it('returns the reconnect session and removes the data key from the environment', () => {
        const env: NodeJS.ProcessEnv = {
            HAPPY_RECONNECT_SESSION_ID: 'happy-session-1',
            HAPPY_RECONNECT_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(5)).toString('base64'),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
            HAPPY_RECONNECT_SNAPSHOT: snapshot(),
        };

        const session = consumeReconnectSessionEnvironment(env);

        expect(session?.encryptionKey).toEqual(new Uint8Array(32).fill(5));
        expect(env.HAPPY_RECONNECT_ENCRYPTION_KEY).toBeUndefined();
        expect(env.HAPPY_RECONNECT_SESSION_ID).toBe('happy-session-1');
    });

    it('removes the data key even when the reconnect environment is refused', () => {
        const env: NodeJS.ProcessEnv = {
            HAPPY_RECONNECT_SESSION_ID: 'happy-session-1',
            HAPPY_RECONNECT_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32)).toString('base64'),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy',
        };

        expect(() => consumeReconnectSessionEnvironment(env)).toThrow(/incomplete reconnect environment/i);
        expect(env.HAPPY_RECONNECT_ENCRYPTION_KEY).toBeUndefined();
    });

    it('leaves an environment without reconnect values untouched', () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
        expect(consumeReconnectSessionEnvironment(env)).toBeNull();
        expect(env).toEqual({ PATH: '/usr/bin' });
    });
});
