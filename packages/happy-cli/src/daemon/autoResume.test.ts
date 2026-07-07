import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import type { PersistedSession } from '@/persistence';

import {
    selectAutoResumeCandidates,
    type SelectAutoResumeCandidatesOptions,
} from './autoResume';

const NOW = 1_800_000_000_000;

function makeMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/home/user/project',
        host: 'test-host',
        startedFromDaemon: true,
        hostPid: 4242,
        ...overrides,
    } as Metadata;
}

function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
    return {
        encryptionKey: 'a2V5',
        encryptionVariant: 'dataKey',
        seq: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: makeMetadata(),
        savedAt: NOW - 60_000,
        ...overrides,
    };
}

function makeOptions(overrides: Partial<SelectAutoResumeCandidatesOptions> = {}): SelectAutoResumeCandidatesOptions {
    return {
        isPidAlive: () => false,
        now: NOW,
        maxSessions: 10,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        ...overrides,
    };
}

describe('selectAutoResumeCandidates', () => {
    it('selects daemon-spawned sessions that never exited and whose process is gone', () => {
        const candidates = selectAutoResumeCandidates(
            { 'session-1': makeSession() },
            makeOptions(),
        );
        expect(candidates.map((c) => c.sessionId)).toEqual(['session-1']);
    });

    it('skips sessions that exited under daemon supervision', () => {
        const candidates = selectAutoResumeCandidates(
            { 'session-1': makeSession({ exitedAt: NOW - 30_000 }) },
            makeOptions(),
        );
        expect(candidates).toEqual([]);
    });

    it('skips sessions that were not spawned by the daemon', () => {
        const candidates = selectAutoResumeCandidates(
            { 'session-1': makeSession({ metadata: makeMetadata({ startedFromDaemon: false }) }) },
            makeOptions(),
        );
        expect(candidates).toEqual([]);
    });

    it('skips sessions whose process is still alive', () => {
        const candidates = selectAutoResumeCandidates(
            { 'session-1': makeSession() },
            makeOptions({ isPidAlive: (pid) => pid === 4242 }),
        );
        expect(candidates).toEqual([]);
    });

    it('skips sessions persisted longer ago than maxAgeMs', () => {
        const candidates = selectAutoResumeCandidates(
            { 'session-1': makeSession({ savedAt: NOW - 8 * 24 * 60 * 60 * 1000 }) },
            makeOptions(),
        );
        expect(candidates).toEqual([]);
    });

    it('skips sessions without metadata', () => {
        const candidates = selectAutoResumeCandidates(
            { 'session-1': makeSession({ metadata: undefined as unknown as Metadata }) },
            makeOptions(),
        );
        expect(candidates).toEqual([]);
    });

    it('orders by most recently persisted and applies the cap', () => {
        const sessions: Record<string, PersistedSession> = {
            'session-old': makeSession({ savedAt: NOW - 3_000 }),
            'session-new': makeSession({ savedAt: NOW - 1_000 }),
            'session-mid': makeSession({ savedAt: NOW - 2_000 }),
        };
        const candidates = selectAutoResumeCandidates(sessions, makeOptions({ maxSessions: 2 }));
        expect(candidates.map((c) => c.sessionId)).toEqual(['session-new', 'session-mid']);
    });

    it('sessions without hostPid are treated as not alive', () => {
        const candidates = selectAutoResumeCandidates(
            { 'session-1': makeSession({ metadata: makeMetadata({ hostPid: undefined }) }) },
            makeOptions({ isPidAlive: () => true }),
        );
        expect(candidates.map((c) => c.sessionId)).toEqual(['session-1']);
    });
});
