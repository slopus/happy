import { describe, expect, it, vi } from 'vitest';
import { Session } from './session';
import { MessageQueue2 } from '@/utils/MessageQueue2';

describe('Session', () => {
    it('does not bump permissionModeUpdatedAt when permission mode does not change', () => {
        const metadataUpdates: any[] = [];
        const client = {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn((updater: (current: any) => any) => {
                metadataUpdates.push(updater({}));
            }),
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
            session.setLastPermissionMode('default', 111);
            session.setLastPermissionMode('default', 222);
            session.setLastPermissionMode('plan', 333);
            session.setLastPermissionMode('plan', 444);

            expect(metadataUpdates).toEqual([
                { permissionMode: 'plan', permissionModeUpdatedAt: 333 },
            ]);
        } finally {
            session.cleanup();
        }
    });

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

    it('clearSessionId clears transcriptPath as well', () => {
        const client = {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
        } as any;

        const session = new Session({
            api: {} as any,
            client,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            mcpServers: {},
            messageQueue: new MessageQueue2<any>(() => 'mode'),
            onModeChange: () => { },
            hookSettingsPath: '/tmp/hooks.json',
        });

        try {
            session.onSessionFound('sess_1', { transcript_path: '/tmp/sess_1.jsonl' } as any);
            expect(session.sessionId).toBe('sess_1');
            expect(session.transcriptPath).toBe('/tmp/sess_1.jsonl');

            session.clearSessionId();

            expect(session.sessionId).toBeNull();
            expect(session.transcriptPath).toBeNull();
        } finally {
            session.cleanup();
        }
    });

    it('consumeOneTimeFlags consumes short -c and -r flags', () => {
        const client = {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
        } as any;

        const session = new Session({
            api: {} as any,
            client,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            claudeArgs: ['-c', '-r', 'abc-123', '--foo', 'bar'],
            mcpServers: {},
            messageQueue: new MessageQueue2<any>(() => 'mode'),
            onModeChange: () => { },
            hookSettingsPath: '/tmp/hooks.json',
        });

        try {
            session.consumeOneTimeFlags();
            expect(session.claudeArgs).toEqual(['--foo', 'bar']);
        } finally {
            session.cleanup();
        }
    });

    it('emits ACP task lifecycle events when thinking toggles', () => {
        const client = {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
        } as any;

        const session = new Session({
            api: {} as any,
            client,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            mcpServers: {},
            messageQueue: new MessageQueue2<any>(() => 'mode'),
            onModeChange: () => { },
            hookSettingsPath: '/tmp/hooks.json',
        });

        try {
            session.onThinkingChange(true);
            expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
            const [provider1, payload1] = client.sendAgentMessage.mock.calls[0];
            expect(provider1).toBe('claude');
            expect(payload1?.type).toBe('task_started');
            expect(typeof payload1?.id).toBe('string');

            session.onThinkingChange(true);
            expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);

            session.onThinkingChange(false);
            expect(client.sendAgentMessage).toHaveBeenCalledTimes(2);
            const [provider2, payload2] = client.sendAgentMessage.mock.calls[1];
            expect(provider2).toBe('claude');
            expect(payload2).toEqual({ type: 'task_complete', id: payload1.id });
        } finally {
            session.cleanup();
        }
    });

    it('does not emit orphan ACP task_complete events', () => {
        const client = {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
        } as any;

        const session = new Session({
            api: {} as any,
            client,
            path: '/tmp',
            logPath: '/tmp/log',
            sessionId: null,
            mcpServers: {},
            messageQueue: new MessageQueue2<any>(() => 'mode'),
            onModeChange: () => { },
            hookSettingsPath: '/tmp/hooks.json',
        });

        try {
            session.onThinkingChange(false);
            expect(client.sendAgentMessage).not.toHaveBeenCalled();
        } finally {
            session.cleanup();
        }
    });
});
