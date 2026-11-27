import { describe, expect, it, vi } from 'vitest';

import { Session } from './session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

function sessionWithReset(resetPortableContextBoundary: (localIds?: readonly string[]) => Promise<void>) {
    const client = {
        resetPortableContextBoundary: vi.fn(resetPortableContextBoundary),
        keepAlive: vi.fn(),
        updateAgentState: vi.fn(async () => {}),
    };
    const session = new Session({
        api: {} as any, client: client as any, path: process.cwd(), logPath: '/tmp/unused',
        sessionId: 'old-native-session', mcpServers: {},
        messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
        onModeChange: vi.fn(), hookSettingsPath: '/tmp/unused',
    });
    return { session, client };
}

describe('Claude portable context reset', () => {
    it('retains the current native identity until the durable boundary is saved', async () => {
        let acknowledge!: () => void;
        const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
        const { session, client } = sessionWithReset(() => acknowledgement);
        try {
            const reset = session.clearSessionId(['clear-command']);
            expect(client.resetPortableContextBoundary).toHaveBeenCalledWith(['clear-command']);
            expect(session.sessionId).toBe('old-native-session');
            acknowledge();
            await reset;
            expect(session.sessionId).toBeNull();
        } finally {
            session.cleanup();
        }
    });

    it('propagates a failed boundary write instead of exposing a fresh identity', async () => {
        const failure = new Error('boundary could not be saved');
        const { session } = sessionWithReset(async () => { throw failure; });
        try {
            await expect(session.clearSessionId()).rejects.toBe(failure);
            expect(session.sessionId).toBe('old-native-session');
        } finally {
            session.cleanup();
        }
    });
});
