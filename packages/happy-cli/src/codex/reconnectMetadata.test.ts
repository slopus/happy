import { describe, expect, it, vi } from 'vitest';

import { mergeReconnectMetadata } from './reconnectMetadata';

describe('mergeReconnectMetadata', () => {
    it('hydrates the persisted Codex cursor before replay while retaining process-local identity', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1234);
        const result = mergeReconnectMetadata({
            path: '/project',
            host: 'mac-mini',
            homeDir: '/Users/test',
            happyHomeDir: '/Users/test/.happy',
            happyLibDir: '/happy',
            happyToolsDir: '/happy/tools',
            hostPid: 99,
            startedFromDaemon: true,
            startedBy: 'daemon',
        }, JSON.stringify({
            path: '/project',
            host: 'mac-mini',
            homeDir: '/Users/test',
            happyHomeDir: '/Users/test/.happy',
            happyLibDir: '/happy',
            happyToolsDir: '/happy/tools',
            hostPid: 12,
            lifecycleState: 'archived',
            codexThreadId: 'thread-1',
            codexSyncCursor: { threadId: 'thread-1', turnId: 'turn-7' },
        }));

        expect(result).toMatchObject({
            hostPid: 99,
            lifecycleState: 'running',
            lifecycleStateSince: 1234,
            codexThreadId: 'thread-1',
            codexSyncCursor: { threadId: 'thread-1', turnId: 'turn-7' },
        });
    });

    it('uses local metadata when the daemon payload is malformed', () => {
        const local = {
            path: '/project',
            host: 'mac-mini',
            homeDir: '/Users/test',
            happyHomeDir: '/Users/test/.happy',
            happyLibDir: '/happy',
            happyToolsDir: '/happy/tools',
        };
        expect(mergeReconnectMetadata(local, '{bad json')).toBe(local);
    });
});
