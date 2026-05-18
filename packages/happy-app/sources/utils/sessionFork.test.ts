import { describe, expect, it } from 'vitest';

import { getSessionForkSource } from './sessionFork';

describe('getSessionForkSource', () => {
    it('returns a Claude fork source when the session has a Claude session id', () => {
        expect(getSessionForkSource({
            id: 'happy-claude',
            metadata: {
                flavor: 'claude',
                machineId: 'machine-1',
                path: '/tmp/project',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
            },
        } as any)).toEqual({
            kind: 'claude',
            sessionId: 'happy-claude',
            machineId: 'machine-1',
            directory: '/tmp/project',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        });
    });

    it('returns a Codex fork source when the session has a Codex thread id', () => {
        expect(getSessionForkSource({
            id: 'happy-codex',
            metadata: {
                flavor: 'codex',
                machineId: 'machine-1',
                path: '/tmp/project',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
            },
        } as any)).toEqual({
            kind: 'codex',
            sessionId: 'happy-codex',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
        });
    });

    it('returns null when required fork metadata is missing', () => {
        expect(getSessionForkSource({
            id: 'missing',
            metadata: {
                flavor: 'codex',
                machineId: 'machine-1',
                path: '/tmp/project',
            },
        } as any)).toBeNull();
    });
});
