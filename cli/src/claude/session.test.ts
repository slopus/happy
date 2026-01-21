import { describe, expect, it, vi } from 'vitest';
import { Session } from './session';
import { MessageQueue2 } from '@/utils/MessageQueue2';

describe('Session', () => {
    it('notifies sessionFound callbacks with transcriptPath when provided', () => {
        let metadata: any = {};

        const client = {
            keepAlive: vi.fn(),
            updateMetadata: (updater: (current: any) => any) => {
                metadata = updater(metadata);
            }
        } as any;

        const session = new Session({
            api: {} as any,
            client,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            mcpServers: {},
            messageQueue: new MessageQueue2<any>(() => 'mode'),
            onModeChange: () => {},
            hookSettingsPath: '/tmp/hooks.json',
        });

        try {
            const events: any[] = [];
            (session as any).addSessionFoundCallback((info: any) => events.push(info));

            (session as any).onSessionFound('sess_1', { transcript_path: '/tmp/sess_1.jsonl' });

            expect(metadata.claudeSessionId).toBe('sess_1');
            expect(events).toEqual([{ sessionId: 'sess_1', transcriptPath: '/tmp/sess_1.jsonl' }]);
        } finally {
            session.cleanup();
        }
    });

    it('does not carry over transcriptPath when sessionId changes and hook lacks transcriptPath', () => {
        let metadata: any = {};

        const client = {
            keepAlive: vi.fn(),
            updateMetadata: (updater: (current: any) => any) => {
                metadata = updater(metadata);
            }
        } as any;

        const session = new Session({
            api: {} as any,
            client,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            mcpServers: {},
            messageQueue: new MessageQueue2<any>(() => 'mode'),
            onModeChange: () => {},
            hookSettingsPath: '/tmp/hooks.json',
        });

        try {
            const events: any[] = [];
            (session as any).addSessionFoundCallback((info: any) => events.push(info));

            (session as any).onSessionFound('sess_1', { transcript_path: '/tmp/sess_1.jsonl' });
            (session as any).onSessionFound('sess_2');
            (session as any).onSessionFound('sess_2', { transcript_path: '/tmp/sess_2.jsonl' });

            expect(metadata.claudeSessionId).toBe('sess_2');
            expect(events).toEqual([
                { sessionId: 'sess_1', transcriptPath: '/tmp/sess_1.jsonl' },
                { sessionId: 'sess_2', transcriptPath: null },
                { sessionId: 'sess_2', transcriptPath: '/tmp/sess_2.jsonl' },
            ]);
        } finally {
            session.cleanup();
        }
    });
});
